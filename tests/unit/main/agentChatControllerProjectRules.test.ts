import { describe, expect, it, vi } from 'vitest';
import {
  type AgentChatControllerDeps,
  type ProjectRulesContext,
  createAgentChatController,
} from '../../../src/main/agentChatController';
import { createFakeAgentService } from '../../../src/main/agents/fakeAgentService';
import type { Logger } from '../../../src/main/logger';
import {
  type AgentService,
  type AgentServiceError,
  type ChatId,
  type Result,
  type SendPromptRequest,
  type ServerId,
  ok,
} from '../../../src/shared';

/**
 * Project rules ride on the model's prompt, not the session instructions: a
 * chat can change project mid-conversation, and instructions are fixed when the
 * agent runtime starts. These cases drive the controller with a service that
 * only records the prompts it is handed (the real fake refuses a second prompt
 * until the first turn ends, which is not what is under test here).
 */

const ENDED_NOTE = 'ENDED-NOTE';

const noopLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
});

function counterIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(n++)}`;
}

interface Harness {
  readonly controller: ReturnType<typeof createAgentChatController>;
  readonly prompts: string[];
  setRules(rules: ProjectRulesContext | undefined): void;
  failNextSend(): void;
}

function build(overrides: Partial<AgentChatControllerDeps> = {}): Harness {
  const fake = createFakeAgentService({ idGenerator: counterIds('fake') });
  const prompts: string[] = [];
  let failNext = false;
  const service: AgentService = {
    ...fake,
    sendPrompt(request: SendPromptRequest): Promise<Result<void, AgentServiceError>> {
      if (failNext) {
        failNext = false;
        return Promise.resolve({
          ok: false,
          error: { code: 'AGENT_UNAVAILABLE', message: 'unavailable' },
        });
      }
      prompts.push(request.prompt);
      return Promise.resolve(ok(undefined));
    },
  };
  let rules: ProjectRulesContext | undefined;
  const controller = createAgentChatController({
    agentService: service,
    logger: noopLogger(),
    idGenerator: counterIds('turn'),
    currentHostContext: () => ({
      origin: 'https://author.example.com',
      serverId: 'server-a' as ServerId,
      serverRevision: 1,
    }),
    navigationEpoch: () => 0,
    currentPageContext: () => undefined,
    currentProjectRules: () => rules,
    projectRulesEndedNote: ENDED_NOTE,
    ...overrides,
  });
  return {
    controller,
    prompts,
    setRules: (next) => {
      rules = next;
    },
    failNextSend: () => {
      failNext = true;
    },
  };
}

const chatId = 'chat-1' as ChatId;
const alpha: ProjectRulesContext = { key: 'alpha', block: 'ALPHA-RULES' };
const beta: ProjectRulesContext = { key: 'beta', block: 'BETA-RULES' };

async function send(harness: Harness, prompt: string): Promise<void> {
  const sent = await harness.controller.sendMessage({ chatId, prompt });
  if (!sent.ok) throw new Error('send was refused');
}

describe('project rules on the model prompt', () => {
  it('prepend the rules to the first prompt and not again while the project is unchanged', async () => {
    const harness = build();
    harness.setRules(alpha);
    await harness.controller.openConversation({ chatId });

    await send(harness, 'one');
    await send(harness, 'two');

    expect(harness.prompts[0]).toContain('ALPHA-RULES');
    expect(harness.prompts[0]).toContain('one');
    expect(harness.prompts[1]).toBe('two');
  });

  it('send the new project’s rules when the project changes', async () => {
    const harness = build();
    harness.setRules(alpha);
    await harness.controller.openConversation({ chatId });
    await send(harness, 'one');

    harness.setRules(beta);
    await send(harness, 'two');

    expect(harness.prompts[1]).toContain('BETA-RULES');
    expect(harness.prompts[1]).not.toContain('ALPHA-RULES');
  });

  it('send the ended note once when moving to a project without rules', async () => {
    const harness = build();
    harness.setRules(alpha);
    await harness.controller.openConversation({ chatId });
    await send(harness, 'one');

    harness.setRules(undefined);
    await send(harness, 'two');
    await send(harness, 'three');

    expect(harness.prompts[1]).toContain(ENDED_NOTE);
    expect(harness.prompts[2]).toBe('three');
  });

  it('send nothing while no project has rules', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });

    await send(harness, 'one');
    await send(harness, 'two');

    expect(harness.prompts).toEqual(['one', 'two']);
  });

  it('are sent again after the conversation is reopened', async () => {
    const harness = build();
    harness.setRules(alpha);
    await harness.controller.openConversation({ chatId });
    await send(harness, 'one');

    await harness.controller.openConversation({ chatId });
    await send(harness, 'two');

    expect(harness.prompts[1]).toContain('ALPHA-RULES');
  });

  it('are not counted as sent when the send fails', async () => {
    const harness = build();
    harness.setRules(alpha);
    await harness.controller.openConversation({ chatId });

    harness.failNextSend();
    const failed = await harness.controller.sendMessage({ chatId, prompt: 'one' });
    expect(failed.ok).toBe(false);
    await send(harness, 'two');

    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain('ALPHA-RULES');
  });

  it('come before the current-page context', async () => {
    const harness = build({ currentPageContext: () => 'PAGE-CONTEXT' });
    harness.setRules(alpha);
    await harness.controller.openConversation({ chatId });

    await send(harness, 'one');

    const prompt = harness.prompts[0] ?? '';
    expect(prompt.indexOf('ALPHA-RULES')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('ALPHA-RULES')).toBeLessThan(prompt.indexOf('PAGE-CONTEXT'));
    expect(prompt.indexOf('PAGE-CONTEXT')).toBeLessThan(prompt.indexOf('one'));
  });
});

describe('memos on the model prompt', () => {
  function withMemos(block: () => string | undefined): Harness {
    return build({ currentMemos: () => Promise.resolve(block()) });
  }

  it('prepend the memo block to the first prompt only', async () => {
    const harness = withMemos(() => 'MEMO-BLOCK');
    await harness.controller.openConversation({ chatId });

    await send(harness, 'one');
    await send(harness, 'two');

    expect(harness.prompts[0]).toContain('MEMO-BLOCK');
    expect(harness.prompts[0]).toContain('one');
    expect(harness.prompts[1]).toBe('two');
  });

  it('are sent again after the conversation is reopened', async () => {
    const harness = withMemos(() => 'MEMO-BLOCK');
    await harness.controller.openConversation({ chatId });
    await send(harness, 'one');

    await harness.controller.openConversation({ chatId });
    await send(harness, 'two');

    expect(harness.prompts[1]).toContain('MEMO-BLOCK');
  });

  it('send nothing while self-learning is off, and the block once it is switched on', async () => {
    const memos: { block?: string } = {};
    const harness = withMemos(() => memos.block);
    await harness.controller.openConversation({ chatId });

    await send(harness, 'one');
    memos.block = 'MEMO-BLOCK';
    await send(harness, 'two');

    expect(harness.prompts[0]).toBe('one');
    expect(harness.prompts[1]).toContain('MEMO-BLOCK');
  });

  it('are not counted as sent when the send fails', async () => {
    const harness = withMemos(() => 'MEMO-BLOCK');
    await harness.controller.openConversation({ chatId });

    harness.failNextSend();
    expect((await harness.controller.sendMessage({ chatId, prompt: 'one' })).ok).toBe(false);
    await send(harness, 'two');

    expect(harness.prompts[0]).toContain('MEMO-BLOCK');
  });

  it('come before the project rules and the current-page context', async () => {
    const harness = build({
      currentMemos: () => Promise.resolve('MEMO-BLOCK'),
      currentPageContext: () => 'PAGE-CONTEXT',
    });
    harness.setRules(alpha);
    await harness.controller.openConversation({ chatId });

    await send(harness, 'one');

    const prompt = harness.prompts[0] ?? '';
    expect(prompt.indexOf('MEMO-BLOCK')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('MEMO-BLOCK')).toBeLessThan(prompt.indexOf('ALPHA-RULES'));
    expect(prompt.indexOf('ALPHA-RULES')).toBeLessThan(prompt.indexOf('PAGE-CONTEXT'));
  });

  it('accept an asynchronous skill-prompt resolution', async () => {
    const harness = build({
      resolveSkillPrompt: () => Promise.resolve({ modelPrompt: 'SKILL-FRAMED' }),
    });
    await harness.controller.openConversation({ chatId });

    await send(harness, '/search x');

    expect(harness.prompts[0]).toBe('SKILL-FRAMED');
  });
});
