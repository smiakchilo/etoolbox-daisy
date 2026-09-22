import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createCurrentAemServerContext,
  createBridgeCurrentContext,
  createBrokeredExecute,
  createBrokeredQueryExecute,
  resolveBundledSkillsDirectory,
  createLateBoundAemToolContext,
  wireNavigationEpochCancellation,
  shouldUseFakeAgentService,
  selectAgentService,
  startAgentServiceInBackground,
  startAppRuntime,
  FAKE_AGENT_SERVICE_ENV_VAR,
} from '../../../src/main/agentComposition';
import type { ActiveAemServer } from '../../../src/main/browser/browserController';
import {
  createStartupGatedAgentChatController,
  type AgentChatController,
} from '../../../src/main/agentChatController';
import type { Logger } from '../../../src/main/logger';
import type { AgentService } from '../../../src/agent/agentService';
import type { CurrentAemToolContext } from '../../../src/shared';
import { newChatId, newRequestId, newServerId, newTurnId } from '../../../src/shared';
import type { AemGetJsonRequest } from '../../../src/shared';
import type { AemQueryRequest } from '../../../src/shared';
import type { BrokerOutcome } from '../../../src/shared';

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
// createBrokeredExecute
// ---------------------------------------------------------------------------

function makeEnvelope(overrides: Partial<AemGetJsonRequest> = {}): AemGetJsonRequest {
  const ids = counterIds('id');
  return {
    operation: 'aem_get_json',
    requestId: newRequestId(ids),
    chatId: newChatId(ids),
    turnId: newTurnId(ids),
    serverId: newServerId(ids),
    serverRevision: 0,
    navigationEpoch: 0,
    deadlineMs: 1_700_000_010_000,
    args: { path: '/content/foo' },
    ...overrides,
  };
}

/** A hand-rolled recording fake for `AemBridgeBroker.request`, matching this codebase's stated preference (see `bridgeBroker.test.ts`) for recording fakes over `vi.fn` where call arguments matter. */
function recordingBrokerRequest(outcome: BrokerOutcome): {
  readonly request: (envelope: AemGetJsonRequest, url: string) => Promise<BrokerOutcome>;
  readonly calls: Array<{ envelope: AemGetJsonRequest; url: string }>;
} {
  const calls: Array<{ envelope: AemGetJsonRequest; url: string }> = [];
  return {
    calls,
    request: (envelope, url) => {
      calls.push({ envelope, url });
      return Promise.resolve(outcome);
    },
  };
}

describe('createBrokeredExecute', () => {
  it("routes the fetch through the broker with the URL built for that envelope's own args", async () => {
    const broker = recordingBrokerRequest({
      kind: 'response',
      status: 200,
      contentType: 'application/json',
      bodyText: '{"jcr:primaryType":"nt:unstructured"}',
    });
    const execute = createBrokeredExecute(broker);
    const envelope = makeEnvelope();

    const result = await execute(envelope, {
      origin: 'https://aem.example',
      now: () => 1_700_000_000_000,
    });

    expect(result.ok).toBe(true);
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]?.envelope).toBe(envelope);
    expect(broker.calls[0]?.url).toBe('https://aem.example/content/foo.0.json');
  });

  it("passes each call's own envelope to the broker rather than one captured from an earlier call", async () => {
    const broker = recordingBrokerRequest({ kind: 'cancelled' });
    const execute = createBrokeredExecute(broker);
    const envelopeA = makeEnvelope();
    const envelopeB = makeEnvelope();

    await execute(envelopeA, { origin: 'https://aem.example', now: () => 1 });
    await execute(envelopeB, { origin: 'https://aem.example', now: () => 2 });

    expect(broker.calls).toHaveLength(2);
    expect(broker.calls[0]).toEqual({
      envelope: envelopeA,
      url: 'https://aem.example/content/foo.0.json',
    });
    expect(broker.calls[1]).toEqual({
      envelope: envelopeB,
      url: 'https://aem.example/content/foo.0.json',
    });
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
    onAuthStateChanged: () => () => {},
    onEvent: () => () => {},
    openConversation: () => Promise.reject(new Error('not used in this test')),
    sendPrompt: () => Promise.reject(new Error('not used in this test')),
    abort: () => Promise.reject(new Error('not used in this test')),
    closeConversation: () => Promise.reject(new Error('not used in this test')),
    dispose: () => Promise.resolve(),
  };
}

describe('selectAgentService', () => {
  it('builds and returns the fake, and logs clearly, when the env var is set and the build is not packaged', () => {
    const fake = fakeAgentServiceDouble();
    const real = fakeAgentServiceDouble();
    const createFakeService = vi.fn(() => fake);
    const createRealService = vi.fn(() => real);
    const { logger, spies } = noopLogger();

    const selected = selectAgentService({
      env: { [FAKE_AGENT_SERVICE_ENV_VAR]: '1' },
      isPackaged: false,
      logger,
      createFakeService,
      createRealService,
    });

    expect(selected).toBe(fake);
    expect(createRealService).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledWith('AGENT_SERVICE_FAKE_SELECTED');
  });

  it('builds and returns the real adapter when packaged, even with the env var set, and never logs the fake-selected message', () => {
    const fake = fakeAgentServiceDouble();
    const real = fakeAgentServiceDouble();
    const createFakeService = vi.fn(() => fake);
    const createRealService = vi.fn(() => real);
    const { logger, spies } = noopLogger();

    const selected = selectAgentService({
      env: { [FAKE_AGENT_SERVICE_ENV_VAR]: '1' },
      isPackaged: true,
      logger,
      createFakeService,
      createRealService,
    });

    expect(selected).toBe(real);
    expect(createFakeService).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it('builds and returns the real adapter when the env var is absent', () => {
    const real = fakeAgentServiceDouble();
    const createRealService = vi.fn(() => real);

    const selected = selectAgentService({
      env: {},
      isPackaged: false,
      logger: noopLogger().logger,
      createFakeService: () => fakeAgentServiceDouble(),
      createRealService,
    });

    expect(selected).toBe(real);
  });
});

// ---------------------------------------------------------------------------
// startAgentServiceInBackground - the slow (real-path) part of standing up
// the agent chat surface, run off the critical path.
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

describe('startAgentServiceInBackground', () => {
  it("awaits copilotClient.start() before building the agent service - the real path's client must be started first", async () => {
    const startGate = deferred<void>();
    const copilotClient = { start: vi.fn(() => startGate.promise) };
    const buildAgentService = vi.fn(() => fakeAgentServiceDouble());
    const gatedController = createStartupGatedAgentChatController();

    const runPromise = startAgentServiceInBackground({
      copilotClient,
      buildAgentService,
      logger: noopLogger().logger,
      idGenerator: counterIds('turn'),
      currentAemServerContext: () => undefined,
      navigationEpoch: () => 0,
      gatedController,
    });

    // Still pending: copilotClient.start() has not resolved yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(copilotClient.start).toHaveBeenCalledTimes(1);
    expect(buildAgentService).not.toHaveBeenCalled();
    expect(gatedController.getStatus().serviceState).toBe('starting');

    startGate.resolve(undefined);
    await runPromise;

    expect(buildAgentService).toHaveBeenCalledTimes(1);
    expect(gatedController.getStatus().serviceState).toBe('ready');
  });

  it('skips copilotClient.start() entirely on the fake path (copilotClient undefined) and still marks the gated controller ready', async () => {
    const buildAgentService = vi.fn(() => fakeAgentServiceDouble());
    const gatedController = createStartupGatedAgentChatController();

    await startAgentServiceInBackground({
      copilotClient: undefined,
      buildAgentService,
      logger: noopLogger().logger,
      idGenerator: counterIds('turn'),
      currentAemServerContext: () => undefined,
      navigationEpoch: () => 0,
      gatedController,
    });

    expect(buildAgentService).toHaveBeenCalledTimes(1);
    expect(gatedController.getStatus().serviceState).toBe('ready');
  });

  it('propagates a copilotClient.start() rejection to its own caller, without building the agent service or marking the controller ready', async () => {
    const copilotClient = { start: () => Promise.reject(new Error('boom')) };
    const buildAgentService = vi.fn(() => fakeAgentServiceDouble());
    const gatedController = createStartupGatedAgentChatController();

    await expect(
      startAgentServiceInBackground({
        copilotClient,
        buildAgentService,
        logger: noopLogger().logger,
        idGenerator: counterIds('turn'),
        currentAemServerContext: () => undefined,
        navigationEpoch: () => 0,
        gatedController,
      }),
    ).rejects.toThrow('boom');

    expect(buildAgentService).not.toHaveBeenCalled();
    expect(gatedController.getStatus().serviceState).toBe('starting');
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
// createBrokeredQueryExecute / resolveBundledSkillsDirectory  (Step 08)
// ---------------------------------------------------------------------------

describe('createBrokeredQueryExecute', () => {
  function queryEnvelope(): AemQueryRequest {
    return {
      operation: 'aem_query',
      requestId: newRequestId(() => 'req-q'),
      chatId: newChatId(() => 'chat-q'),
      turnId: newTurnId(() => 'turn-q'),
      serverId: newServerId(() => 'srv-q'),
      serverRevision: 1,
      navigationEpoch: 0,
      deadlineMs: 30_000,
      args: { predicates: { path: '/content/site' }, limit: 50, offset: 0 },
    };
  }

  it('routes the request through the broker with the current envelope', async () => {
    const request = vi.fn((envelope: AemQueryRequest, url: string): Promise<BrokerOutcome> =>
      Promise.resolve({
        kind: 'response',
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify({
          success: true,
          results: 0,
          total: 0,
          more: false,
          hits: [],
          echoed: `${envelope.operation}:${url.length}`,
        }),
      }),
    );
    const execute = createBrokeredQueryExecute({ request });
    const envelope = queryEnvelope();
    const result = await execute(envelope, { origin: 'https://aem.example.com', now: () => 1 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.lastCall?.[0]).toBe(envelope);
    expect(result.ok).toBe(true);
  });

  it('targets the QueryBuilder endpoint on the bound origin, not on anything in the args', async () => {
    let seenUrl: string | undefined;
    const request = vi.fn((_envelope: AemQueryRequest, url: string): Promise<BrokerOutcome> => {
      seenUrl = url;
      return Promise.resolve({
        kind: 'response',
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify({ success: true, results: 0, total: 0, more: false, hits: [] }),
      });
    });
    const execute = createBrokeredQueryExecute({ request });
    await execute(queryEnvelope(), { origin: 'https://aem.example.com', now: () => 1 });
    expect(seenUrl?.startsWith('https://aem.example.com/bin/querybuilder.json?')).toBe(true);
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
