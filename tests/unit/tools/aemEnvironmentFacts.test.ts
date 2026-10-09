import { describe, expect, it } from 'vitest';
import {
  aemEnvironmentFactsRequestSchema,
  createAemEnvironmentFactsExecutor,
  executeAemEnvironmentFacts,
  type AemEnvironmentFactsRequest,
} from '../../../src/tools/aem-environment-facts/environmentFacts';
import { renderer } from '../../../src/tools/aem-environment-facts/renderer';
import {
  type CurrentAemToolContext,
  type EnvironmentFacts,
  newChatId,
  newRequestId,
  newServerId,
  newTurnId,
} from '../../../src/shared';
import { createCountingIdGenerator } from '../../support/testIds';

const FACTS: EnvironmentFacts = {
  origin: 'https://author.example',
  contentRoots: ['/content/a', '/content/b'],
  componentRoots: ['/apps/a'],
};

function envelope(ids: ReturnType<typeof createCountingIdGenerator>): AemEnvironmentFactsRequest {
  return aemEnvironmentFactsRequestSchema.parse({
    operation: 'aem_environment_facts',
    requestId: newRequestId(ids),
    chatId: newChatId(ids),
    turnId: newTurnId(ids),
    serverId: newServerId(ids),
    serverRevision: 1,
    navigationEpoch: 0,
    deadlineMs: 1,
    args: {},
  });
}

function context(ids: ReturnType<typeof createCountingIdGenerator>): CurrentAemToolContext {
  return {
    origin: FACTS.origin,
    serverId: newServerId(ids),
    serverRevision: 1,
    navigationEpoch: 0,
    chatId: newChatId(ids),
    turnId: newTurnId(ids),
  };
}

describe('executeAemEnvironmentFacts', () => {
  it('reports the origin and effective roots the application supplies', async () => {
    const ids = createCountingIdGenerator('ef');
    const result = await executeAemEnvironmentFacts(envelope(ids), {
      origin: FACTS.origin,
      environmentFacts: () => FACTS,
      now: () => 42,
    });
    expect(result).toMatchObject({
      ok: true,
      operation: 'aem_environment_facts',
      sourceOrigin: 'https://author.example',
      contentRoots: ['/content/a', '/content/b'],
      componentRoots: ['/apps/a'],
      fetchedAt: 42,
    });
  });

  it('fails with a select-server action when the pane is not on a configured host', async () => {
    const ids = createCountingIdGenerator('ef');
    const result = await executeAemEnvironmentFacts(envelope(ids), {
      origin: FACTS.origin,
      environmentFacts: () => undefined,
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ACCESS_DENIED');
      expect(result.error.requiredAction).toBe('select_server');
    }
  });
});

describe('createAemEnvironmentFactsExecutor', () => {
  it('returns a structured payload so the transcript can render the facts', async () => {
    const ids = createCountingIdGenerator('ef');
    const executor = createAemEnvironmentFactsExecutor({
      execute: (request, deps) =>
        executeAemEnvironmentFacts(request, {
          origin: deps.origin,
          environmentFacts: deps.environmentFacts,
          now: deps.now,
        }),
      runtimeDeps: { environmentFacts: () => FACTS, now: () => 42 },
      currentContext: () => context(ids),
      clock: () => 42,
      idGenerator: ids,
    });

    const result = await executor({}, { toolCallId: 'call-1' as never, signal: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const payload = result.value as Readonly<Record<string, unknown>>;
      expect(payload['operation']).toBe('aem_environment_facts');
      expect(payload['contentRoots']).toEqual(['/content/a', '/content/b']);
      expect(typeof payload['textResultForLlm']).toBe('string');
    }
  });
});

describe('aem_environment_facts transcript composition', () => {
  const DATA = {
    ok: true,
    operation: 'aem_environment_facts',
    requestId: 'r',
    sourceOrigin: 'https://author.example',
    contentRoots: ['/content/a', '/content/b'],
    componentRoots: ['/apps/a'],
    fetchedAt: 1,
    textResultForLlm: 'Environment facts',
    resultType: 'success',
  };

  it('uses the host URL as the collapsed summary and lists the facts as collapsible rows', () => {
    const details = renderer.describeCall({}, DATA);
    expect(details.summary).toBe('https://author.example');
    expect(details.parameters).toEqual([
      { label: 'Host', value: 'https://author.example' },
      { label: 'Content roots', value: '/content/a, /content/b' },
      { label: 'Component roots', value: '/apps/a' },
    ]);
  });

  it('falls back to the generic argument view before the result, or for another shape', () => {
    expect(renderer.describeCall({})).toEqual({
      summary: undefined,
      parameters: [{ label: 'Arguments', value: '(none)' }],
    });
    expect(renderer.describeCall({}, { operation: 'aem_query' })).toEqual({
      summary: undefined,
      parameters: [{ label: 'Arguments', value: '(none)' }],
    });
  });

  it('has no result table - the facts are the collapsible rows, not an always-visible table', () => {
    expect(renderer.readTableMessage).toBeUndefined();
  });
});
