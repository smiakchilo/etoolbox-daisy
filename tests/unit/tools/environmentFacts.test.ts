import { describe, expect, it } from 'vitest';
import {
  createEnvironmentFactsExecutor,
  executeEnvironmentFacts,
} from '../../../src/tools/environment-facts/environmentFacts';
import { renderer } from '../../../src/tools/environment-facts/renderer';
import {
  type ConfiguredHostInfo,
  type EnvironmentFacts,
  type ToolHost,
  newChatId,
  newRequestId,
  newServerId,
  newTurnId,
} from '../../../src/shared';
import { createCountingIdGenerator } from '../../support/testIds';

const ids = createCountingIdGenerator('ef');

const HOSTS: readonly ConfiguredHostInfo[] = [
  {
    serverId: newServerId(ids),
    label: 'HPE DEV',
    origin: 'https://author.example',
    contentRoots: ['/content/a', '/content/b'],
    componentRoots: ['/apps/a'],
    damRoots: ['/content/dam/a'],
    contentPriorityPaths: ['/content/a/blueprint'],
  },
  {
    serverId: newServerId(ids),
    label: 'Staging',
    origin: 'https://stage.example',
    contentRoots: ['/content'],
    componentRoots: ['/apps'],
    damRoots: ['/content/dam'],
    contentPriorityPaths: [],
  },
];

function host(overrides: Partial<ToolHost> = {}): ToolHost {
  return {
    bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
    currentContext: () => ({
      origin: 'https://author.example',
      serverId: HOSTS[0]?.serverId ?? newServerId(ids),
      serverRevision: 1,
      navigationEpoch: 0,
      chatId: newChatId(ids),
      turnId: newTurnId(ids),
    }),
    environmentFacts: () => undefined,
    configuredHosts: () => HOSTS,
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
    clock: () => 42,
    idGenerator: ids,
    invokeTool: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

describe('executeEnvironmentFacts', () => {
  it('lists every configured host and flags the one the pane is on', () => {
    const result = executeEnvironmentFacts(newRequestId(ids), {
      configuredHosts: () => HOSTS,
      currentOrigin: () => 'https://stage.example',
      now: () => 42,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value as unknown as {
      hosts: Array<{ label: string; current: boolean; contentRoots: string[] }>;
      fetchedAt: number;
    };
    expect(payload.hosts.map((h) => [h.label, h.current])).toEqual([
      ['HPE DEV', false],
      ['Staging', true],
    ]);
    expect(payload.hosts[0]?.contentRoots).toEqual(['/content/a', '/content/b']);
    expect(payload.fetchedAt).toBe(42);
  });

  it('reports priority paths only for a host that configures them', () => {
    const result = executeEnvironmentFacts(newRequestId(ids), {
      configuredHosts: () => HOSTS,
      currentOrigin: () => 'https://author.example',
      now: () => 42,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value as unknown as {
      hosts: Array<{ priorityPaths?: string[]; textResultForLlm?: string }>;
      textResultForLlm?: string;
    };
    expect(payload.hosts[0]?.priorityPaths).toEqual(['/content/a/blueprint']);
    expect(payload.hosts[1]).not.toHaveProperty('priorityPaths');
  });

  it('fails when no host is configured', () => {
    const result = executeEnvironmentFacts(newRequestId(ids), {
      configuredHosts: () => [],
      currentOrigin: () => undefined,
      now: () => 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('createEnvironmentFactsExecutor', () => {
  it('returns a structured payload so the transcript can render the hosts', async () => {
    const executor = createEnvironmentFactsExecutor(
      host({
        environmentFacts: (): EnvironmentFacts => ({
          origin: 'https://author.example',
          contentRoots: ['/content/a', '/content/b'],
          componentRoots: ['/apps/a'],
          damRoots: ['/content/dam/a'],
          contentPriorityPaths: [],
        }),
      }),
    );

    const result = await executor({}, { toolCallId: 'call-1' as never, signal: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value as Readonly<Record<string, unknown>>;
    expect(payload['operation']).toBe('environment_facts');
    expect(typeof payload['textResultForLlm']).toBe('string');
    expect((payload['hosts'] as unknown[]).length).toBe(2);
  });

  it('still lists the hosts when the pane is on no configured host', async () => {
    const executor = createEnvironmentFactsExecutor(host({ environmentFacts: () => undefined }));
    const result = await executor({}, { toolCallId: 'call-1' as never, signal: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value as Readonly<Record<string, unknown>>;
    expect((payload['hosts'] as Array<{ current: boolean }>).every((h) => !h.current)).toBe(true);
  });
});

describe('environment_facts transcript composition', () => {
  const DATA = {
    ok: true,
    operation: 'environment_facts',
    requestId: 'r',
    hosts: [
      {
        label: 'HPE DEV',
        origin: 'https://author.example',
        contentRoots: ['/content/a', '/content/b'],
        componentRoots: ['/apps/a'],
        damRoots: ['/content/dam/a'],
        current: true,
      },
      {
        label: 'Staging',
        origin: 'https://stage.example',
        contentRoots: ['/content'],
        componentRoots: ['/apps'],
        damRoots: ['/content/dam'],
        current: false,
      },
    ],
    fetchedAt: 1,
    textResultForLlm: 'Environment facts',
    resultType: 'success',
  };

  it('summarises with the current host URL and lists the facts of every host', () => {
    const details = renderer.describeCall({}, DATA);
    const values = details.parameters.map((row) => row.value).join('\n');
    expect(details.summary).toBe('https://author.example');
    expect(values).toContain('/content/a, /content/b');
    expect(values).toContain('https://stage.example');
    expect(details.parameters.length).toBeGreaterThan(0);
  });

  it('has no summary before the result, or for another shape', () => {
    expect(renderer.describeCall({}).summary).toBeUndefined();
    expect(renderer.describeCall({}, { operation: 'aem_query' }).summary).toBeUndefined();
  });

  it('has no result table - the hosts are the collapsible rows, not an always-visible table', () => {
    expect(renderer.readTableMessage).toBeUndefined();
  });
});
