import { app, BrowserWindow, Menu, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, resolveSkillPrompt, type AuthStatus } from '../shared';
import { createAemSession } from './aem';
import { createAemBridgeBroker } from './aem/bridgeBroker';
import { createAemBridgeTransport } from './aem/bridgeTransport';
import { createToolHttpLogger } from './aem/toolHttpLog';
import { createStartupGatedAgentChatController } from './agentChatController';
import {
  createBridgeCurrentContext,
  createCurrentAemServerContext,
  createCurrentPageContext,
  createLateBoundAemToolContext,
  createModelPreferenceCache,
  installAgentService,
  isModelSelectionLocked,
  resolveBundledSkillsDirectory,
  shouldUseFakeAgentService,
  startAppRuntime,
  wireNavigationEpochCancellation,
} from './agentComposition';
import { discoverAgentCatalog } from './agents/catalog';
import { resolveConnection } from './agents/connection';
import { createAgentHub, type AgentHub } from './agents/hub';
import { buildAgentRegistry, discoverAgentLoaders } from './agents/registry';
import { ensureAppDirectories, getOsHomeDirectory, resolveAppPaths } from './appPaths';
import { installAppProtocolHandler, registerAppProtocolPrivileges } from './browser/appProtocol';
import { createBrowserController } from './browser/browserController';
import { createChatJournal } from './chatJournal';
import { readChatJournal, type ChatJournalReadFailureReason } from './chatJournalReader';
import { installContentSecurityPolicy } from './csp';
import { mergeDisabledFeatures } from './disabledFeatures';
import { registerAgentAuthHandlers } from './ipc/agent';
import { registerAgentChatIpcHandlers } from './ipc/agentChat';
import { registerAppInfoHandler } from './ipc/app-info';
import { registerBrowserIpcHandlers } from './ipc/browser';
import { registerSettingsIpcHandlers } from './ipc/settings';
import { createTrustedWindowRegistry } from './ipc/trustedWindows';
import { createLogger } from './logger';
import { createSecretStore } from './secretStore';
import { installWebContentsSecurityGuard } from './security';
import { configuredAgentId, loadSettings, loadSettingsSync } from './settingsStore';
import { createSkillCatalog } from './skills/skillCatalog';
import { buildToolRegistry, discoverToolLoaders } from './tools/registry';
import { APP_USER_MODEL_ID, createMainWindow } from './windows';

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
      return { code: 'NOT_FOUND', message: 'No stored transcript was found for this chat.' };
    case 'invalid_chat_id':
      return { code: 'STORAGE_ERROR', message: 'The stored chat id is not usable.' };
    case 'too_large':
      return { code: 'STORAGE_ERROR', message: 'The stored transcript is too large to reopen.' };
    case 'unreadable':
      return { code: 'STORAGE_ERROR', message: 'The stored transcript could not be read.' };
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
      statusMessage: 'The agent is still starting.',
    };
    registerAgentAuthHandlers({
      hub: {
        getAuthStatus: async (agentId) => (await agentHub?.getAuthStatus(agentId)) ?? STARTING,
        login: async (agentId, settings) =>
          (await agentHub?.login(agentId, settings)) ?? {
            status: 'failed',
            message: 'The agent is still starting.',
          },
        cancelLogin: (agentId) => agentHub?.cancelLogin(agentId),
        logout: async (agentId) =>
          (await agentHub?.logout(agentId)) ?? {
            apiVersion: 1,
            warning: 'The agent is still starting.',
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
    const chatJournal = createChatJournal(appPaths.chats);
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

    // The `agent-chat:*` IPC handlers are registered against this
    // placeholder immediately, before any real `AgentService` exists: a
    // renderer `invoke` against an *unregistered* channel throws a raw
    // "No handler registered" error, a strictly worse failure mode than the
    // honest, typed `serviceState: "starting"` this placeholder answers
    // with instead. See `createStartupGatedAgentChatController`'s own doc
    // comment (`agentChatController.ts`). Declared here for the same
    // ordering reason as the model cache above.
    const agentChatController = createStartupGatedAgentChatController();

    // Resolved per call: the agent's runtime is started - and on a proxy change,
    // restarted - well after this registration runs. The hub waits for that
    // (re)install and reads the configured agent's catalogue, so an early
    // Settings open waits for the runtime rather than reporting a failure; a
    // genuinely unreadable catalogue still comes back as `err` and is reported
    // honestly (see `getModelSelection`). Shared by the step-09 model channels
    // and the agents channel: both read the one catalogue.
    const loadCatalog = async () => {
      if (agentHub === undefined) {
        return err({ message: 'The agent is still starting. Reopen Settings in a moment.' });
      }
      await agentHub.whenReady();
      return agentHub.loadModelCatalog();
    };
    // Step 09's "disable changes during an active turn". Read through the
    // gated controller so it answers honestly ("starting", hence not in a
    // turn) before the real controller exists.
    const isTurnInFlight = (): boolean =>
      isModelSelectionLocked(agentChatController.getStatus().sessionState);

    // Recycles the configured agent's runtime after a stored personal-access
    // token has been set or cleared. The settings document is reloaded rather
    // than reusing the captured one, because the *first* token set mints its
    // `secretRef` into settings.json - the captured document would still
    // describe no token. A failed reload falls back to the hub's last-known
    // document, which still names the same `secretRef`; the token's plaintext is
    // re-read from the secret store either way.
    const refreshRuntimeAfterTokenChange = async (): Promise<void> => {
      const loaded = await loadSettings(appPaths.settings);
      await (loaded.ok ? agentHub?.refresh(loaded.value.settings) : agentHub?.refresh());
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
        isTurnInFlight,
        onPreferencesSaved: (preference) => modelPreferenceCache.set(preference),
      },
      agentSettings: {
        definitions: agentDefinitions,
        loadCatalog,
        isTurnInFlight,
        // Recycles the runtime only when the change actually shapes it (the
        // active provider or its proxy) - a model/effort change is told to
        // the runtime at prompt time instead. See the agent's `runtimeManager`.
        onAgentSettingsSaved: (settings) => {
          void agentHub?.reconcile(settings).catch(() => logger.error('AGENT_UNAVAILABLE'));
        },
      },
      // A stored token is a runtime credential, so setting or clearing one has
      // to recycle the runtime - the running process resolved its old credential
      // at start. Skipped in fake mode: no runtime consumes the token there, and
      // recycling would discard the deterministic fake's state.
      onAgentTokenChanged: () => {
        if (useFakeAgentService) return;
        void refreshRuntimeAfterTokenChange().catch(() => logger.error('AGENT_UNAVAILABLE'));
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
    // Tools are discovered from `src/tools/*/tool.ts`; a tool that fails to
    // load or construct is logged and left out, never fatal.
    const toolRegistry = await buildToolRegistry({
      loaders: discoverToolLoaders(),
      host: {
        bridge: aemBridgeBroker,
        currentContext: lateBoundAemToolContext.currentContext,
        clock: Date.now,
        idGenerator: randomUUID,
      },
      onFailure: (failure) => {
        // The logger has no free-text field by design, so the reason goes to stderr.
        console.error(`Tool ${failure.source} was not registered: ${failure.reason}`);
        logger.warn('TOOL_REGISTRATION_FAILED', { count: 1 });
      },
    });
    const bundledSkillsDirectory = resolveBundledSkillsDirectory({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDir: currentDir,
      join: (...segments) => path.join(...segments),
    });
    // The composer's `/` autocomplete reads this lazily, only once the renderer
    // asks (after the pane reports ready), so its filesystem read never sits on
    // the window's startup path. The send path consults `current()` - empty
    // until that read lands, which simply means a leading `/name` is passed
    // through unchanged until the catalogue is known.
    const skillCatalog = createSkillCatalog(bundledSkillsDirectory);

    lateBoundAemToolContext.bind(agentChatController);

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
      // The bundled skill catalogue, read on demand for the composer's `/`
      // autocomplete. `readSkillCatalog` never rejects; the `ok: false` branch
      // is a defence-in-depth backstop the renderer treats as "no autocomplete".
      listSkills: async () => {
        try {
          return { ok: true, skills: [...(await skillCatalog.load())] };
        } catch {
          return {
            ok: false,
            error: { code: 'STORAGE_ERROR', message: 'The skill catalogue could not be read.' },
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
        toolkit: () => ({
          allowlistEntries: toolRegistry.allowlistEntries,
          instructions: toolRegistry.instructions,
          toolHandlers: toolRegistry.toolHandlers,
          toolDescriptors: toolRegistry.descriptors,
          bundledSkillDirectories: [bundledSkillsDirectory],
        }),
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

    // Everything above is already fully wired and interactive - nothing the
    // user can see or click depends on an agent. Only now does startup touch
    // one, and never by blocking anything else on it: `hub.start` runs in the
    // background - `startAppRuntime` never awaits it. A startup failure there
    // (runtime missing, corrupt install, `initialize()` rejecting, ...) is
    // logged loudly instead of leaving a silently half-wired app or an
    // unhandled rejection; see `startAppRuntime`'s doc comment in
    // `agentComposition.ts`.
    startAppRuntime({
      registerNonAgentHandlers: () => {
        // No non-agent handler was removed with the Settings window's
        // departure: every surface the separate window used (`settings:*`,
        // `agent:*`) is still served from the shell, so nothing needs
        // registering here beyond the always-present IPC sets above.
        return;
      },
      startAgentService: () => hub.start(storedSettings),
      // No free-text field exists on `Logger` by design (see its own module
      // doc comment): `AGENT_UNAVAILABLE` is already the closed-vocabulary
      // code for exactly this failure ("the agent runtime ... is
      // unusable"), so the rejection reason itself is deliberately not
      // forwarded anywhere near the log.
      onAgentServiceStartupFailed: () => {
        logger.error('AGENT_UNAVAILABLE');
      },
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
