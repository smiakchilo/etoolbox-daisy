import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_NAVIGATE_ALLOWLIST_ENTRY,
  BROWSER_NAVIGATE_TOOL_NAME,
  browserNavigateArgsSchema,
  createBrowserNavigateExecutor,
  resolveNavigateHost,
} from '../../../src/tools/browser-navigate/browserNavigate';
import {
  type ConfiguredHostInfo,
  type OpenPageOutcome,
  type OpenPageTarget,
  type ToolHost,
  newServerId,
} from '../../../src/shared';
import { createCountingIdGenerator } from '../../support/testIds';

const ids = createCountingIdGenerator('nav');

const HPE_DEV: ConfiguredHostInfo = {
  serverId: newServerId(ids),
  label: 'HPE DEV',
  origin: 'https://author.example',
  contentRoots: ['/content'],
  componentRoots: ['/apps'],
  damRoots: ['/content/dam'],
  contentPriorityPaths: [],
};
const STAGING: ConfiguredHostInfo = {
  serverId: newServerId(ids),
  label: 'Staging',
  origin: 'https://stage.example',
  contentRoots: ['/content'],
  componentRoots: ['/apps'],
  damRoots: ['/content/dam'],
  contentPriorityPaths: [],
};
const DUP: ConfiguredHostInfo = { ...STAGING, serverId: newServerId(ids), label: 'HPE DEV' };

function makeHost(options: {
  hosts?: readonly ConfiguredHostInfo[];
  currentOrigin?: string;
  outcome?: OpenPageOutcome;
  onOpen?: (target: OpenPageTarget) => void;
}): ToolHost {
  return {
    bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
    currentContext: () => {
      throw new Error('browser_navigate must never ask for an AEM context');
    },
    environmentFacts: () =>
      options.currentOrigin === undefined
        ? undefined
        : {
            origin: options.currentOrigin,
            contentRoots: ['/content'],
            componentRoots: ['/apps'],
            damRoots: ['/content/dam'],
            contentPriorityPaths: [],
          },
    configuredHosts: () => options.hosts ?? [HPE_DEV, STAGING],
    openPage: (target) => {
      options.onOpen?.(target);
      return Promise.resolve(
        options.outcome ?? { kind: 'opened', url: `${target.path}`, switched: false },
      );
    },
    requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
    clock: () => 1,
    idGenerator: ids,
    invokeTool: () => Promise.reject(new Error('not used')),
  };
}

const callContext = { toolCallId: 'call-1' as never, signal: undefined };

describe('browserNavigateArgsSchema', () => {
  it('rejects a path that is not a bare browser path', () => {
    for (const path of ['content/x', '//evil.example/x', 'https://evil.example/x', '/a b', '']) {
      expect(browserNavigateArgsSchema.safeParse({ path }).success).toBe(false);
    }
  });

  it('accepts a content page, an editor path, and a tool path', () => {
    for (const path of ['/content/wknd.html', '/editor.html/content/wknd.html', '/crx/de']) {
      expect(browserNavigateArgsSchema.safeParse({ path }).success).toBe(true);
    }
  });
});

describe('resolveNavigateHost', () => {
  it('matches a label case-insensitively', () => {
    const result = resolveNavigateHost(
      { host: 'hpe dev', path: '/x' },
      [HPE_DEV, STAGING],
      undefined,
    );
    expect(result).toEqual({ ok: true, value: HPE_DEV });
  });

  it('reports the configured labels when none match', () => {
    const result = resolveNavigateHost({ host: 'Prod', path: '/x' }, [HPE_DEV, STAGING], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('unknown_host');
    expect(result.error.message).toContain('HPE DEV');
    expect(result.error.message).toContain('Staging');
  });

  it('refuses an ambiguous label', () => {
    const result = resolveNavigateHost({ host: 'HPE DEV', path: '/x' }, [HPE_DEV, DUP], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('ambiguous_host');
  });

  it('falls back to the current host when none is named', () => {
    const result = resolveNavigateHost({ path: '/x' }, [HPE_DEV, STAGING], STAGING.origin);
    expect(result).toEqual({ ok: true, value: STAGING });
  });

  it('fails when no host is named and the pane is on no configured host', () => {
    const result = resolveNavigateHost({ path: '/x' }, [HPE_DEV], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('no_current_host');
  });
});

describe('createBrowserNavigateExecutor', () => {
  it('opens the resolved host and reports the URL', async () => {
    const onOpen = vi.fn();
    const host = makeHost({
      outcome: { kind: 'opened', url: 'https://author.example/content/wknd.html', switched: false },
      onOpen,
    });
    const executor = createBrowserNavigateExecutor(host);

    const result = await executor({ host: 'HPE DEV', path: '/content/wknd.html' }, callContext);

    expect(onOpen).toHaveBeenCalledWith({
      serverId: HPE_DEV.serverId,
      path: '/content/wknd.html',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value as Readonly<Record<string, unknown>>;
    expect(payload['operation']).toBe(BROWSER_NAVIGATE_TOOL_NAME);
    expect(payload['hostLabel']).toBe('HPE DEV');
    expect(payload['url']).toBe('https://author.example/content/wknd.html');
    expect(typeof payload['textResultForLlm']).toBe('string');
  });

  it('defaults to the current host', async () => {
    const onOpen = vi.fn();
    const host = makeHost({ currentOrigin: STAGING.origin, onOpen });
    await createBrowserNavigateExecutor(host)({ path: '/crx/de' }, callContext);
    expect(onOpen).toHaveBeenCalledWith({ serverId: STAGING.serverId, path: '/crx/de' });
  });

  it('never reaches openPage for an invalid path', async () => {
    const onOpen = vi.fn();
    const host = makeHost({ onOpen });
    const result = await createBrowserNavigateExecutor(host)(
      { host: 'HPE DEV', path: 'https://evil.example' },
      callContext,
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('maps a TLS network failure to TLS_ERROR', async () => {
    const host = makeHost({
      outcome: {
        kind: 'network_error',
        errorCode: 'ERR_CERT_AUTHORITY_INVALID',
        message: 'bad cert',
      },
    });
    const result = await createBrowserNavigateExecutor(host)(
      { host: 'HPE DEV', path: '/content/x.html' },
      callContext,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TLS_ERROR');
  });

  it('maps a missing view to a precondition failure', async () => {
    const host = makeHost({ outcome: { kind: 'no_view' } });
    const result = await createBrowserNavigateExecutor(host)(
      { host: 'HPE DEV', path: '/content/x.html' },
      callContext,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('browser_navigate manifest', () => {
  it('uses the custom allowlist entry', () => {
    expect(BROWSER_NAVIGATE_ALLOWLIST_ENTRY).toBe('custom:browser_navigate');
  });
});
