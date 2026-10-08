import { type Mock, describe, expect, it, vi } from 'vitest';
import {
  type AgentChatController,
  createStartupGatedAgentChatController,
} from '../../../src/main/agentChatController';
import {
  type InstallAgentServiceDeps,
  createBridgeCurrentContext,
  createCurrentAemServerContext,
  createCurrentPageContext,
  createEnvironmentFacts,
  createLateBoundAemToolContext,
  FAKE_AGENT_SERVICE_ENV_VAR,
  installAgentService,
  resolveBundledSkillsDirectory,
  runAfterFrameLoad,
  shouldUseFakeAgentService,
  startAppRuntime,
  wireNavigationEpochCancellation,
} from '../../../src/main/agentComposition';
import { createFakeAgentService } from '../../../src/main/agents/fakeAgentService';
import type { ActiveAemServer } from '../../../src/main/browser/browserController';
import type { ChatJournal } from '../../../src/main/chatJournal';
import type { Logger } from '../../../src/main/logger';
import {
  type AgentService,
  type CurrentAemToolContext,
  type ServerConfig,
  newChatId,
  newServerId,
  newTurnId,
  serverConfigSchema,
} from '../../../src/shared';

function counterIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(n++)}`;
}

/**
 * Returns a plain (non-`Logger`-typed) handle to the mock functions
 * alongside the `Logger` they back, so a test can `expect(spies.error)...`
 * against a value whose own inferred type is "whatever `vi.fn()` returns",
 * never `Logger["error"]` itself - referencing an interface's own method
 * shorthand that way is what `@typescript-eslint/unbound-method` flags,
 * since such a method could (in general) depend on `this`.
 */
function noopLogger(): { logger: Logger; spies: { info: Mock; warn: Mock; error: Mock } } {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const logger: Logger = {
    info,
    warn,
    error,
    getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
  };
  return { logger, spies: { info, warn, error } };
}

// ---------------------------------------------------------------------------
// createCurrentAemServerContext / createBridgeCurrentContext
// ---------------------------------------------------------------------------

describe('createCurrentAemServerContext', () => {
  it('returns undefined without fabricating an origin when no server is active', () => {
    const provider = createCurrentAemServerContext(() => undefined);
    expect(provider()).toBeUndefined();
  });

  it('reads the active server fresh on every call rather than capturing it once', () => {
    const ids = counterIds('server');
    let current: ActiveAemServer | undefined = {
      serverId: newServerId(ids),
      origin: 'https://a.example',
      revision: 0,
    };
    const provider = createCurrentAemServerContext(() => current);

    const first = provider();
    current = { serverId: newServerId(ids), origin: 'https://b.example', revision: 5 };
    const second = provider();

    expect(first).toEqual({ origin: 'https://a.example', serverId: 'server-0', serverRevision: 0 });
    expect(second).toEqual({
      origin: 'https://b.example',
      serverId: 'server-1',
      serverRevision: 5,
    });
  });
});

describe('createCurrentPageContext', () => {
  function activeServer(origin: string): ActiveAemServer {
    return { serverId: newServerId(counterIds('server')), origin, revision: 1 };
  }

  it('returns undefined when no server is active, so no page context is invented', () => {
    const provider = createCurrentPageContext(
      () => undefined,
      () => 'https://a.example/content/wknd.html',
      () => undefined,
    );
    expect(provider()).toBeUndefined();
  });

  it('returns undefined when the pane is on a different origin than the active server (an SSO/IdP page)', () => {
    const provider = createCurrentPageContext(
      () => activeServer('https://author.example'),
      () => 'https://idp.example/authorize?client_id=x',
      () => undefined,
    );
    expect(provider()).toBeUndefined();
  });

  it('renders the host, content path and default roots for the active server page', () => {
    const provider = createCurrentPageContext(
      () => activeServer('https://author.example'),
      () => 'https://author.example/editor.html/content/wknd/us/en.html',
      () => undefined,
    );
    const context = provider();
    expect(context).toContain('Host: https://author.example');
    expect(context).toContain('Content path: /content/wknd/us/en');
    expect(context).toContain('Content roots: /content');
    expect(context).toContain('Component roots: /apps');
  });

  it("renders the host's configured roots from the environment facts", () => {
    const provider = createCurrentPageContext(
      () => activeServer('https://author.example'),
      () => 'https://author.example/editor.html/content/wknd/us/en.html',
      () => ({
        origin: 'https://author.example',
        contentRoots: ['/content/a', '/content/b'],
        componentRoots: ['/apps/a'],
      }),
    );
    const context = provider();
    expect(context).toContain('Content roots: /content/a, /content/b');
    expect(context).toContain('Component roots: /apps/a');
  });

  it('reads the live URL fresh on every call, so navigation between turns is reflected', () => {
    let url = 'https://author.example/content/wknd/a.html';
    const provider = createCurrentPageContext(
      () => activeServer('https://author.example'),
      () => url,
      () => undefined,
    );
    expect(provider()).toContain('Content path: /content/wknd/a');
    url = 'https://author.example/content/wknd/b.html';
    expect(provider()).toContain('Content path: /content/wknd/b');
  });
});

describe('createEnvironmentFacts', () => {
  function host(
    origin: string,
    roots: { contentRoots?: string; componentRoots?: string } = {},
  ): ServerConfig {
    return serverConfigSchema.parse({
      id: newServerId(counterIds('server')),
      label: 'Host',
      origin,
      color: { kind: 'swatch', swatch: 'blue' },
      ...roots,
      revision: 0,
    });
  }

  it('matches the live URL to a configured host and resolves its roots', () => {
    const facts = createEnvironmentFacts(
      () => 'https://author.example/editor.html/content/wknd/us/en.html',
      () => [
        host('https://author.example', {
          contentRoots: '/content/a; /content/b',
          componentRoots: '/apps/a, /apps/b',
        }),
      ],
    )();
    expect(facts).toEqual({
      origin: 'https://author.example',
      contentRoots: ['/content/a', '/content/b'],
      componentRoots: ['/apps/a', '/apps/b'],
    });
  });

  it('defaults the roots when the matched host configures none', () => {
    const facts = createEnvironmentFacts(
      () => 'https://author.example/content/x.html',
      () => [host('https://author.example')],
    )();
    expect(facts?.contentRoots).toEqual(['/content']);
    expect(facts?.componentRoots).toEqual(['/apps']);
  });

  it('returns undefined for an unconfigured origin and when there is no document', () => {
    expect(
      createEnvironmentFacts(
        () => 'https://unconfigured.example/x.html',
        () => [host('https://author.example')],
      )(),
    ).toBeUndefined();
    expect(
      createEnvironmentFacts(
        () => undefined,
        () => [host('https://author.example')],
      )(),
    ).toBeUndefined();
  });
});

describe('createBridgeCurrentContext', () => {
  it("reads the active server's revision and the navigation epoch fresh on every call", () => {
    const ids = counterIds('server');
    let server: ActiveAemServer | undefined = {
      serverId: newServerId(ids),
      origin: 'https://a.example',
      revision: 0,
    };
    let epoch = 0;
    const provider = createBridgeCurrentContext(
      () => server,
      () => epoch,
    );

    expect(provider()).toEqual({ serverRevision: 0, navigationEpoch: 0 });
    server = { ...server, revision: 7 };
    epoch = 3;
    expect(provider()).toEqual({ serverRevision: 7, navigationEpoch: 3 });
  });

  it('reports a serverRevision no real server can ever carry when no server is active, so staleness checks fail closed', () => {
    const provider = createBridgeCurrentContext(
      () => undefined,
      () => 2,
    );
    const context = provider();
    expect(context.navigationEpoch).toBe(2);
    // serverRevisionSchema is z.number().int().nonnegative() - never negative.
    expect(context.serverRevision).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// createLateBoundAemToolContext
// ---------------------------------------------------------------------------

describe('createLateBoundAemToolContext', () => {
  it('throws if currentContext is read before bind, rather than returning a placeholder', () => {
    const lateBound = createLateBoundAemToolContext();
    expect(() => lateBound.currentContext()).toThrow(/bound/);
  });

  it('delegates to the bound controller fresh on every call, not a value captured at bind time', () => {
    const ids = counterIds('ctx');
    const contexts: CurrentAemToolContext[] = [
      {
        origin: 'https://a.example',
        serverId: newServerId(ids),
        serverRevision: 0,
        navigationEpoch: 0,
        chatId: newChatId(ids),
        turnId: newTurnId(ids),
      },
      {
        origin: 'https://b.example',
        serverId: newServerId(ids),
        serverRevision: 1,
        navigationEpoch: 1,
        chatId: newChatId(ids),
        turnId: newTurnId(ids),
      },
    ];
    let call = 0;
    const controller: Pick<AgentChatController, 'currentAemToolContext'> = {
      currentAemToolContext: () => contexts[call++]!,
    };
    const lateBound = createLateBoundAemToolContext();

    lateBound.bind(controller);

    expect(lateBound.currentContext()).toEqual(contexts[0]);
    expect(lateBound.currentContext()).toEqual(contexts[1]);
  });
});

// ---------------------------------------------------------------------------
// wireNavigationEpochCancellation
// ---------------------------------------------------------------------------

describe('wireNavigationEpochCancellation', () => {
  it("cancels the chat controller's in-flight turn whenever the navigation epoch bumps", () => {
    let bumpListener: (() => void) | undefined;
    const navigationEpoch = {
      subscribe: vi.fn((listener: () => void) => {
        bumpListener = listener;
        return vi.fn();
      }),
    };
    const handleAemContextInvalidated = vi.fn(() => Promise.resolve());
    const chatController: Pick<AgentChatController, 'handleAemContextInvalidated'> = {
      handleAemContextInvalidated,
    };

    wireNavigationEpochCancellation(navigationEpoch, chatController, noopLogger().logger);
    expect(navigationEpoch.subscribe).toHaveBeenCalledTimes(1);

    bumpListener?.();

    expect(handleAemContextInvalidated).toHaveBeenCalledTimes(1);
  });

  it("returns the tracker's own unsubscribe function", () => {
    const unsubscribe = vi.fn();
    const navigationEpoch = { subscribe: vi.fn(() => unsubscribe) };
    const chatController: Pick<AgentChatController, 'handleAemContextInvalidated'> = {
      handleAemContextInvalidated: () => Promise.resolve(),
    };

    const returned = wireNavigationEpochCancellation(
      navigationEpoch,
      chatController,
      noopLogger().logger,
    );

    expect(returned).toBe(unsubscribe);
  });

  it('logs rather than throws if a non-conformant AgentService rejects instead of resolving a Result', async () => {
    let bumpListener: (() => void) | undefined;
    const navigationEpoch = {
      subscribe: vi.fn((listener: () => void) => {
        bumpListener = listener;
        return vi.fn();
      }),
    };
    const chatController: Pick<AgentChatController, 'handleAemContextInvalidated'> = {
      handleAemContextInvalidated: () => Promise.reject(new Error('boom')),
    };
    const { logger, spies } = noopLogger();

    wireNavigationEpochCancellation(navigationEpoch, chatController, logger);
    bumpListener?.();
    // Let the rejected promise's `.catch` microtask run.
    await Promise.resolve();
    await Promise.resolve();

    expect(spies.error).toHaveBeenCalledWith('AGENT_CHAT_ABORT_ON_CONTEXT_CHANGE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// shouldUseFakeAgentService / selectAgentService
// ---------------------------------------------------------------------------

describe('shouldUseFakeAgentService', () => {
  it('is true when the env var is set and the build is not packaged', () => {
    expect(shouldUseFakeAgentService({ [FAKE_AGENT_SERVICE_ENV_VAR]: '1' }, false)).toBe(true);
  });

  it('is false when the build is packaged, even with the env var set', () => {
    expect(shouldUseFakeAgentService({ [FAKE_AGENT_SERVICE_ENV_VAR]: '1' }, true)).toBe(false);
  });

  it('is false when the env var is absent', () => {
    expect(shouldUseFakeAgentService({}, false)).toBe(false);
  });

  it('is false when the env var is set to an empty string', () => {
    expect(shouldUseFakeAgentService({ [FAKE_AGENT_SERVICE_ENV_VAR]: '' }, false)).toBe(false);
  });
});

function fakeAgentServiceDouble(): AgentService {
  return {
    initialize: () => Promise.resolve({ ok: true, value: undefined }),
    getAuthState: () => ({ apiVersion: 1, isAuthenticated: true }),
    getOpenSessionId: () => undefined,
    onAuthStateChanged: () => () => {},
    onEvent: () => () => {},
    openConversation: () => Promise.reject(new Error('not used in this test')),
    sendPrompt: () => Promise.reject(new Error('not used in this test')),
    abort: () => Promise.reject(new Error('not used in this test')),
    closeConversation: () => Promise.reject(new Error('not used in this test')),
    requestUserInput: () => Promise.reject(new Error('not used in this test')),
    respondToInput: () => Promise.reject(new Error('not used in this test')),
    dispose: () => Promise.resolve(),
  };
}

// ---------------------------------------------------------------------------
// installAgentService - what any agent's runtime calls, once started, to put
// its AgentService behind the chat surface. Agent-neutral by construction.
// ---------------------------------------------------------------------------

/** Resolves/rejects on demand from the test, so ordering can be asserted precisely. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installDeps(
  gatedController: ReturnType<typeof createStartupGatedAgentChatController>,
  extra: Partial<InstallAgentServiceDeps> = {},
): InstallAgentServiceDeps {
  return {
    logger: noopLogger().logger,
    idGenerator: counterIds('turn'),
    currentAemServerContext: () => undefined,
    navigationEpoch: () => 0,
    currentPageContext: () => undefined,
    gatedController,
    ...extra,
  };
}

describe('installAgentService', () => {
  it('initializes the service before the controller becomes ready', async () => {
    const gate = deferred<{ ok: true; value: undefined }>();
    const service = { ...fakeAgentServiceDouble(), initialize: vi.fn(() => gate.promise) };
    const gatedController = createStartupGatedAgentChatController();

    const run = installAgentService(installDeps(gatedController), service);

    await Promise.resolve();
    expect(service.initialize).toHaveBeenCalledTimes(1);
    expect(gatedController.getStatus().serviceState).toBe('starting');

    gate.resolve({ ok: true, value: undefined });
    await run;

    expect(gatedController.getStatus().serviceState).toBe('ready');
  });

  it('propagates an initialize rejection to its caller and leaves the controller starting', async () => {
    const service = {
      ...fakeAgentServiceDouble(),
      initialize: () => Promise.reject(new Error('boom')),
    };
    const gatedController = createStartupGatedAgentChatController();

    await expect(installAgentService(installDeps(gatedController), service)).rejects.toThrow(
      'boom',
    );

    expect(gatedController.getStatus().serviceState).toBe('starting');
  });

  it('threads cancelAemRequests and the chat journal into the controller it builds', async () => {
    // Both are optional dependencies wired only here; a silent drop would leave
    // Stop not cancelling the AEM fetch and the journal never writing, with no
    // type error to catch it.
    const agentService = createFakeAgentService({ idGenerator: counterIds('fake') });
    const gatedController = createStartupGatedAgentChatController();
    const cancelAemRequests = vi.fn();
    const openChat = vi.fn();
    const chatJournal: ChatJournal = {
      openChat,
      recordUserPrompt: vi.fn(),
      discardUserPrompt: vi.fn(),
      recordEvent: vi.fn(),
      closeChat: vi.fn(),
      getHealth: () => ({ writeFailureCount: 0, droppedRecordCount: 0, lastFailureCode: null }),
    };

    await installAgentService(
      installDeps(gatedController, { chatJournal, cancelAemRequests }),
      agentService,
    );

    const chatId = newChatId(counterIds('chat'));
    await gatedController.openConversation({ chatId });
    await gatedController.sendMessage({ chatId, prompt: 'hi' });
    await gatedController.abort({ chatId });

    expect(openChat).toHaveBeenCalledTimes(1);
    expect(cancelAemRequests).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// startAppRuntime - the ordering guarantee itself: non-agent registration
// must never wait behind the (potentially slow, potentially failing)
// background agent-service startup.
// ---------------------------------------------------------------------------

describe('startAppRuntime', () => {
  it('registers non-agent handlers synchronously, before the agent service startup promise ever settles', async () => {
    const agentGate = deferred<void>();
    const registerNonAgentHandlers = vi.fn();
    const onAgentServiceStartupFailed = vi.fn();

    startAppRuntime({
      registerNonAgentHandlers,
      startAgentService: () => agentGate.promise,
      onAgentServiceStartupFailed,
    });

    // Registration must already have happened - synchronously, in the same
    // tick `startAppRuntime` was called - regardless of how long the agent
    // service startup promise takes to settle. If a future edit re-inserts
    // an `await` on `startAgentService()` ahead of this call, this
    // assertion is what catches it.
    expect(registerNonAgentHandlers).toHaveBeenCalledTimes(1);

    agentGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(onAgentServiceStartupFailed).not.toHaveBeenCalled();
  });

  it('routes a startup failure to onAgentServiceStartupFailed instead of ever leaving it an unhandled rejection', async () => {
    const failure = new Error('copilot cli missing');
    const registerNonAgentHandlers = vi.fn();
    const onAgentServiceStartupFailed = vi.fn();

    startAppRuntime({
      registerNonAgentHandlers,
      startAgentService: () => Promise.reject(failure),
      onAgentServiceStartupFailed,
    });

    // Let the rejected promise's `.catch` microtask run.
    await Promise.resolve();
    await Promise.resolve();

    expect(onAgentServiceStartupFailed).toHaveBeenCalledWith(failure);
  });
});

// ---------------------------------------------------------------------------
// runAfterFrameLoad - the deferral that keeps an agent SDK's synchronous
// import cost off the window's startup path: the shell must paint (the frame
// must finish loading) before the agent is built.
// ---------------------------------------------------------------------------

describe('runAfterFrameLoad', () => {
  it('waits for the frame to finish loading when it is still loading', () => {
    let loaded: (() => void) | undefined;
    const start = vi.fn();
    runAfterFrameLoad(
      {
        isLoadingMainFrame: () => true,
        onceLoaded: (run) => {
          loaded = run;
        },
      },
      start,
    );

    // Not yet: the frame is still loading, so the agent must not be built.
    expect(start).not.toHaveBeenCalled();
    expect(loaded).toBeDefined();

    loaded?.();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('defers to the next tick when the frame has already loaded', async () => {
    const start = vi.fn();
    runAfterFrameLoad({ isLoadingMainFrame: () => false, onceLoaded: vi.fn() }, start);

    // Deferred, not synchronous: anything already queued on the event loop (an
    // in-flight IPC reply the shell is awaiting) is serviced first.
    expect(start).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('runs start at most once even if the load event fires more than once', () => {
    let loaded: (() => void) | undefined;
    const start = vi.fn();
    runAfterFrameLoad(
      {
        isLoadingMainFrame: () => true,
        onceLoaded: (run) => {
          loaded = run;
        },
      },
      start,
    );

    loaded?.();
    loaded?.();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not register a load listener when the frame has already loaded', () => {
    const onceLoaded = vi.fn();
    runAfterFrameLoad({ isLoadingMainFrame: () => false, onceLoaded }, vi.fn());
    expect(onceLoaded).not.toHaveBeenCalled();
  });
});

describe('resolveBundledSkillsDirectory', () => {
  const join = (...segments: readonly string[]): string => segments.join('/');

  it('reads from the packaged resources directory when packaged', () => {
    expect(
      resolveBundledSkillsDirectory({
        isPackaged: true,
        resourcesPath: 'C:/Program Files/EToolbox Daisy/resources',
        mainDir: 'C:/Program Files/EToolbox Daisy/resources/app.asar/out/main',
        join,
      }),
    ).toBe('C:/Program Files/EToolbox Daisy/resources/resources/skills');
  });

  it('reads from the repository resources directory when unpackaged', () => {
    expect(
      resolveBundledSkillsDirectory({
        isPackaged: false,
        resourcesPath: 'C:/ignored',
        mainDir: 'E:/repo/out/main',
        join,
      }),
    ).toBe('E:/repo/out/main/../../resources/skills');
  });

  it('never derives the directory from the user home or the project directory', () => {
    // The only inputs are the app's own install location and a path joiner;
    // there is no parameter through which settings, an AEM response, or the
    // user's environment could redirect where skills are loaded from.
    const packaged = resolveBundledSkillsDirectory({
      isPackaged: true,
      resourcesPath: 'C:/app/resources',
      mainDir: 'C:/app/resources/app.asar/out/main',
      join,
    });
    expect(packaged).not.toMatch(/Users|home|AppData/i);
    expect(packaged.endsWith('resources/skills')).toBe(true);
  });
});
