import { app, BrowserWindow, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAppDirectories, getOsHomeDirectory, resolveAppPaths } from './appPaths';
import { mergeDisabledFeatures } from './disabledFeatures';
import { registerAgentAuthHandlers } from './ipc/agent';
import { registerAgentChatIpcHandlers } from './ipc/agentChat';
import { registerAppInfoHandler } from './ipc/app-info';
import { registerBrowserIpcHandlers } from './ipc/browser';
import { registerSettingsIpcHandlers } from './ipc/settings';
import { createTrustedWindowRegistry } from './ipc/trustedWindows';
import { createLogger } from './logger';
import { createSecretStore } from './secretStore';
import { loadSettings, loadSettingsSync, configuredAgentId } from './settingsStore';
import { installContentSecurityPolicy } from './csp';
import { installWebContentsSecurityGuard } from './security';
import { createAemSession } from './aem';
import { createAemBridgeBroker } from './aem/bridgeBroker';
import { createAemBridgeTransport } from './aem/bridgeTransport';
import { installAppProtocolHandler, registerAppProtocolPrivileges } from './browser/appProtocol';
import { createBrowserController } from './browser/browserController';
import { APP_USER_MODEL_ID, createMainWindow } from './windows';
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
import {
  createHardenedCopilotClient,
  loadModelCatalog,
  toAuthStatus,
  type CopilotClient,
} from '../agent';
import { createCopilotRuntimeManager, type CopilotRuntimeManager } from './copilotRuntimeManager';
import { resolveAgentGithubToken, resolveAgentProxyOverrides } from './agentRuntimeProxy';
import {
  createAemGetJsonExecutor,
  createAemQueryExecutor,
  AEM_GET_JSON_TOOL_NAME,
  AEM_QUERY_TOOL_NAME,
  buildAemToolPolicy,
} from '../agent/aemTool';
import { createSdkAgentService } from '../agent/sdkAgentService';
import {
  createFakeAgentService,
  DEFAULT_FAKE_AUTH_STATE,
  type FakeAgentService,
} from '../agent/fakeAgentService';
import { err, ok, type ModelCatalogEntry, type Result } from '../shared';

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

// Windows taskbar identity. Without this an unpackaged (dev/e2e) run has no
// AppUserModelID, so Windows groups the app under the generic `electron.exe`
// identity and its taskbar jump-list/context menu shows Electron's icon.
// Must match electron-builder.yml's `appId`, which registers the installed
// build's shortcut under the same identity - so installed and dev runs are one
// taskbar entry, not two. Set before any window is created.
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// Resolving paths is pure (os.homedir + path.join): it performs no filesystem
// access, so it is safe to do before this process owns the single-instance
// lock. Creating the directories is NOT, and stays below the lock check.
const appPaths = resolveAppPaths(getOsHomeDirectory());

// By default Chromium on Windows forwards WebAuthn/FIDO2 requests to the
// native Windows WebAuthn API, which raises the "Windows Security" security-key
// dialog. Adobe's IMS login page (and other IdPs) fire a WebAuthn call as part
// of signing in, so simply reaching the AEM login page and pressing "Sign in
// with Adobe" makes that dialog appear - labelled "unverified app" because the
// calling process is an unsigned `electron.exe`. Electron has no in-app
// WebAuthn UI and offers no per-session switch, so the native-API path is
// disabled process-wide: Chromium then handles the request itself and, with no
// platform authenticator, the call simply fails, which the IdP page tolerates.
//
// Gated by the Settings "Browser" tab (`browser.disableNativeWebAuthn`, default
// true). Chromium reads its feature switches once, before `whenReady()`, so the
// persisted flag is read synchronously here and a change takes effect on the
// next launch. A missing/corrupt file yields defaults (suppress).
const startupSettings = loadSettingsSync(appPaths.settings);
if (startupSettings.browser.disableNativeWebAuthn) {
  app.commandLine.appendSwitch(
    'disable-features',
    mergeDisabledFeatures(
      app.commandLine.getSwitchValue('disable-features'),
      'WebAuthenticationUseNativeWinApi',
    ),
  );
}

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
    // `runtimeManager` is assigned further below, once the AEM tool executors
    // and skill directory it (and the chat runtime) needs exist. These three
    // closures only ever run on a user action - an auth-status poll or a
    // sign-in click - long after this synchronous block has finished, so
    // reading it lazily here is safe and is what lets the auth handlers and
    // the chat surface share a single client.
    // Decided once, here, from the exact same `(env, isPackaged)` inputs
    // `selectAgentService` uses internally - so the auth surface below and the
    // agent service it must agree with can never disagree about whether the
    // deterministic fake is in use. Reused further down for the runtime
    // manager and the model catalogue.
    const useFakeAgentService = shouldUseFakeAgentService(process.env, app.isPackaged);

    registerAgentAuthHandlers({
      getClient: () => runtimeManager?.getClient(),
      refreshRuntime: () => runtimeManager?.refresh() ?? Promise.resolve(),
      // Read fresh, not from the startup snapshot: the user may have changed
      // the active provider's proxy since launch, and sign-in must use the
      // proxy the runtime is *currently* configured with.
      getProxyOverrides: async () => {
        const loaded = await loadSettings(appPaths.settings);
        return loaded.ok
          ? resolveAgentProxyOverrides(loaded.value.settings, secretStore)
          : undefined;
      },
      // In fake mode the fake is the authority on sign-in (see the dependency's
      // own doc comment); omitted entirely on the real path, which is what
      // `exactOptionalPropertyTypes` requires rather than `undefined`. Read
      // through the late-bound service below, falling back to the fake's own
      // documented default for the instant before it exists - never to the real
      // runtime, which fake mode deliberately never uses.
      ...(useFakeAgentService
        ? {
            getFakeAuthStatus: () =>
              fakeAgentService?.getAuthState() ?? { ...DEFAULT_FAKE_AUTH_STATE },
          }
        : {}),
    });

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
      logger.info('SETTINGS_LOADED');
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
    // calls internally with the same `env`/`isPackaged` - so the runtime
    // `copilotRuntimeManager.ts` builds and the adapter `selectAgentService`
    // builds always agree on which path was taken. The client itself is no
    // longer constructed here: it is owned by
    // `createCopilotRuntimeManager`, which also recycles it when the active
    // provider or its proxy changes. Starting it (`client.start()`, several
    // seconds on the real path) - together with `agentService.initialize()` -
    // must never sit on this synchronous critical path; both run inside
    // `startAgentServiceInBackground`, kicked off below without being awaited.
    // (`useFakeAgentService` itself was decided above, next to the auth
    // handlers that must agree with it.)

    // Seeded from the settings load above so the first prompt after launch
    // already uses the stored model, with no disk read on the send path. See
    // `createModelPreferenceCache`'s doc comment. A corrupt settings file
    // yields "no preference", which is the same as a fresh install - never a
    // guessed model. Read from the *configured* provider's node: the model is
    // now per-provider, not a single global default.
    const storedSettings = settingsLoadOutcome.ok ? settingsLoadOutcome.value.settings : undefined;
    const storedAgent =
      storedSettings === undefined
        ? undefined
        : storedSettings.agents[configuredAgentId(storedSettings)];
    const modelPreferenceCache = createModelPreferenceCache({
      model: storedAgent?.model ?? null,
      reasoningEffort: storedAgent?.reasoningEffort ?? null,
    });

    // The `agent-chat:*` IPC handlers are registered against this
    // placeholder immediately, before any real `AgentService` exists: a
    // renderer `invoke` against an *unregistered* channel throws a raw
    // "No handler registered" error, a strictly worse failure mode than the
    // honest, typed `serviceState: "starting"` this placeholder answers
    // with instead. See `createStartupGatedAgentChatController`'s own doc
    // comment (`agentChatController.ts`). Declared here for the same
    // ordering reason as the model cache above.
    const agentChatController = createStartupGatedAgentChatController();

    // Assigned once the AEM tool executors and skill directory below exist -
    // `startRuntime` closes over all three. Every reader (`loadCatalog`,
    // `onAgentSettingsSaved`) looks it up lazily through this `let`, since
    // those closures only ever run after a user action, long after this
    // synchronous block has finished. Explicitly `undefined` until then: the
    // window created above can load and poll `agent:get-auth-status` before
    // this assignment runs, and that read must answer "still starting" rather
    // than throw.
    let runtimeManager: CopilotRuntimeManager | undefined = undefined;

    // The deterministic fake service, once `startRuntime` has built it. Same
    // late-binding reason as `runtimeManager`: `agent:get-auth-status` must
    // answer from the fake as soon as it exists, and the renderer can poll it
    // before this block has finished. Always `undefined` on the real path.
    let fakeAgentService: FakeAgentService | undefined = undefined;

    // Resolved per call, not captured: the Copilot client is started - and on
    // a proxy change, restarted - well after this registration runs. A read
    // waits for that (re)install via `whenReady()` and then reads whatever
    // client is current, so an early Settings open waits for the runtime
    // rather than reporting a catalogue failure; a genuinely unreadable
    // catalogue still comes back as `err` and is reported honestly (see
    // `getModelSelection`). Shared by the step-09 model channels and the
    // agents channel: both read the one catalogue.
    const loadCatalog = async (): Promise<
      Result<readonly ModelCatalogEntry[], { readonly message: string }>
    > => {
      // The fake agent never starts a Copilot runtime, so there is no
      // catalogue to read; a fixed one keeps the section exercisable.
      // Unreachable when packaged - see `shouldUseFakeAgentService`.
      if (useFakeAgentService) return ok(fakeModelCatalog());
      if (runtimeManager === undefined) {
        return err({
          message: 'Copilot is still starting. Reopen Settings in a moment.',
        });
      }
      // Wait out an in-flight (re)install before reading. A proxy change
      // recycles the runtime, and reading the freshly-created client before
      // its `start()` has resolved fails the catalogue even though the runtime
      // is seconds from being usable - which is what made a proxy switch show
      // a spurious "could not retrieve the list of models" instead of the new
      // runtime's catalogue. `whenReady()` never rejects, so a failed install
      // still reaches the honest `loadModelCatalog` failure below.
      await runtimeManager.whenReady();
      return loadModelCatalog(runtimeManager.getClient());
    };
    // Step 09's "disable changes during an active turn". Read through the
    // gated controller so it answers honestly ("starting", hence not in a
    // turn) before the real controller exists.
    const isTurnInFlight = (): boolean =>
      isModelSelectionLocked(agentChatController.getStatus().sessionState);

    // Recycles the Copilot runtime after a stored personal-access token has
    // been set or cleared. The settings document is reloaded rather than
    // reusing the captured one, because the *first* token set mints its
    // `secretRef` into settings.json - the captured document would still
    // describe no token, and `resolveAgentGithubToken` would find none. A
    // failed reload falls back to the last-known document, which still names
    // the same `secretRef`; the token's plaintext is re-read from the secret
    // store either way.
    const refreshRuntimeAfterTokenChange = async (): Promise<void> => {
      const loaded = await loadSettings(appPaths.settings);
      await (loaded.ok
        ? runtimeManager?.refresh(loaded.value.settings)
        : runtimeManager?.refresh());
    };

    registerSettingsIpcHandlers({
      settingsDir: appPaths.settings,
      secretStore,
      logger,
      rendererDistDir,
      isTrustedWebContentsId: (id) => trustedWindows.has(id),
      modelSelection: {
        loadCatalog,
        isTurnInFlight,
        onPreferencesSaved: (preference) => modelPreferenceCache.set(preference),
      },
      agentSettings: {
        loadCatalog,
        isTurnInFlight,
        // Recycles the runtime only when the change actually shapes it (the
        // active provider or its proxy) - a model/effort change is told to
        // the runtime at prompt time instead. See `copilotRuntimeManager.ts`.
        onAgentSettingsSaved: (settings) => {
          void runtimeManager?.reconcile(settings).catch(() => logger.error('COPILOT_UNAVAILABLE'));
        },
      },
      // A stored token is a runtime credential (handed over as
      // `COPILOT_GITHUB_TOKEN`), so setting or clearing one has to recycle the
      // runtime - the running process resolved its old credential at start.
      // Skipped in fake mode: no chat runtime consumes the token there, and
      // recycling would discard the deterministic fake's state (see
      // `recycleOnSettingsChange` in `copilotRuntimeManager.ts`).
      onAgentTokenChanged: () => {
        if (useFakeAgentService) return;
        void refreshRuntimeAfterTokenChange().catch(() => logger.error('COPILOT_UNAVAILABLE'));
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

    // `startRuntime` is the one startup/restart path, reused for the first
    // start and for every recycle. It takes the client as a parameter
    // (rather than closing over one) precisely because a recycle replaces
    // it; everything else about it - executor wiring, skill directory,
    // ordering of `client.start()` before `agentService.initialize()` before
    // `replaceDelegate` - is identical either way, and lives in
    // `startAgentServiceInBackground`.
    const startRuntime = (client: CopilotClient | undefined): Promise<void> =>
      startAgentServiceInBackground({
        // The fake path must not spawn a real runtime for chat: the client is
        // still created (auth uses it), but only `agent:*` starts it, lazily.
        copilotClient: useFakeAgentService ? undefined : client,
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
              // Published for `agent:get-auth-status` (see the dependency's
              // doc comment at the auth registration above).
              fakeAgentService = fakeService;
              return fakeService;
            },
            createRealService: () => {
              if (client === undefined) {
                // Unreachable: this factory only runs when
                // `shouldUseFakeAgentService` returned false for
                // `selectAgentService`'s own `(env, isPackaged)` - the
                // same inputs `useFakeAgentService` above was computed
                // from - so a client was necessarily constructed by
                // `createClient` below.
                throw new Error(
                  'Internal error: real agent service selected without a Copilot client.',
                );
              }
              return createSdkAgentService({
                client,
                policy: buildAemToolPolicy([bundledSkillsDirectory]),
                // The SDK's raw `auth.getStatus` response carries no
                // `apiVersion`; `toAuthStatus` projects it onto this app's
                // `AuthStatus` DTO. Passing the bare `client` here (whose
                // `getAuthStatus()` returns the raw shape) made every real
                // `initialize()` fail its `apiVersion` validation.
                authSource: {
                  getAuthStatus: async () => toAuthStatus(await client.getAuthStatus()),
                },
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
      });

    runtimeManager = createCopilotRuntimeManager({
      recycleOnSettingsChange: !useFakeAgentService,
      startRuntime,
      // The runtime resolves its active credential inside its own process, so
      // a still-running one reports stale auth after the active account
      // changes - and it would keep using the old proxy regardless. Recycled
      // clients are therefore always stopped, never left running; already
      // exited is the normal case and is not an error.
      stopClient: async (client) => {
        try {
          await client.stop();
        } catch {
          // Already exited or never started - nothing to clean up.
        }
      },
      createClient: ({ proxy, githubToken }) =>
        createHardenedCopilotClient({
          ...(proxy !== undefined ? { proxy } : {}),
          ...(githubToken !== undefined ? { githubToken } : {}),
        }),
      // A rejection here (secret storage unavailable, ...) aborts the recycle
      // *before* the working runtime is touched - see the manager's own doc
      // comment - so the user keeps a functioning (if stale) runtime rather
      // than none.
      resolveProxyOverrides: (settings) => resolveAgentProxyOverrides(settings, secretStore),
      // The stored personal-access token, handed to the runtime as
      // `COPILOT_GITHUB_TOKEN` (the one supported path; ambient tokens stay
      // stripped - see `buildRuntimeChildEnv`). `undefined` leaves the runtime
      // to interactive sign-in.
      resolveGithubToken: (settings) => resolveAgentGithubToken(settings, secretStore),
    });

    // Everything above is already fully wired and interactive - nothing the
    // user can see or click depends on the Copilot runtime. Only now does
    // startup touch it, and never by blocking anything else on it:
    // `registerNonAgentHandlers` runs synchronously first, then
    // `startAgentServiceInBackground` (`client.start()` +
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
      startAgentService: () => runtimeManager.start(storedSettings),
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
