import { describe, expect, it, vi } from 'vitest';
import {
  type JsonValue,
  type MemoHost,
  type MemoWriteRequest,
  type ToolHost,
  MEMO_TITLE_MAX_LENGTH,
  MEMO_TOOL_NAME,
  err,
  ok,
} from '../../../src/shared';
import { tool as memoTool } from '../../../src/tools/memo/tool';
import { NO_SKILLS } from '../../support/fakeSkillHost';
import { createCountingIdGenerator } from '../../support/testIds';

const ids = createCountingIdGenerator('memo');
const callContext = { toolCallId: 'call-1' as never, signal: undefined };

// Local: unlike the AEM tool hosts, this one must carry a `memos` capability
// (or deliberately omit it), and nothing else is ever reached.
function makeHost(memos: MemoHost | undefined): ToolHost {
  return {
    bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
    currentContext: () => {
      throw new Error('memo must never ask for an AEM context');
    },
    environmentFacts: () => undefined,
    configuredHosts: () => [],
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
    clock: () => 1,
    idGenerator: ids,
    invokeTool: () => Promise.reject(new Error('not used')),
    skills: NO_SKILLS,
    ...(memos === undefined ? {} : { memos }),
  };
}

function recordingMemos(): MemoHost & { readonly writes: MemoWriteRequest[] } {
  const writes: MemoWriteRequest[] = [];
  return {
    writes,
    enabled: () => true,
    skillMemos: () => Promise.resolve(''),
    write: (request) => {
      writes.push(request);
      return Promise.resolve(
        ok({
          id: request.skill === undefined ? 'generic/x.md' : `skills/${request.skill}/x.md`,
          title: request.title,
          fileName: 'x.md',
          ...(request.skill === undefined ? {} : { skill: request.skill }),
        }),
      );
    },
  };
}

const VALID_ARGS = { title: 'Both paths', text: 'Show both paths.', trigger: 'correction' };

async function run(
  host: ToolHost,
  args: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
) {
  return memoTool.createExecutor(host)(args, { ...callContext, signal });
}

function failureCode(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok || result.error === undefined) throw new Error('expected a failure');
  return result.error.code;
}

describe('memo manifest', () => {
  it('is internally consistent and its schema is a JSON object schema', () => {
    expect(memoTool.name).toBe(MEMO_TOOL_NAME);
    if (!('descriptor' in memoTool)) throw new Error('expected a model-facing tool');
    expect(memoTool.descriptor.name).toBe(MEMO_TOOL_NAME);
    expect(memoTool.allowlistEntry).toBe(`custom:${MEMO_TOOL_NAME}`);
    const parameters = memoTool.descriptor.parameters as { type?: unknown; required?: unknown };
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(expect.arrayContaining(['title', 'text', 'trigger']));
    expect(memoTool.instructions.length).toBeGreaterThan(0);
  });
});

describe('memo executor', () => {
  it('writes a generic memo through the host and reports its id', async () => {
    const memos = recordingMemos();
    const result = await run(makeHost(memos), VALID_ARGS);
    expect(memos.writes).toEqual([VALID_ARGS]);
    if (!result.ok) throw new Error('expected a success');
    expect(result.value).toMatchObject({
      operation: MEMO_TOOL_NAME,
      id: 'generic/x.md',
      title: 'Both paths',
      trigger: 'correction',
      resultType: 'success',
    });
    expect(result.value).not.toHaveProperty('skill');
  });

  it('passes the skill through for a per-skill memo', async () => {
    const memos = recordingMemos();
    const result = await run(makeHost(memos), { ...VALID_ARGS, skill: 'search' });
    expect(memos.writes[0]?.skill).toBe('search');
    if (!result.ok) throw new Error('expected a success');
    expect(result.value).toMatchObject({ id: 'skills/search/x.md', skill: 'search' });
  });

  it.each([
    ['a missing title', { text: 'x', trigger: 'request' }],
    ['an over-long title', { ...VALID_ARGS, title: 'x'.repeat(MEMO_TITLE_MAX_LENGTH + 1) }],
    ['an unknown trigger', { ...VALID_ARGS, trigger: 'whim' }],
    ['a path-like skill', { ...VALID_ARGS, skill: '../evil' }],
    ['an unknown key', { ...VALID_ARGS, path: 'C:\\x.md' }],
  ])('rejects %s without writing', async (_label, args) => {
    const memos = recordingMemos();
    expect(failureCode(await run(makeHost(memos), args))).toBe('INVALID_ARGUMENT');
    expect(memos.writes).toEqual([]);
  });

  it('refuses when the host offers no memo capability', async () => {
    expect(failureCode(await run(makeHost(undefined), VALID_ARGS))).toBe('ACCESS_DENIED');
  });

  it('reports a cancelled call without writing', async () => {
    const memos = recordingMemos();
    const controller = new AbortController();
    controller.abort();
    expect(failureCode(await run(makeHost(memos), VALID_ARGS, controller.signal))).toBe(
      'CANCELLED',
    );
    expect(memos.writes).toEqual([]);
  });

  it("reports the store's failure code", async () => {
    const write = vi.fn(() =>
      Promise.resolve(err({ code: 'ACCESS_DENIED' as const, message: 'switched off' })),
    );
    const result = await run(
      makeHost({ enabled: () => false, skillMemos: () => Promise.resolve(''), write }),
      VALID_ARGS,
    );
    expect(failureCode(result)).toBe('ACCESS_DENIED');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
