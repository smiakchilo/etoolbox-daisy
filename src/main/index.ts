import { app, BrowserWindow, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAppDirectories, getOsHomeDirectory, resolveAppPaths } from './appPaths';
import { registerAgentAuthHandlers } from './ipc/agent';
import { registerAgentChatIpcHandlers } from './ipc/agentChat';
import { registerAppInfoHandler } from './ipc/app-info';
import { registerBrowserIpcHandlers } from './ipc/browser';
import { registerSettingsIpcHandlers } from './ipc/settings';
import { createTrustedWindowRegistry } from './ipc/trustedWindows';
import { createLogger } from './logger';
import { createSecretStore } from './secretStore';
import { loadSettings } from './settingsStore';
import { installContentSecurityPolicy } from './csp';
import { installWebContentsSecurityGuard } from './security';
import { createAemSession } from './aem';
import { createAemBridgeBroker } from './aem/bridgeBroker';
import { createAemBridgeTransport } from './aem/bridgeTransport';
import { installAppProtocolHandler, registerAppProtocolPrivileges } from './browser/appProtocol';
import { createBrowserController } from './browser/browserController';
import { createMainWindow } from './windows';
import { createStartupGatedAgentChatController } from './agentChatController';
import {
  createBridgeCurrentContext,
  createBrokeredExecute,
  createBrokeredQueryExecute,
  createCurrentAemServerContext,
  createLateBoundAemToolContext,
  createModelPreferenceCache,
  exposeFakeAgentServiceForTests,
  fakeModelCatalog,
  isModelSelectionLocked,
  resolveBundledSkillsDirectory,
  selectAgentService,
  shouldUseFakeAgentService,
  startAgentServiceInBackground,
  startAppRuntime,
  wireNavigationEpochCancellation,
} from './agentComposition';
import { createHardenedCopilotClient, loadModelCatalog } from '../agent';
import {
  createAemGetJsonExecutor,
  createAemQueryExecutor,
  AEM_GET_JSON_TOOL_NAME,
  AEM_QUERY_TOOL_NAME,
  buildAemToolPolicy,
} from '../agent/aemTool';
import { createSdkAgentService } from '../agent/sdkAgentService';
import { createFakeAgentService } from '../agent/fakeAgentService';
import { err, ok } from '../shared';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDistDir = path.join(currentDir, '../renderer');
const aemPreloadPath = path.join(currentDir, '../preload/aem-preload.js');
const isDev = Boolean(process.env['ELECTRON_RENDERER_URL']);

// Must run before `app.whenReady()` - Electron ignores
// `protocol.registerSchemesAsPrivileged` once Chromium has already started
// (see `browser/appProtocol.ts`'s own doc comment). Placed ahead of every
// other startup step, including `app.setName`, so there is no way for a
// future edit above it to accidentally move it past `whenReady()`.
registerAppProtocolPrivileges();

// Electron only infers app.getName() from package.json when launched as
// `electron .`; our dev/e2e runs launch the built main entry file directly,
// so without this it falls back to the generic "Electron" name. Set it
// explicitly so it always matches electron-builder's productName.
app.setName('EToolbox Daisy');

// Resolving paths is pure (os.homedir + path.join): it performs no filesystem
// access, so it is safe to do before this process owns the single-instance
// lock. Creating the directories is NOT, and stays below the lock check.
const appPaths = resolveAppPaths(getOsHomeDirectory());

// These must run before BOTH `app.requestSingleInstanceLock()` and any
// window/session creation, for two independent reasons:
//
//  1. Electron keys the single-instance lock on `userData`. Requesting the
//     lock first happens to work today - empirically the native lock is
//     registered late enough to observe a later `setPath` - but that is an
//     implicit timing dependency, not a documented contract. Setting the
//     path first makes "one process owns ~/etoolbox-daisy" true by
//     construction instead of by accident. Verified from both directions in
//     tests/e2e/step04-storage.spec.ts: two different storage roots do not
//     conflict, and one storage root still conflicts across different
//     default APPDATA locations.
//  2. Chromium reads and caches these paths once a session exists, so
//     setting them after `whenReady()` has no effect.
//
// `userData`/`sessionData` are the only two Electron path names that cover
// browser/session-owned data (cookies, disk cache, Local Storage, GPU cache,
// Electron's own "Local State" file); "settings"/"copilot"/"chats" are plain
// app-managed directories read directly from `appPaths` by other modules
// (settingsStore, secretStore, the agent runtime, chat history), not through
// `app.getPath`, so they are not set here.
app.setPath('userData', appPaths.browser);
app.setPath('sessionData', appPaths.browser);
app.setPath('temp', appPaths.tmp);
app.setPath('logs', appPaths.logs);

// One process owns `~/etoolbox-daisy`. This must be checked before touching
// the filesystem at all: a second launch must not create or write any of
// the six storage subdirectories, only hand its argv to the primary
// instance (via requestSingleInstanceLock's own IPC, unrelated to our
// storage tree) and exit.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existingWindow] = BrowserWindow.getAllWindows();
    if (existingWindow) {
      // A minimized window does not un-minimize just by focusing it -
      // restore() must run first (this is Electron's own documented
      // single-instance pattern for app.on("second-instance", ...)).
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.focus();
    }
  });

  ensureAppDirectories(appPaths);

  void app.whenReady().then(async () => {
    installContentSecurityPolicy(isDev);
    installWebContentsSecurityGuard(rendererDistDir);
    installAppProtocolHandler(rendererDistDir);
    registerAppInfoHandler();
    registerAgentAuthHandlers();

    // Step 04: diagnostics-only logger, and the OS-backed secret store for
    // app-managed passwords. `safeStorage` (Electron's real DPAPI
    // wrapper on Windows) is injected as the store's `SecretCipher` here -
    // the only place this app is allowed to construct one - so
    // `secretStore.ts` itself stays Electron-free and unit-testable. The
    // secrets directory is a subdirectory of the existing `settings` path,
    // not a new top-level directory alongside `appPaths`'s fixed six.
    const logger = createLogger(appPaths.logs);
    const secretsDir = path.join(appPaths.settings, 'secrets');
    const secretStore = createSecretStore(secretsDir, safeStorage);

    // Explicit, observable failure path - never a silent plaintext
    // fallback. `secretStore` itself already throws instead of falling
    // back to plaintext on every `set`/`get`; this just makes an
    // unavailable secure storage visible in the logs from the moment the
    // app starts, even before any password is touched.
    if (!safeStorage.isEncryptionAvailable()) {
      logger.error('SECRET_STORAGE_UNAVAILABLE');
    }

    // Loading here is diagnostic only (logs the outcome); the settings IPC
    // handlers below load settings fresh on every call rather than sharing
    // this result, since nothing here mutates or caches the document.
    const settingsLoadOutcome = await loadSettings(appPaths.settings);
    if (settingsLoadOutcome.ok) {
      logger.info(
        settingsLoadOutcome.value.status === 'migrated' ? 'SETTINGS_MIGRATED' : 'SETTINGS_LOADED',
      );
    } else {
      logger.error('SETTINGS_FILE_CORRUPT');
    }

    const mainWindow = createMainWindow();

    // The single persistent AEM session (requirements-decisions.md section
    // 3) - created once, for the app's lifetime, and handed to the browser
    // controller below. Certificate-error/login policy is wired inside
    // `createAemSession` itself; nothing here duplicates it.
    const aemSession = createAemSession();

    const browserController = createBrowserController({
      settingsDir: appPaths.settings,
      secretStore,
      logger,
      aemSession,
      window: mainWindow,
      aemPreloadPath,
      rendererWebContents: mainWindow.webContents,
    });

    // Re-applies every persisted TLS exception to the live session before
    // anything can navigate the AEM view - a certificate approved in a
    // previous run must not re-trigger the blocked-certificate prompt on the
    // very first load after restart.
    await browserController.hydrateCertificateExceptions();

    // The shell window is trusted from the start. Settings, previously its
    // own child window, now lives as a panel inside the shell itself, so
    // this stays the one and only trusted web contents id for the app's
    // lifetime.
    const trustedWindows = createTrustedWindowRegistry([mainWindow.webContents.id]);

    // Decided once, from the exact same pure function `selectAgentService`
    // calls internally with the same `env`/`isPackaged` - so the client
    // constructed here and the adapter `selectAgentService` builds always
    // agree on which path was taken. Constructing the client is cheap and
    // synchronous; *starting* it (`client.start()`, several seconds on the
    // real path) is not, and - together with `agentService.initialize()` -
    // must never sit on this synchronous critical path. Both now run inside
    // `startAgentServiceInBackground`, kicked off below without being
    // awaited.
    //
    // Declared up here, rather than beside the rest of the agent wiring
    // below, only because `registerSettingsIpcHandlers`' step-09 model
    // channels close over it: a `const` referenced by a closure that runs
    // before its declaration would be a temporal-dead-zone error, and the
    // ordering that currently prevents that (no `await` in between) is too
    // easy to break by accident.
    const useFakeAgentService = shouldUseFakeAgentService(process.env, app.isPackaged);
    const copilotClient = useFakeAgentService ? undefined : createHardenedCopilotClient();

    // Seeded from the settings load above so the first prompt after launch
    // already uses the stored model, with no disk read on the send path. See
    // `createModelPreferenceCache`'s doc comment. A corrupt settings file
    // yields "no preference", which is the same as a fresh install - never a
    // guessed model.
    const storedSettings = settingsLoadOutcome.ok ? settingsLoadOutcome.value.settings : undefined;
    const modelPreferenceCache = createModelPreferenceCache({
      model: storedSettings?.defaultModel ?? null,
      reasoningEffort: storedSettings?.defaultReasoningEffort ?? null,
    });

    // The `agent-chat:*` IPC handlers are registered against this
    // placeholder immediately, before any real `AgentService` exists: a
    // renderer `invoke` against an *unregistered* channel throws a raw
    // "No handler registered" error, a strictly worse failure mode than the
    // honest, typed `serviceState: "starting"` this placeholder answers
    // with instead. See `createStartupGatedAgentChatController`'s own doc
    // comment (`agentChatController.ts`). Declared here for the same
    // ordering reason as `copilotClient` above.
    const agentChatController = createStartupGatedAgentChatController();

    registerSettingsIpcHandlers({
      settingsDir: appPaths.settings,
      secretStore,
      logger,
      rendererDistDir,
      isTrustedWebContentsId: (id) => trustedWindows.has(id),
      modelSelection: {
        // Resolved per call, not captured: the Copilot client is started in
        // the background well after this registration runs, so an early
        // Settings open legitimately finds no catalogue and must say so
        // rather than fail (see `getModelSelection`).
        loadCatalog: async () => {
          // The fake agent never starts a Copilot runtime, so there is no
          // catalogue to read; a fixed one keeps the section exercisable.
          // Unreachable when packaged - see `shouldUseFakeAgentService`.
          if (useFakeAgentService) return ok(fakeModelCatalog());
          return copilotClient === undefined
            ? err({
                message: 'Copilot is still starting. Reopen Settings in a moment.',
              })
            : loadModelCatalog(copilotClient);
        },
        // Step 09's "disable changes during an active turn". Read through the
        // gated controller so it answers honestly ("starting", hence not in a
        // turn) before the real controller exists.
        isTurnInFlight: () => isModelSelectionLocked(agentChatController.getStatus().sessionState),
        onPreferencesSaved: (preference) => modelPreferenceCache.set(preference),
      },
    });

    registerBrowserIpcHandlers({
      controller: browserController,
      logger,
      rendererDistDir,
      mainWebContentsId: mainWindow.webContents.id,
    });

    // --- AEM tool / agent chat wiring (implementation-plan.md step 07) ---
    //
    // Order matters: the bridge transport/broker must exist before the
    // `aem_get_json` executor can be built (it closes over the broker), the
    // executor must exist before it can be registered in `toolHandlers`
    // (needed to construct either `AgentService` adapter), and the chat
    // controller needs a constructed `AgentService`. The tool executor's
    // own `currentContext` is late-bound (`createLateBoundAemToolContext`)
    // specifically to break that last cycle: the executor is built before
    // the chat controller exists, but only ever *called* once a real chat
    // turn is in flight, by which point `bind` below has already run.
    const aemBridgeTransport = createAemBridgeTransport({
      aemWebContents: () => browserController.aemView.webContents,
    });
    const aemBridgeBroker = createAemBridgeBroker({
      transport: aemBridgeTransport,
      clock: Date.now,
      setTimer: (fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        return () => clearTimeout(timer);
      },
      currentContext: createBridgeCurrentContext(
        () => browserController.activeServer(),
        () => browserController.navigationEpoch.current(),
      ),
    });

    const lateBoundAemToolContext = createLateBoundAemToolContext();
    const aemGetJsonExecutor = createAemGetJsonExecutor({
      execute: createBrokeredExecute(aemBridgeBroker),
      runtimeDeps: { now: Date.now },
      currentContext: lateBoundAemToolContext.currentContext,
      clock: Date.now,
      idGenerator: randomUUID,
    });
    const aemQueryExecutor = createAemQueryExecutor({
      execute: createBrokeredQueryExecute(aemBridgeBroker),
      runtimeDeps: { now: Date.now },
      currentContext: lateBoundAemToolContext.currentContext,
      clock: Date.now,
      idGenerator: randomUUID,
    });
    const bundledSkillsDirectory = resolveBundledSkillsDirectory({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDir: currentDir,
      join: (...segments) => path.join(...segments),
    });

    // Decided once, from the exact same pure function `selectAgentService`
    // calls internally with the same `env`/`isPackaged` - so the client
    // constructed here and the adapter `selectAgentService` builds always
    // agree on which path was taken. See the declaration above.
    lateBoundAemToolContext.bind(agentChatController);

    const unregisterAgentChatIpc = registerAgentChatIpcHandlers({
      controller: agentChatController,
      logger,
      rendererDistDir,
      mainWebContentsId: mainWindow.webContents.id,
      rendererWebContents: mainWindow.webContents,
    });

    // Milestone A criterion 6: a server switch (or any other navigation-
    // epoch-bumping event - document navigation, render-process-gone, view
    // destroyed) cancels whatever AEM tool call/turn is in flight, the same
    // way pressing Stop does. Safe to wire against the placeholder right
    // away: `handleAemContextInvalidated` is a no-op until the real
    // controller is bound in, since there is by construction no turn yet to
    // cancel.
    const unwireNavigationEpochCancellation = wireNavigationEpochCancellation(
      browserController.navigationEpoch,
      agentChatController,
      logger,
    );

    mainWindow.on('closed', () => {
      unwireNavigationEpochCancellation();
      unregisterAgentChatIpc();
      void agentChatController.dispose();
      aemBridgeBroker.dispose();
      aemBridgeTransport.dispose();
      browserController.destroy();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });

    // Everything above is already fully wired and interactive - nothing the
    // user can see or click depends on the Copilot runtime. Only now does
    // startup touch it, and never by blocking anything else on it:
    // `registerNonAgentHandlers` runs synchronously first, then
    // `startAgentServiceInBackground` (`copilotClient.start()` +
    // `agentService.initialize()`) runs in the background - `startAppRuntime`
    // never awaits it. A startup failure there (Copilot CLI missing, corrupt
    // install, `initialize()` itself rejecting, ...) is logged loudly
    // instead of leaving a silently half-wired app or an unhandled
    // rejection; see `startAppRuntime`'s own doc comment in
    // `agentComposition.ts`.
    startAppRuntime({
      registerNonAgentHandlers: () => {
        // No non-agent handler was removed with the Settings window's
        // departure: every surface the separate window used (`settings:*`,
        // `agent:*`) is still served from the shell, so nothing needs
        // registering here beyond the always-present IPC sets above.
        return;
      },
      startAgentService: () =>
        startAgentServiceInBackground({
          copilotClient,
          buildAgentService: () =>
            selectAgentService({
              env: process.env,
              isPackaged: app.isPackaged,
              logger,
              createFakeService: () => {
                const fakeService = createFakeAgentService();
                // Test-only: see `exposeFakeAgentServiceForTests`'s doc
                // comment in `agentComposition.ts`. Reachable only because
                // this factory itself only runs when
                // `shouldUseFakeAgentService(env, isPackaged)` is true.
                exposeFakeAgentServiceForTests(fakeService);
                return fakeService;
              },
              createRealService: () => {
                if (copilotClient === undefined) {
                  // Unreachable: this factory only runs when
                  // `shouldUseFakeAgentService` returned false for
                  // `selectAgentService`'s own `(env, isPackaged)` - the
                  // same inputs `useFakeAgentService` above was computed
                  // from - so `copilotClient` was necessarily constructed
                  // above.
                  throw new Error(
                    'Internal error: real agent service selected without a Copilot client.',
                  );
                }
                return createSdkAgentService({
                  client: copilotClient,
                  policy: buildAemToolPolicy([bundledSkillsDirectory]),
                  authSource: copilotClient,
                  toolHandlers: {
                    [AEM_GET_JSON_TOOL_NAME]: aemGetJsonExecutor,
                    [AEM_QUERY_TOOL_NAME]: aemQueryExecutor,
                  },
                  // Step 09: read from the cache below on every use, so a
                  // model chosen in Settings reaches the next prompt without
                  // a restart. Deliberately synchronous - `sendPrompt` must
                  // not wait on a disk read before every turn - which is why
                  // the settings file is not consulted directly here.
                  modelPreferences: () => modelPreferenceCache.current(),
                });
              },
            }),
          logger,
          idGenerator: randomUUID,
          currentAemServerContext: createCurrentAemServerContext(() =>
            browserController.activeServer(),
          ),
          navigationEpoch: () => browserController.navigationEpoch.current(),
          gatedController: agentChatController,
        }),
      // No free-text field exists on `Logger` by design (see its own module
      // doc comment): `COPILOT_UNAVAILABLE` is already the closed-vocabulary
      // code for exactly this failure ("the Copilot runtime ... is
      // unusable"), so the rejection reason itself is deliberately not
      // forwarded anywhere near the log.
      onAgentServiceStartupFailed: () => {
        logger.error('COPILOT_UNAVAILABLE');
      },
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
