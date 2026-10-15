import { app, BrowserWindow, Menu, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AppSettings,
  type AuthStatus,
  err,
  renderSkillCatalogue,
  resolveSkillPrompt,
} from '../shared';
import { createAemSession } from './aem';
import { createAemBridgeBroker } from './aem/bridgeBroker';
import { createAemBridgeTransport } from './aem/bridgeTransport';
import { createToolHttpLogger } from './aem/toolHttpLog';
import { createStartupGatedAgentChatController } from './agentChatController';
import {
  createBridgeCurrentContext,
  createConfiguredHosts,
  createCurrentAemServerContext,
  createCurrentPageContext,
  createDeferredRuntimeRecycler,
  createEnvironmentFacts,
  createLateBoundAemToolContext,
  createLateBoundToolProgress,
  createLateBoundUserInput,
  createModelPreferenceCache,
  installAgentService,
  isAgentTurnInFlight,
  resolveBundledResourcesDirectory,
  runAfterFrameLoad,
  shouldUseFakeAgentService,
  startAppRuntime,
  wireNavigationEpochCancellation,
} from './agentComposition';
import { discoverAgentCatalog } from './agents/catalog';
import { resolveConnection } from './agents/connection';
import { createAgentHub, type AgentHub } from './agents/hub';
import { buildProxyFetch } from './agents/proxyFetch';
import { buildAgentRegistry, discoverAgentLoaders } from './agents/registry';
import { ensureAppDirectories, getOsHomeDirectory, resolveAppPaths } from './appPaths';
import { installAppProtocolHandler, registerAppProtocolPrivileges } from './browser/appProtocol';
import { createBrowserController } from './browser/browserController';
import { listChatHistory, removeChatJournal } from './chatHistory';
import { createChatJournal } from './chatJournal';
import { toChatFileName } from './chatJournalPaths';
import {
  readChatJournal,
  readChatSessionIds,
  type ChatJournalReadFailureReason,
} from './chatJournalReader';
import { installContentSecurityPolicy } from './csp';
import { mergeDisabledFeatures } from './disabledFeatures';
import { loadInstructionResources } from './instructions/instructionResources';
import { registerAgentAuthHandlers } from './ipc/agent';
import { registerAgentChatIpcHandlers } from './ipc/agentChat';
import { registerAppInfoHandler } from './ipc/app-info';
import { registerBrowserIpcHandlers } from './ipc/browser';
import { registerSettingsIpcHandlers } from './ipc/settings';
import { registerTableExportIpcHandlers } from './ipc/tableExport';
import { createTrustedWindowRegistry } from './ipc/trustedWindows';
import { createLogger } from './logger';
import { createSecretStore } from './secretStore';
import { installWebContentsSecurityGuard } from './security';
import { configuredAgentId, loadSettings, loadSettingsSync } from './settingsStore';
import { createSkillCatalog } from './skills/skillCatalog';
import { buildToolRegistry, discoverToolLoaders } from './tools/registry';
import { APP_USER_MODEL_ID, createMainWindow, getAppIconPath } from './windows';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDistDir = path.join(currentDir, '../renderer');
const aemPreloadPath = path.join(currentDir, '../preload/aem-preload.js');
const isDev = Boolean(process.env['ELECTRON_RENDERER_URL']);

/**
 * User-facing text for a failed journal read. A missing file is `NOT_FOUND`
 * (there simply is no stored transcript); every other reason is a storage fault
 * on a file that should be readable. Never echoes a path or filesystem error.
 */
function describeJournalReadFailure(reason: ChatJournalReadFailureReason): {
  readonly code: 'NOT_FOUND' | 'STORAGE_ERROR';
  readonly message: string;
} {
  switch (reason) {
    case 'not_found':
      return { code: 'NOT_FOUND', message: 'No stored transcript was found for this chat' };
    case 'invalid_chat_id':
      return { code: 'STORAGE_ERROR', message: 'The stored chat id is not usable' };
    case 'too_large':
      return { code: 'STORAGE_ERROR', message: 'The stored transcript is too large to reopen' };
    case 'unreadable':
      return { code: 'STORAGE_ERROR', message: 'The stored transcript could not be read' };
  }
}

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
    // macOS ignores the BrowserWindow `icon` option; the Dock shows the
    // bundle's icon. A packaged build has ours (electron-builder.yml
    // `mac.icon`), but an unpackaged run is Electron's own bundle, so without
    // this the Dock shows Electron's icon.
    if (process.platform === 'darwin' && !app.isPackaged) {
      const appIconPath = getAppIconPath();
      if (appIconPath) {
        app.dock?.setIcon(appIconPath);
      }
    }
    installContentSecurityPolicy(isDev);
    installWebContentsSecurityGuard(rendererDistDir);
    installAppProtocolHandler(rendererDistDir);
    registerAppInfoHandler();
    // Which agents this build contains: the eager glob of `src/agents/*/meta.ts`
    // (SDK-free). Read before anything else so the settings and auth surfaces
    // below all agree on the list. A `meta.ts` that is malformed is skipped
    // and reported once the logger exists.
    const agentCatalog = discoverAgentCatalog();
    const agentDefinitions = agentCatalog.definitions;
    // Decided once, from the same inputs everything else uses - so the auth
    // surface and the runtimes it fronts can never disagree about whether the
    // deterministic fake is in use.
    const useFakeAgentService = shouldUseFakeAgentService(process.env, app.isPackaged);

    // Assigned once the tool registry (which an agent's toolkit reads) exists,
    // further below. The window created above can load and poll
    // `agent:get-auth-status` before then; those calls must answer "still
    // starting" rather than hit an unregistered channel or throw.
    let agentHub: AgentHub | undefined = undefined;
    const STARTING: AuthStatus = {
      apiVersion: 1,
      isAuthenticated: false,
      statusMessage: 'The agent is still starting',
    };
    registerAgentAuthHandlers({
      hub: {
        getAuthStatus: async (agentId) => (await agentHub?.getAuthStatus(agentId)) ?? STARTING,
        getAuthPresence: async (agentId) =>
          (await agentHub?.getAuthPresence(agentId)) ?? { present: false },
        login: async (agentId, settings) =>
          (await agentHub?.login(agentId, settings)) ?? {
            status: 'failed',
            message: 'The agent is still starting',
          },
        cancelLogin: (agentId) => agentHub?.cancelLogin(agentId),
        logout: async (agentId) =>
          (await agentHub?.logout(agentId)) ?? {
            apiVersion: 1,
            warning: 'The agent is still starting',
          },
      },
      // Read fresh, not from the startup snapshot: the user may have changed
      // the agent's proxy since launch, and sign-in must use the proxy the
      // runtime is *currently* configured with.
      loadSettings: async () => {
        const loaded = await loadSettings(appPaths.settings);
        return loaded.ok ? loaded.value.settings : undefined;
      },
    });

    // Step 04: diagnostics-only logger, and the OS-backed secret store for
    // app-managed passwords. `safeStorage` (Electron's real DPAPI
    // wrapper on Windows) is injected as the store's `SecretCipher` here -
    // the only place this app is allowed to construct one - so
    // `secretStore.ts` itself stays Electron-free and unit-testable. The
    // secrets directory is a subdirectory of the existing `settings` path,
    // not a new top-level directory alongside `appPaths`'s fixed six.
    const logger = createLogger(appPaths.logs);
    // The tool HTTP log (`logs/tools.log`): the full request URL and the
    // request/response headers for every AEM bridge round trip. Deliberately a
    // separate file from `app.log`, whose logger cannot carry free-form text -
    // see `aem/toolHttpLog.ts` for why the diagnostic need justifies the split.
    const toolLogger = createToolHttpLogger(appPaths.logs);
    // The append-only chat journal (implementation-plan.md step 09): one JSON
    // Lines file per chat under `<home>/etoolbox-daisy/chats`. Owned here for
    // the app's lifetime, not by a controller - an agent runtime recycles
    // (replacing the controller) while the same journal keeps appending.
    const chatJournal = createChatJournal(appPaths.chats, {
      // The journal holds the detail; app.log gets one typed line per turn so a
      // slow or failed turn is visible without opening the chat file. Only
      // durations, a count and an outcome - the logger carries no free text.
      onTurnSummary: (summary) =>
        logger.info('AGENT_TURN_SUMMARY', {
          durationMs: summary.durationMs,
          count: summary.toolCallCount,
          outcome:
            summary.outcome === 'completed'
              ? 'success'
              : summary.outcome === 'interrupted'
                ? 'cancelled'
                : 'failure',
          ids: { chatId: summary.chatId, turnId: summary.turnId },
        }),
    });
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

    // The app is a two-pane tool with its own in-window toolbar, so there is no
    // native menu bar: Electron's default File/Edit/View/Window/Help menu is
    // removed process-wide before the first window exists. Clipboard actions a
    // user would otherwise reach through that menu (and the rest of the
    // right-click affordances) are provided by `contextMenu.ts` instead.
    Menu.setApplicationMenu(null);

    const mainWindow = createMainWindow({ windowStateFilePath: appPaths.windowState });

    // The single persistent AEM session (requirements-decisions.md section
    // 3) - created once, for the app's lifetime, and handed to the browser
    // controller below. Certificate-error/login policy is wired inside
    // `createAemSession` itself; nothing here duplicates it.
    const aemSession = createAemSession({ logger });

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

    // Seeded from the settings load above so the first prompt after launch
    // already uses the stored model, with no disk read on the send path. See
    // `createModelPreferenceCache`'s doc comment. A corrupt settings file
    // yields "no preference", which is the same as a fresh install - never a
    // guessed model. Read from the *configured* provider's node: the model is
    // now per-provider, not a single global default.
    const storedSettings = settingsLoadOutcome.ok ? settingsLoadOutcome.value.settings : undefined;
    const storedAgentId =
      storedSettings === undefined
        ? undefined
        : configuredAgentId(storedSettings, agentDefinitions);
    const storedAgent =
      storedSettings === undefined || storedAgentId === undefined
        ? undefined
        : storedSettings.agents[storedAgentId];
    const modelPreferenceCache = createModelPreferenceCache({
      model: storedAgent?.model ?? null,
      reasoningEffort: storedAgent?.reasoningEffort ?? null,
    });
    // Re-seeds the cache from whichever provider `settings` now configures, so
    // the next prompt uses that provider's model rather than the previous one's.
    const seedModelPreference = (settings: AppSettings): void => {
      const agentId = configuredAgentId(settings, agentDefinitions);
      const node = agentId === undefined ? undefined : settings.agents[agentId];
      modelPreferenceCache.set({
        model: node?.model ?? null,
        reasoningEffort: node?.reasoningEffort ?? null,
      });
    };

    // The `agent-chat:*` IPC handlers are registered against this
    // placeholder immediately, before any real `AgentService` exists: a
    // renderer `invoke` against an *unregistered* channel throws a raw
    // "No handler registered" error, a strictly worse failure mode than the
    // honest, typed `serviceState: "starting"` this placeholder answers
    // with instead. See `createStartupGatedAgentChatController`'s own doc
    // comment (`agentChatController.ts`). Declared here for the same
    // ordering reason as the model cache above.
    const agentChatController = createStartupGatedAgentChatController({
      // Applies any deferred runtime recycle before the next prompt is
      // dispatched, so "a change made mid-turn takes effect on the next turn"
      // is exact rather than best-effort.
      beforeSendMessage: () => runtimeRecycler.drain(),
    });

    // Resolved per call: the agent's runtime is started - and on a proxy change,
    // restarted - well after this registration runs. The hub waits for that
    // (re)install and reads the configured agent's catalogue, so an early
    // Settings open waits for the runtime rather than reporting a failure; a
    // genuinely unreadable catalogue still comes back as `err` and is reported
    // honestly (see `getModelSelection`). Shared by the step-09 model channels
    // and the agents channel: both read the one catalogue.
    const loadCatalog = async () => {
      if (agentHub === undefined) {
        return err({ message: 'The agent is still starting. Reopen Settings in a moment' });
      }
      await agentHub.whenReady();
      return agentHub.loadModelCatalog();
    };

    // Whether a chat turn is in flight, read through the gated controller so it
    // answers honestly ("starting", hence not in a turn) before the real one
    // exists.
    const isTurnInFlight = (): boolean =>
      isAgentTurnInFlight(agentChatController.getStatus().sessionState);

    // A proxy, token or active-provider change shapes the child runtime, which
    // can only be applied by stopping the process serving the live turn, so its
    // recycle is deferred while a turn is in flight and applied on the next
    // turn - see `agentComposition.ts`. Model/effort changes never reach here:
    // they are applied at prompt time from the preference cache.
    const runtimeRecycler = createDeferredRuntimeRecycler({
      isTurnInFlight,
      onError: () => logger.error('AGENT_UNAVAILABLE'),
    });

    // Apply any deferred recycle the moment the turn settles. Idempotent and
    // cheap when nothing is queued or a turn is still in flight.
    agentChatController.onEvent(() => {
      void runtimeRecycler.drain();
    });

    // Recycles the configured agent's runtime after a stored personal-access
    // token has been set or cleared. The settings document is reloaded rather
    // than reusing the captured one, because the *first* token set mints its
    // `secretRef` into settings.json - the captured document would still
    // describe no token. A failed reload falls back to the hub's last-known
    // document, which still names the same `secretRef`; the token's plaintext is
    // re-read from the secret store either way.
    //
    // Clearing a token may also have switched the configured provider off - the
    // settings write itself deactivates a provider whose only credential was
    // that token (see `clearAgentTokenSecret`). `reconcile` therefore applies
    // whichever provider the reloaded document now configures.
    const refreshRuntimeAfterTokenChange = async (): Promise<void> => {
      const hub = agentHub;
      if (hub === undefined) return;
      const loaded = await loadSettings(appPaths.settings);
      if (!loaded.ok) {
        await hub.refresh();
        return;
      }
      await hub.reconcile(loaded.value.settings);
    };

    registerSettingsIpcHandlers({
      settingsDir: appPaths.settings,
      secretStore,
      logger,
      rendererDistDir,
      isTrustedWebContentsId: (id) => trustedWindows.has(id),
      agentDefinitions,
      modelSelection: {
        definitions: agentDefinitions,
        loadCatalog,
        onPreferencesSaved: (preference) => modelPreferenceCache.set(preference),
      },
      agentSettings: {
        definitions: agentDefinitions,
        loadCatalog,
        // Recycles the runtime only when the change actually shapes it (the
        // active provider or its proxy) - a model/effort change is told to
        // the runtime at prompt time instead. See the agent's `runtimeManager`.
        // The recycle is deferred while a turn is in flight by `runtimeRecycler`
        // so a mid-turn change never tears down the live turn: the write is
        // persisted and applied on the next turn. Awaited by the handler when
        // applied at once, so the renderer's reload reads a ready runtime; a
        // broken runtime is logged and swallowed - the settings write itself
        // already succeeded and must not be reported as failed.
        onAgentSettingsSaved: async (settings) => {
          // An active-provider switch changes which provider's stored model is
          // "the" preference; re-seed the synchronous cache so the next prompt
          // uses the newly active provider's model rather than the previous
          // one's. Model/effort-only changes re-seed to the same value. Applied
          // now, not deferred: the cache is only read when the next prompt
          // starts, which is exactly when a deferred change should take hold.
          seedModelPreference(settings);
          await runtimeRecycler.request(async () => {
            await agentHub?.reconcile(settings);
          });
        },
      },
      // Reads a provider's cheap, non-starting sign-in presence for the
      // token-clear path. Clearing a token deactivates the provider unless an
      // interactive (SSO) session still authenticates it; that is decided from
      // this presence, never by starting the provider's SDK.
      getAgentAuthPresence: async (agentId) =>
        (await agentHub?.getAuthPresence(agentId)) ?? { present: false },
      // A stored token is a runtime credential, so setting or clearing one has
      // to recycle the runtime - the running process resolved its old credential
      // at start. Deferred while a turn is in flight, like a proxy change.
      // Skipped in fake mode: no runtime consumes the token there, and
      // recycling would discard the deterministic fake's state.
      onAgentTokenChanged: () => {
        if (useFakeAgentService) return;
        void runtimeRecycler.request(() => refreshRuntimeAfterTokenChange());
      },
    });

    registerBrowserIpcHandlers({
      controller: browserController,
      logger,
      rendererDistDir,
      mainWebContentsId: mainWindow.webContents.id,
    });

    registerTableExportIpcHandlers({
      parentWindow: mainWindow,
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
      logger,
      toolLogger,
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
    // The `ask_user` tool's interactive-question capability, late-bound to the
    // chat controller for the same reason (see `createLateBoundUserInput`).
    const lateBoundUserInput = createLateBoundUserInput();
    // A long-running tool's progress notes, late-bound to the chat controller
    // for the same construction-order reason (see `createLateBoundToolProgress`).
    const lateBoundToolProgress = createLateBoundToolProgress();
    // The host's content/component roots, resolved from the live pane URL, the
    // current settings document and the host's selected project. Read fresh so
    // a roots/project edit in Settings is visible immediately;
    // `loadSettingsSync` is a small synchronous read.
    const environmentFacts = createEnvironmentFacts(
      () => browserController.currentDocumentUrl(),
      () => loadSettingsSync(appPaths.settings).hosts,
      () => loadSettingsSync(appPaths.settings).projects,
    );
    // The model-facing host catalogue (labels + origins + roots) and the
    // agent's navigation capability. `openPage` resolves the origin from the
    // configured host itself, so no origin reaches the pane from a tool
    // argument.
    const configuredHosts = createConfiguredHosts(
      () => loadSettingsSync(appPaths.settings).hosts,
      () => loadSettingsSync(appPaths.settings).projects,
    );
    // The application's own markdown resources: the model-facing instructions
    // and the bundled skills. Resolved from the install location only. The
    // instruction templates carry the read-only policy, so a missing file
    // rejects here and the application does not start without them.
    const bundledResourcesDirectory = resolveBundledResourcesDirectory({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDir: currentDir,
      join: (...segments) => path.join(...segments),
    });
    const instructionResources = await loadInstructionResources(
      path.join(bundledResourcesDirectory, 'instructions'),
    );
    // Tools are discovered from `src/tools/*/tool.ts`; a tool that fails to
    // load or construct is logged and left out, never fatal.
    const toolRegistry = await buildToolRegistry({
      loaders: discoverToolLoaders(),
      instructionsTemplate: instructionResources.sessionTemplate,
      host: {
        bridge: aemBridgeBroker,
        currentContext: lateBoundAemToolContext.currentContext,
        environmentFacts,
        configuredHosts,
        openPage: (target) => browserController.openForAgent(target),
        requestUserInput: lateBoundUserInput.requestUserInput,
        clock: Date.now,
        idGenerator: randomUUID,
        // Diagnostics only: a tool reports how it classified the response body
        // so `tools.log` records whether the read produced usable data, not just
        // that the HTTP status was a 200.
        recordResponseClassification: (requestId, kind) => {
          toolLogger.classification({ requestId, kind });
        },
        reportToolProgress: (toolCallId, text) => lateBoundToolProgress.report(toolCallId, text),
        // Diagnostics only: a search's background honest count that did not
        // prove an exact total - the table silently keeps its capped fallback.
        reportToolDiagnostic: (code) => {
          logger.info(code);
        },
      },
      onFailure: (failure) => {
        // The logger has no free-text field by design, so the reason goes to stderr.
        console.error(`Tool ${failure.source} was not registered: ${failure.reason}`);
        logger.warn('TOOL_REGISTRATION_FAILED', { count: 1 });
      },
      // A tool calling another tool (`ToolHost.invokeTool`) shows that call in
      // the transcript and journal like one the model made.
      nestedCalls: {
        onCallStarted: ({ toolCallId, toolName, args }) => {
          agentChatController.recordNestedToolCall({
            phase: 'started',
            toolCallId,
            toolName,
            args,
          });
        },
        onCallSettled: ({ toolCallId }, outcome) => {
          agentChatController.recordNestedToolCall({ phase: 'settled', toolCallId, outcome });
        },
      },
    });
    const bundledSkillsDirectory = path.join(bundledResourcesDirectory, 'skills');
    // The composer's `/` autocomplete reads this lazily, only once the renderer
    // asks (after the pane reports ready), so its filesystem read never sits on
    // the window's startup path. The send path consults `current()` - empty
    // until that read lands, which simply means a leading `/name` is passed
    // through unchanged until the catalogue is known.
    const skillCatalog = createSkillCatalog(bundledSkillsDirectory);

    lateBoundAemToolContext.bind(agentChatController);
    lateBoundUserInput.bind(agentChatController);
    lateBoundToolProgress.bind(agentChatController);

    const unregisterAgentChatIpc = registerAgentChatIpcHandlers({
      controller: agentChatController,
      logger,
      rendererDistDir,
      mainWebContentsId: mainWindow.webContents.id,
      rendererWebContents: mainWindow.webContents,
      // Reads a chat's journal from the app's own `chats` directory. The read
      // is bounded and never throws; a failure comes back as an `ok: false`
      // result, which the renderer treats as "nothing to repaint".
      readJournal: (request) => {
        const outcome = readChatJournal(appPaths.chats, request.chatId);
        if (!outcome.ok) {
          return { ok: false, error: describeJournalReadFailure(outcome.reason) };
        }
        return { ok: true, records: [...outcome.records] };
      },
      // Reveals the chat's journal file in Explorer, for the transcript
      // footer's session-id anchor. The path is derived from the `chatId` here
      // (never supplied by the renderer); a chat with no journal yet reveals
      // the chats directory instead, so a click always lands somewhere useful.
      revealJournal: (request) => {
        let filePath: string;
        try {
          filePath = path.join(appPaths.chats, toChatFileName(request.chatId));
        } catch {
          return {
            ok: false,
            error: { code: 'INVALID_ARGUMENT', message: 'The chat id is not usable' },
          };
        }
        shell.showItemInFolder(existsSync(filePath) ? filePath : appPaths.chats);
        return { ok: true };
      },
      // The bundled skill catalogue, read on demand for the composer's `/`
      // autocomplete. `readSkillCatalog` never rejects; the `ok: false` branch
      // is a defence-in-depth backstop the renderer treats as "no autocomplete".
      listSkills: async () => {
        try {
          return { ok: true, skills: [...(await skillCatalog.load())] };
        } catch {
          return {
            ok: false,
            error: { code: 'STORAGE_ERROR', message: 'The skill catalogue could not be read' },
          };
        }
      },
      // The stored conversations, derived from the journals in the app's own
      // `chats` directory. `listChatHistory` already tolerates a missing
      // directory and a bad journal; this `ok: false` is a backstop the
      // renderer shows as "history unavailable".
      listConversations: () => {
        try {
          return { ok: true, entries: [...listChatHistory(appPaths.chats)] };
        } catch {
          return {
            ok: false,
            error: { code: 'STORAGE_ERROR', message: 'The conversation history could not be read' },
          };
        }
      },
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
      void agentHub?.stop();
      aemBridgeBroker.dispose();
      aemBridgeTransport.dispose();
      browserController.destroy();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow({ windowStateFilePath: appPaths.windowState });
      }
    });

    // Agents are discovered from `src/agents/*/agent.ts`; one that fails to load
    // or construct is logged and left out, never fatal. The fake path builds no
    // real module at all (and so never imports an SDK).
    //
    // Building the registry is deliberately NOT awaited on the startup path:
    // importing an agent's `agent.ts` evaluates its SDK's whole module graph
    // synchronously on this (main) thread - measured at ~740 ms for
    // `@openrouter/agent` (see docs/verification.md). Run here, that block
    // starves the `app://` protocol handler and leaves the window blank for its
    // whole duration. `startAgentRuntime` therefore runs only once the shell
    // has painted (see `runAfterFrameLoad` below); everything visible before
    // then is agent-independent - the chat surface answers `serviceState:
    // "starting"` (see `createStartupGatedAgentChatController`) and the
    // Settings agent list comes from the `meta.ts` glob, not the hub.
    const startAgentRuntime = async (): Promise<void> => {
      const agentRegistry = useFakeAgentService
        ? { modules: [], failures: [] }
        : await buildAgentRegistry({
            loaders: discoverAgentLoaders(),
            definitions: agentDefinitions,
            disabledSources: agentCatalog.disabledSources,
            onFailure: (failure) => {
              // The logger has no free-text field by design, so the reason goes to stderr.
              console.error(`Agent ${failure.source} was not registered: ${failure.reason}`);
              logger.warn('AGENT_REGISTRATION_FAILED', { count: 1 });
            },
          });
      for (const failure of agentCatalog.failures) {
        console.error(`Agent ${failure.source} was not registered: ${failure.reason}`);
        logger.warn('AGENT_REGISTRATION_FAILED', { count: 1 });
      }
      if (useFakeAgentService) {
        logger.warn('AGENT_SERVICE_FAKE_SELECTED');
      }

      // The one owner of every agent's runtime: startup, recycle on a proxy or
      // active-agent change, sign-in and the model catalogue. It knows agents only
      // through the `AgentRuntime` contract; the SDK-specific code stays in
      // `src/agents/<name>/`.
      agentHub = createAgentHub({
        definitions: agentDefinitions,
        modules: agentRegistry.modules,
        useFake: useFakeAgentService,
        host: {
          isPackaged: app.isPackaged,
          resolveConnection: (agentId, settings) =>
            resolveConnection(agentId, settings ?? storedSettings, secretStore),
          // The one proxy-to-transport translation in the app: an in-process
          // agent calls this through `AgentHost.createProxyFetch` instead of
          // importing a proxy library into its own folder.
          createProxyFetch: (connection) => buildProxyFetch(connection.proxy),
          toolkit: () => {
            // The model-facing skill catalogue is composed onto the tool
            // instructions here, where both catalogues are known. `skillCatalog`
            // is loaded before the agent starts (see `startAgentService` below),
            // so `modelCatalogue()` is populated by the time any agent reads
            // this - which is what makes the model able to load a skill from its
            // description, not only from an explicit `/name` (see
            // `renderSkillCatalogue`).
            const skillCatalogue = renderSkillCatalogue(
              instructionResources.skillsTemplate,
              skillCatalog.modelCatalogue(),
            );
            return {
              allowlistEntries: toolRegistry.allowlistEntries,
              instructions:
                skillCatalogue === ''
                  ? toolRegistry.instructions
                  : `${toolRegistry.instructions}\n\n${skillCatalogue}`,
              toolHandlers: toolRegistry.toolHandlers,
              toolDescriptors: toolRegistry.descriptors,
              bundledSkillDirectories: [bundledSkillsDirectory],
            };
          },
          // Step 09: read from the cache on every use, so a model chosen in
          // Settings reaches the next prompt without a restart. Deliberately
          // synchronous - `sendPrompt` must not wait on a disk read.
          modelPreferences: () => modelPreferenceCache.current(),
        },
        installService: (service) =>
          installAgentService(
            {
              logger,
              idGenerator: randomUUID,
              currentAemServerContext: createCurrentAemServerContext(() =>
                browserController.activeServer(),
              ),
              navigationEpoch: () => browserController.navigationEpoch.current(),
              currentPageContext: createCurrentPageContext(
                () => browserController.activeServer(),
                () => browserController.currentDocumentUrl(),
                environmentFacts,
              ),
              chatJournal,
              // Stop / chat switch / close / context change all cancel the bridge's
              // in-flight and queued AEM requests, so a stopped tool call releases
              // the concurrency-1 slot immediately instead of running to its 90 s
              // deadline.
              cancelAemRequests: () => aemBridgeBroker.cancelAll(),
              // A prompt that begins with a known `/skillname` becomes an explicit
              // directive to load that skill; the user's own text is kept for the
              // transcript and the journal by the controller.
              resolveSkillPrompt: (prompt) =>
                resolveSkillPrompt(
                  prompt,
                  skillCatalog.current().map((skill) => skill.name),
                ),
              // Conversation deletion reads every SDK session id the journal
              // recorded (the header's first, plus one per runtime recycle) and
              // removes the journal file; both are plain filesystem facts main
              // owns, kept out of the controller.
              readChatSessionIds: (chatId) => readChatSessionIds(appPaths.chats, chatId),
              removeChatJournal: (chatId) => removeChatJournal(appPaths.chats, chatId),
              gatedController: agentChatController,
            },
            service,
          ),
        markUnavailable: () => agentChatController.markUnavailable(),
        onRuntimeFailure: (agentId, error) => {
          console.error(
            `Agent ${agentId} runtime failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          logger.error('AGENT_UNAVAILABLE');
        },
      });
      const hub = agentHub;

      // Only now does startup touch an agent, and never by blocking on it:
      // `hub.start` runs in the background - `startAppRuntime` never awaits it.
      // A startup failure there (runtime missing, corrupt install,
      // `initialize()` rejecting, ...) is logged loudly instead of leaving a
      // silently half-wired app or an unhandled rejection; see
      // `startAppRuntime`'s doc comment in `agentComposition.ts`.
      startAppRuntime({
        registerNonAgentHandlers: () => {
          // No non-agent handler was removed with the Settings window's
          // departure: every surface the separate window used (`settings:*`,
          // `agent:*`) is still served from the shell, so nothing needs
          // registering here beyond the always-present IPC sets above.
          return;
        },
        startAgentService: async () => {
          // Load the bundled skill catalogue before the agent starts, so
          // `toolkit().instructions` can carry the model-facing catalogue. This
          // is off the window's startup path: `startAgentRuntime` runs after the
          // shell has painted (see `runAfterFrameLoad`). A failed read resolves
          // to an empty catalogue, so this can never block the agent from
          // starting.
          await skillCatalog.load();
          await hub.start(storedSettings);
        },
        // No free-text field exists on `Logger` by design (see its own module
        // doc comment): `AGENT_UNAVAILABLE` is already the closed-vocabulary
        // code for exactly this failure ("the agent runtime ... is
        // unusable"), so the rejection reason itself is deliberately not
        // forwarded anywhere near the log.
        onAgentServiceStartupFailed: () => {
          logger.error('AGENT_UNAVAILABLE');
        },
      });
    };

    // Runs `startAgentRuntime` at most once, and only once the shell has
    // painted, so the agent import never delays the window itself (see
    // `runAfterFrameLoad`'s own doc comment). Guarded on both
    // `agentRuntimeStarted` and window destruction because two triggers can
    // race it: the frame's load event and the backstop timer below.
    let agentRuntimeStarted = false;
    const startAgentRuntimeOnce = (): void => {
      if (agentRuntimeStarted || mainWindow.isDestroyed()) return;
      agentRuntimeStarted = true;
      // `buildAgentRegistry`/`createAgentHub` do not throw by contract, but a
      // failure here must still be visible rather than an unhandled rejection.
      void startAgentRuntime().catch(() => logger.error('AGENT_UNAVAILABLE'));
    };
    runAfterFrameLoad(
      {
        isLoadingMainFrame: () => mainWindow.webContents.isLoadingMainFrame(),
        onceLoaded: (run) => {
          mainWindow.webContents.once('did-finish-load', run);
        },
      },
      startAgentRuntimeOnce,
    );
    // Backstop: a load event that never arrives (an unusual renderer failure)
    // must not strand the chat surface on "starting" forever. `unref` so the
    // timer never keeps the process alive on its own.
    setTimeout(startAgentRuntimeOnce, 10_000).unref();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
