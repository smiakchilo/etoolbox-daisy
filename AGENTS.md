# AGENTS.md — EToolbox Daisy

**Read this file first.** If the task is to **add, remove or disable an agent/SDK
or a tool**, go straight to §5 "Agents are plugins" / "Tools are plugins" and
follow their step-by-step recipes; the deeper rationale is in
`docs/agent-plugin-architecture.md` and `docs/tool-plugin-architecture.md`.
For step-plan work, the authoritative contract is `docs/implementation-plan.md`;
the consciously-deferred work is in `docs/backlog.md` and the known-open
delivery items in §11 below. Together they are enough to start work without
re-deriving anything.

---

## 1. What this application is

A **Windows desktop Electron app** that pairs two panes in one window:

- **left** — a private, embedded browser showing a **conventional AEM Author
  instance** (6.5 / LTS — *not* AEMaaCS);
- **right** — a **GitHub Copilot** chat that can read that AEM instance through
  the user's own authenticated browser session.

The defining idea: the agent never gets AEM credentials. Every AEM read is
brokered through the left pane's live session, so the model can only see what
the signed-in human can see. The app is **read-only against AEM** by
construction — there is no write path to remove.

Target: Windows 10 x64, internal, unsigned build.

---

## 2. Documents, in the order they matter

| File | What it is                                                                                                                                                                                                                                    | How to treat it |
| --- |-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------| --- |
| `docs/implementation-plan.md` | The **contract**. 12 numbered steps, each with explicit success criteria.                                                                                                                                                                     | **Read-only.** Never edit. Never mark several steps done on a general impression. |
| `docs/requirements-decisions.md` | The reasoning and agreed decisions behind the plan.                                                                                                                                                                                           | Read when a plan bullet seems arbitrary — the justification is here. |
| `docs/compatibility.md` | Verified-API fact table (**U1–U12**, ~lines 801–810) plus SDK behaviour notes.                                                                                                                                                                | **Authoritative.** If it says an API behaves a certain way, that was proven by running it. Don't re-test; don't contradict it from intuition. |
| `docs/verification.md` | The **evidence log** — an index over per-era section files in `docs/verification/` (one dated section per completed piece of work).                                                                                                           | Append a section to the current archive (`docs/verification/followons-2026-10.md`). Record what was *executed*, not what was written. |
| `docs/agent-plugin-architecture.md` | Why agents are plugins (`src/agents/<name>/`), the contract, isolation table, add/disable/remove recipes, known limits.                                                                                                                       | Read before adding, removing or restructuring an agent/SDK. |
| `docs/tool-plugin-architecture.md` | Same for tools (`src/tools/<name>/`).                                                                                                                                                                                                         | Read before adding or removing a tool. |
| `docs/backlog.md` | Deferred, deliberately-put-off work — features and fixes recorded as *not yet done*, each self-contained.                                                                                                                                     | Read before starting anything that sounds like a "later" idea; append an entry when you consciously defer one. |
| `docs/updates.md` | How in-app updates work and the release procedure (version bump, the **derived** runtime descriptor that alone decides swap vs. fresh install, publish workflow, sandbox).                                                                              | Read before changing the updater or cutting a release. |
| `docs/run-from-source.md` | The build-from-source distribution: `install/install.cmd` (Windows) and `install/install.command` (Mac) - an already-installed Node.js 22.12+ is used as it is, else a pinned, signature-checked portable Node is downloaded (`EDAISY_NODE=pinned` forces it) - plus the shared `scripts/app-build.mjs`; they build the app into the script's own folder. | Read before changing those scripts; keep the `.cmd` CRLF and the `.command` LF + executable, call Windows tools by absolute path, and keep both scripts' Node pin in step (`tests/unit/install/installScripts.test.ts`). |
| `docs/custom-skills.md` | How a user writes and installs a custom skill (folder, front matter incl. `table-only`, Reload skills), which built-in tools it can call, and the example skill in `docs/examples/skills/`. | Read before changing the skill front matter or the tools a skill is documented to use; the example is guarded by `tests/unit/main/skills/exampleSkills.test.ts`. |
| `docs/addon-architecture.md` | The add-on model: the DLL principle, content identities in `src/shared/addons/pins.json`, the contributions a folder declares and the build derives, the generic `AddonHost`, the `addons.json` catalogue, the install store, `out/addons` in development, the recipe for adding one, the decoupling acceptance, and why the Copilot CLI is not an add-on. | Read before touching `src/main/addons/`, `src/agents/copilot/cli/`, `scripts/build-addons.mjs`, or moving anything heavy out of the base install. |

---

## 3. Where the project stands

**Steps 00–08 complete and verified. Steps 09–12 remain.**

- 09 — genuine history, models, origin changes
- 10 — UX, deletion, failure handling
- 11 — zip distribution, mock-AEM acceptance (**Milestone B**)
- 12 — real AEM verification (**Milestone C**, needs an authorized environment)

Step 09's **history surface** now exists — a whole-size History panel listing
stored conversations (title/date/server) with resume and single-chat delete,
derived from the journals (see `docs/verification.md` "History and conversation
browsing: a list, resume, and delete (2026-10-15)"). What remains of Step 09/10
is recorded in `docs/backlog.md` (the host cascade, and the cross-agent /
after-a-recycle resume-honesty item).

Milestone A (steps 00–07) is functionally complete, **except that the 15-row
manual smoke checklist (in `docs/verification/milestone-a-steps-00-08.md`) has
never been run by a human.** It needs a real Copilot sign-in and a real AEM instance.

**The repository has commits** (`git log`/`git diff` work), but the agent- and
tool-plugin refactors may still be uncommitted in the working tree. **Do not
commit unless the user asks.**

---

## 4. Architecture and process boundaries

```
┌─────────────────────────── Electron main ────────────────────────────┐
│  src/main/                                                           │
│    index.ts ............ composition root (wires everything)         │
│    browser/ ............ the browser pane, navigation, origin switch │
│    webview/ ............ session, proxy/TLS/cookies, bridge, HTTP log│
│    aem/ ................ AEM URL building, response validation       │
│    ipc/ ................ typed IPC handlers, sender guards           │
│    settingsStore / secretStore / logger / appPaths                   │
│    (appPaths: visible ~\etoolbox-daisy = settings, chats, logs;      │
│     technical %LOCALAPPDATA%\etoolbox-daisy = browser, agents,       │
│     addons, secrets, window-state, tmp)                              │
│                                                                      │
│  src/agents/<name>/  ← agent plugins; the ONLY place an SDK is imported│
│    copilot/: meta · agent · runtime · sdkAgentService · toolPolicy … │
│  (discovered by src/main/agents/registry.ts, run by agents/hub.ts)   │
│                                                                      │
│  src/addons/<id>/  ← self-contained plugins (DLLs): their own tools,  │
│    page-audit/        skills and libraries; loaded at run time with a │
│   real import(); pinned by src/shared/addons/pins.json, installed by  │
│   src/main/addons/, never in the asar (docs/addon-architecture.md)    │
└──────────┬───────────────────────────────────┬───────────────────────┘
           │ typed IPC                         │ stdio
┌──────────┴───────────┐            ┌──────────┴─────────────────────┐
│ src/preload/         │            │  copilot-runtime.exe (bundled) │
│  app-preload ........ chat + settings bridge                        │
│  webview-preload .... runs INSIDE the remote page; the private fetch│
│  bridgeFetch ........ the actual authenticated read                 │
│  credentialCapture .. reports a submitted sign-in form (outbound)   │
└──────────┬───────────┘            └────────────────────────────────┘
           │
┌──────────┴──────────────────────────────────────────────────────────┐
│ src/renderer/  — Adobe Spectrum Web Components only                  │
│    shell/ ........ two-pane layout, toolbars, panes                  │
│    chat/ ......... transcript, composer, markdown, query table       │
│    settings/ ..... settings panel sections (hosts/projects/agents)   │
└──────────────────────────────────────────────────────────────────────┘

           src/shared/  — imported by ALL of the above
```

### The AEM read path, end to end

This is the single most important flow in the app. Trace it before changing
anything near it:

```
model calls aem_get_json / aem_query
  → src/tools/<name>/tool.ts     the tool's executor (createToolExecutor in
                                 src/shared/tools/core): validate args, build envelope
  → src/main/tools/registry.ts   discovered + isolated; hands each tool a ToolHost
                                 whose bridge is bridgeBroker.request
  → src/main/webview/bridgeBroker.ts  policy, deadlines, navigation-epoch checks
  → src/main/webview/bridgeTransport.ts  IPC to the browser pane
  → src/preload/bridgeFetch.ts    the fetch, inside the authenticated page
  → src/main/aem/responseValidation.ts  classify HTTP + content type
  → src/main/aem/queryResponse.ts  QueryBuilder success flag, totals
  → src/main/aem/*Projection.ts    shrink to what the model actually needs
  → back to the model, and to transcriptView.ts for display
```

---

## 5. Directory map

### `src/shared/` — the contract layer

**The single source of truth for everything crossing a process boundary.**
`src/shared/contracts/` is dependency-free apart from zod, and ESLint enforces
that: **no Electron, no Node built-ins, no browser globals** under
`src/shared/**`, so the same code runs unchanged in main, preload and renderer.

| File | Owns |
| --- | --- |
| `contracts/ids.ts` | Branded ID primitives (`RequestId`, `ChatId`, `TurnId`, `ServerId`) |
| `contracts/errors.ts` | The error taxonomy and `requiredAction` values |
| `contracts/origin.ts` | Origin normalization and comparison |
| `contracts/serverConfig.ts` | A host entry (id, label, colour, address, optional `projectId`, revision) |
| `contracts/projectConfig.ts` | A project entry — host-structure facts (content/component/DAM roots, content priority paths) shared by several hosts, referenced by a host's optional `projectId` |
| `contracts/appSettings.ts` | The persisted settings document — **no `schemaVersion`** (see §7) |
| `contracts/settingsSnapshot.ts` | The redacted snapshot the renderer is allowed to see |
| `contracts/chatMetadata.ts` | Chat list entries (title, date, server, selection) |
| *(moved)* | Tool argument/result schemas, `paginationMetadataSchema`, `totalMatchesSchema`, `renderTotal()` now live with their tool: `src/tools/<name>/<name>.ts`; the plugin contract is `src/shared/tools/core/` |
| `contracts/agentEvents.ts` | The normalized event stream the renderer consumes |
| `contracts/sessionState.ts` | Session/turn state machines |
| `contracts/webviewBridge.ts` | The preload↔main bridge envelope |

Non-contract shared files: `result.ts` (the `Result` type), `ipc-channels.ts`,
and the per-surface IPC type files (`agent-chat-ipc.ts`, `browser-ipc.ts`,
`settings-ipc.ts`, `app-api.ts`, `agent-auth.ts`).

> **Treat Step 03 contracts as frozen.** A few have been changed since —
> `toolResult.ts` (§8), `sessionState.ts` (the `sending -> runningTool`
> transition, because the SDK can make a tool call a turn's first event), the
> settings contracts `appSettings.ts` /
> `settingsSnapshot.ts` (the latter gained the `browser` object with
> `disableNativeWebAuthn`, the Settings "Browser" tab's WebAuthn-suppression
> flag), and `settings-ipc.ts`. The host-structure settings most recently moved
> off the host: `serverConfig.ts` lost `contentRoots`/`componentRoots` (now a new
> `projectConfig.ts` library plus a host's optional `projectId`), which
> `appSettings.ts`/`settingsSnapshot.ts`/`settings-ipc.ts` all follow — the
> Settings "Projects" tab, see `docs/verification.md` "Settings \"Projects\": host
> structure facts move off the host, and a host picks one (2026-10-13)". That
> tab then gained a fourth field, `projectConfig.ts`'s `damRoots` (DAM roots for
> `/search` and `/semantic-search`, default `/content/dam`), with
> `settingsSnapshot.ts`/`settings-ipc.ts`/`settingsStore.ts` following — see
> `docs/verification.md` "DAM roots: a project field, environment facts, and a
> search-only root fan-out (2026-10-14)".
> `userInput.ts` gained an optional
> `actions` list (1–4 one-click labels) and made `question` optional — the
> `ask_user` actions mode (see §5 tools). Most recently `contracts/agentEvents.ts`
> gained a seventeenth variant, `user.input.actions.added` (transient, never
> journaled: buttons added to the live actions question - "Load all" the moment a
> search's honest total settles), with the optional
> `ToolHost.addUserInputActions` that emits it - see
> `docs/verification/followons-2026-10.md` "\"Load all\" appears the moment the
> honest total settles (2026-10-16)". Before that it gained a sixteenth variant, `tool.call.progress` (a transient, never-journaled
> progress note for one in-flight tool call), with the optional
> `ToolHost.reportToolProgress` capability that emits it — the spinner + live
> "Reading n of m" on a long semantic search — see `docs/verification.md`
> "Semantic search: a live progress line, concrete node paths, and a 20-hit page
> (2026-10-12)". Before that `contracts/modelCatalog.ts`
> lost `changesLocked` and `settings-ipc.ts` lost `turn_in_flight`, when Step
> 09's "disable changes during an active turn" lock was replaced by "apply the
> change on the next turn" — see `docs/verification.md` "Settings changes apply
> on the next turn (2026-10-09)". The journal contract `chatJournal.ts` gained an
> optional `pageContext` on its `user.prompt` record - the current-page block the
> model read besides the typed prompt, for diagnostics only (the renderer never
> paints it) - see `docs/verification.md` "Search scope and instruction resources
> (2026-10-15)". **There is deliberately no `schemaVersion` field and no
> migration code anywhere**: the project has no deployed users and no
> backward-compatibility obligation, so the persisted shape may change freely.
> Do not add a version field or a migration. Loading a hand-edited
> `settings.json` stays forgiving — missing fields default, unknown keys are
> stripped, unusable entries are dropped — but that lives only in
> `normalizeSettingsDocument` in `src/main/settingsStore.ts`; the contract
> schemas themselves stay `.strict()`. If you must change another contract, say
> so explicitly and search for the blast radius **outside `tests/unit`** too.
> The most recent shared-surface change **lets an add-on contribute its
> own tools and skills** (2026-10-28): a new `src/shared/addons/` (the strict
> contribution schema, the generic `AddonHost`/`AddonModule`/`ADDON_API_VERSION`,
> and the pins parser `pins.ts` moved from `src/main/addons/`), the pins gaining
> `contributions`, `ToolHost.pageAudit` and `src/shared/tools/core/pageAudit.ts`
> **removed** (the add-on owns them), `SkillSource` gaining `'addon'`,
> `SkillHost.activate` becoming async (so `resolveSkillPrompt` takes an async
> lookup), the log code `PAGE_AUDIT_FAILED` becoming `ADDON_RUNTIME_FAILED` (with
> an `addonId` field), and the logger gaining that field. New main modules:
> `addons/addonHost.ts`, `addons/loader.ts`, `tools/addonProxy.ts`; the renderer
> gains `chat/contributedTools.ts`. **No file under `src/shared/contracts/`
> changed.** See §5's "Add-ons" and `docs/addon-architecture.md`, and the
> evidence section in `docs/verification/followons-2026-10.md`.
> Before that it **detected an authentication loss
> mid-run** (2026-10-22): a new push channel `browser:auth-incident`
> (`BROWSER_AUTH_INCIDENT_CHANNEL`), `DaisyBrowserApi.onAuthIncident`,
> `browserAuthIncidentSchema` in `browser-ipc.ts`, the classifier
> `tools/core/authIncident.ts` (certain vs suspected; exported through the tools
> barrel), `SIGN_IN_DIRECTIVE` appended to a `sign_in_to_host` failure's text, and
> the `AUTH_LOST` log code. The bridge broker's optional `authWatch` raises a
> per-host incident and latches fast-fail replies (a synthetic
> `blocked/redirect_blocked`); `browserController.reloadForAgent` reloads the pane
> without cancelling the turn; the chat pane shows a sticky notice with a Reload
> action (`noticeAuthLost` / `clearAuthNotice`, `StatusBanner.clearNotice`).
> `REDIRECT_BLOCKED` no longer triggers memo reflection. No file under
> `contracts/` changed. See `docs/verification/followons-2026-10.md`
> "Authentication lost mid-run is detected at once, announced, and the pane
> reloaded (2026-10-22)".
> Before that, the shared-surface change **generalized the publication filter
> into page-property filters** (2026-10-22): `tools/core/publication.ts` became
> `tools/core/searchFilters.ts` (exported through the tools barrel); both search
> composites take an optional `filters` array instead of `publication`, and the
> publication state is now one filter the prose names
> (`cq:lastReplicationAction`). An operator covers equality, `like`, existence
> and date/number ranges; filters sharing a `group` are ORed. No file under
> `contracts/` changed. See "Page-property filters" below and
> `docs/verification/followons-2026-10.md` "The publication filter becomes
> page-property filters, and `search-component` filters by template (2026-10-22)".
> Before that, the shared-surface change **added the publication filter**
> (2026-10-20): a new `tools/core/publication.ts` (exported through the tools
> barrel) built the QueryBuilder predicates for the search composites' optional
> `publication` argument - the change this one generalizes; the file is gone.
> Before that, the shared-surface change **removed the memo billet's hover
> actions** (2026-10-19): `tools/core/toolRenderer.ts` lost `ToolCallAction` /
> `readActions` (as did the renderer registry), `src/renderer/src/chat/toolCallActions.ts`
> is deleted, and `memos-ipc.ts` / `ipc-channels.ts` / `DaisyMemosApi` lost
> `memos:undo`. A stored memo now raises the chat pane's sticky notice ("Memo was
> stored. Press **Open** to view it in folder"), whose action calls `memos:reveal`;
> the billet itself is action-free like every other billet - see "Memos" below
> and `docs/verification/followons-2026-10.md` "A stored memo raises a notice ...
> (2026-10-19)".
> Before that it was **self-learning memos** (2026-10-19):
> `contracts/chatJournal.ts`'s `user.prompt` gained an optional
> `origin: 'reflection'`; `appSettings.ts` / `settingsSnapshot.ts` /
> `settings-ipc.ts` gained `memos.enabled` (and `updateMemoSettings`);
> `ToolHost` gained an optional `memos: MemoHost` (`src/shared/memos/`);
> `tools/core/toolRenderer.ts` gained `ToolCallAction` / `readActions`;
> `renderSkillActivation` / `resolveSkillPrompt` take a `memos` argument; and
> `memos-ipc.ts` + `ipc-channels.ts` carry `memos:open-folder` / `memos:reveal` /
> `memos:undo` — see "Memos" below and `docs/verification/followons-2026-10.md`
> "Self-learning memos ... (2026-10-19)".
> Before that it was the **`sdkSessionId` → `sessionId`
> rename** (2026-10-18): `contracts/ids.ts`'s `SdkSessionId` / `sdkSessionIdSchema`
> became `SessionId` / `sessionIdSchema`, and every `sdkSessionId` property —
> including the persisted journal `header` and `session.opened` key,
> `AgentChatStatus.sessionId`, the open-conversation `resume` field and the log
> id field — became `sessionId` (the active agent's session id, not "the SDK's").
> The persisted key is renamed outright, so old journals' header records no
> longer parse (skipped; no migration code, see §5) — see
> `docs/verification/followons-2026-10.md` "`sdkSessionId` becomes `sessionId`,
> and the `appPaths` `copilot` directory is confirmed already gone (2026-10-18)".
> Before that the most recent shared-surface change was the **paged History list**
> (2026-10-18): `agent-chat-ipc.ts` gained
> `agentChatListConversationsRequestSchema` (an optional opaque `next`) and an
> optional `next` on the ok result of `agentChatHistoryListResultSchema`, and
> `app-api.ts`'s `listConversations` now takes that request — so the panel can
> append small pages instead of waiting for one whole scan — see
> `docs/verification/followons-2026-10.md` "History opens in small batches, with
> one set of actions and a Reveal in folder (2026-10-18)". The *contracts/*
> change before the rename is "a chat records its host when it is first
> used" (2026-10-15): `contracts/chatJournal.ts`'s `user.prompt` record gained an
> optional `serverId` (the host the pane was on when the prompt was sent), so a
> chat opened before any host was restored still records the host it was first
> *used* on — see `docs/verification.md` "A chat records its host when it is
> first used (2026-10-15)". Before that it was the per-chat SDK session history
> (2026-10-15): `contracts/chatJournal.ts` gained a `session.opened` record
> (after the header, one per runtime recycle) so chat deletion can remove every
> SDK session the chat minted — see `docs/verification.md` "Per-chat SDK session
> history: deletion removes every session a chat minted (2026-10-15)". Before
> that it was Step 09's history surface (2026-10-15):
> `contracts/agentService`'s `AgentService` gained `deleteSession(sessionId)`
> (implemented by both adapters and the fake; `HardenedSessionClient.deleteSession`
> is optional) and `agent-chat-ipc.ts` / `ipc-channels.ts` gained the
> `agent-chat:list-conversations` and `agent-chat:delete-conversation` surface —
> see `docs/verification.md` "History and conversation browsing: a list, resume,
> and delete (2026-10-15)".

### Agents are plugins: one folder under `src/agents/<name>/`

An agent (an SDK such as GitHub Copilot) is a self-contained folder; **deleting
the folder removes the agent**. Design and rationale:
`docs/agent-plugin-architecture.md`. Nothing outside the folder may import from
it except by the glob discovery.

```
src/agents/<name>/
  meta.ts     exports `meta: AgentMeta` - SDK-free, imports only src/shared;
              globbed eagerly by main and renderer; `disabled: true` switches off
  agent.ts    exports `agent: AgentModule` ({ id, createRuntime(host) }); loaded
              lazily and in isolation by src/main/agents/registry.ts
  ...         the agent's own runtime, auth, model catalog, tool policy, SDK client
```

- Contract: `src/shared/agents/` (`agentModule.ts`, `agentService.ts`).
  `AgentHost` is the only thing an agent receives; `AgentRuntime` is what it
  returns. The agent list is **not** a constant any more: contract helpers in
  `src/shared/contracts/agents.ts` take `definitions`.
- Main: `src/main/agents/` - `registry.ts` (lazy discovery, isolation),
  `catalog.ts` (eager `meta.ts`), `hub.ts` (one runtime per enabled agent,
  switching, auth routing), `connection.ts`, `fakeRuntime.ts` /
  `fakeAgentService.ts` (E2E fake). Renderer: `src/renderer/src/agents/agentCatalog.ts`.
  The registry + hub are built **after the shell has painted** (`runAfterFrameLoad`,
  `src/main/agentComposition.ts`), so an agent SDK's synchronous module-graph
  evaluation never delays the window; the chat surface answers `starting` until
  then.
- A load failure, malformed module, id mismatch, duplicate id or a throwing
  runtime disables **only that agent** (`AGENT_UNAVAILABLE`); zero agents shows
  "No agent available" while AEM browsing keeps working.
- ESLint confines an agent folder to itself plus `src/shared`; SDK imports are
  legal only there. Proof fixture:
  `tests/fixtures/eslint-violations/agent-boundary-violation.ts`.
- Limits: a **type error** in an agent folder fails global `tsc`, even if
  `disabled`; its tests are deleted with it; agent code is a lazy chunk, so it
  must not derive paths from its depth under `out/main` (use
  `findProjectRoot`-style lookups).
- Removing an agent: delete the folder and `tests/unit/agents/<name>/`, plus the
  `electron-builder.yml` filters and `package.json` deps. For Copilot also the
  integration tests `proxy-login`, `agent-runtime`,
  `proxy-runtime`, `live-github-auth`, `support/syntheticLogin.ts`.
- Not lint-enforced but load-bearing: the eager `meta.ts` glob (main + renderer)
  and the lazy `agent.ts` glob (main) both need the folder to match
  `src/agents/*/`; `agent.id` must equal an enabled `meta.id` (otherwise the
  registry reports it and skips the agent; duplicates likewise). The persisted settings shape per agent is the shared
  `agentSettingsSchema` (`active`, `proxy`, `model`, `reasoningEffort`,
  `token`); an agent that needs other settings would have to extend that shared
  contract - **say so and ask**.
- **An agent that needs an external executable obtains it itself.** Copilot's
  interactive sign-in spawns a **GitHub Copilot CLI** (`copilot login
  --web-flow`) that nobody ships for it, so the agent resolves one inside its own
  folder (`src/agents/copilot/cli/`): a CLI already on the machine (known install
  roots, then `PATH`; launchers are resolved *through*, never executed), the
  agent's own verified cache (`<stateDirectory>/cli/<version>/`), or the latest
  GitHub release for this platform, checked against the digest the release
  publishes. There is no pin - the CLI updates itself - only a supported minimum
  (`COPILOT_CLI_MINIMUM_VERSION`). It takes the host's `createProxyFetch` and
  answers progress through `AgentHost.reportAuthProgress`, which main pushes as
  `agent:auth-progress` and the Settings Agents tab shows in the provider's
  sign-in status. **No agent-specific capability crosses `AgentHost`**: the
  application has no Copilot knowledge, and the resolver's `download.ts` is the
  agent's own (an agent may not import `src/main`, so the updater's helper is not
  reused). The cache lives under the agent's state directory, and
  `auth.ts`'s plaintext-credential scan skips that one subtree - it holds
  digest-verified binaries, not text the CLI wrote.
- **Diagnostics and usage contract (every agent, incl. a future Claude).**
  `model.changed` / `model.usage` / `context.usage` / `model.call.failed`
  events. The first three are journaled **and forwarded** to the renderer: the
  chat footer's token gauge and the Usage panel total them (`chat/sessionUsage.ts`
  projects them, live and from a resumed chat's journal), so a wrong or
  unit-less number is visible to the user. `model.call.failed` stays
  journal-only. An adapter:
  - reports its model through `createModelObserver`
    (`src/shared/agents/modelObserver.ts`) in `sendPrompt`;
  - builds every `model.usage` body with `buildModelUsage`
    (`src/shared/agents/usageReport.ts`), which keeps a `cost` inseparable from
    its `costUnit` (`usd` or `billing-multiplier`; Copilot's real spend is
    `aiCredits`, `totalNanoAiu / 1e9`) and drops unusable numbers;
  - reports usage **cumulative over every model call of a turn** (the last round
    of a tool loop alone understates it) and still reports the calls a turn
    completed before it failed;
  - optionally emits `context.usage` (`buildContextUsage`) when its SDK exposes
    the window - otherwise stays silent and the panel says "Not reported";
  - implements `AgentRuntime.complete` (optional) - **the one routine behind
    every tool-triggered secondary agentic turn** (see "Secondary agentic turns"
    under Tools). It runs the caller's `{ instructions, prompt }` on a fresh
    session and returns the reply text; it knows nothing of any tool. It reports
    **each model call it makes** (retries, failures and cancellations included)
    to the `UsageSink` it is handed - it emits no events of its own;
  - passes `describeAgentDiagnosticsConformance`
    (`tests/support/agentDiagnosticsConformance.ts`; it also pins that a turn the
    user stopped still reports the calls it had completed) and, with a
    `complete`, `describeAgentOneShotConformance`
    (`tests/support/agentOneShotConformance.ts`) via its own harness.
  `tests/unit/agents/agentConformance.test.ts` **fails the build** for an enabled
  agent folder whose tests do not run them. Semantics are documented in
  `src/shared/contracts/agentEvents.ts`.
- Copilot's files: `copilotClient.ts` (`createHardenedCopilotClient`),
  `runtimePaths.ts` (+ `findProjectRoot`), `toolPolicy.ts`
  (**the hardening core**), `toolAllowlistPolicy.ts`, `sdkAgentService.ts`, `auth.ts`,
  `authPresence.ts` (cheap non-starting `getAuthPresence` from `config.json`),
  `modelCatalog.ts`, `runtimeManager.ts`, `runtime.ts`.
- OpenRouter's files: `client.ts` (the only place the SDK is constructed; pins
  `serverURL` and injects a proxy `fetcher`), `toolMapping.ts` (toolkit JSON
  Schema → SDK tools), `agentService.ts` (event mapping, SDK-free),
  `modelCatalog.ts`, `auth.ts`, `runtime.ts`, `types.ts` (skills are no longer
  an agent concern: the three skill tools are ordinary tools, see
  "`resources/skills/`"). It is token-only: `meta.supportsInteractiveLogin`
  is `false`, it has no `login`/`logout`, and `getAuthPresence` is its stored
  key.

#### Recipe: add a new agent / SDK (e.g. OpenCode, Claude)

1. **Design check with the user first** if the SDK needs anything the contract
   lacks (extra per-agent settings, a non-token credential, non-stdio transport):
   those mean changing `src/shared/**`, which must be reported loudly (§12).
2. `src/agents/<name>/meta.ts` — `export const meta: AgentMeta = { id, label,
   requiresAuth, supportsInteractiveLogin }` (id cast `as AgentMeta['id']`; set
   `supportsInteractiveLogin: false` for a token-only provider). Import only
   `../../shared`; **never** the SDK (the renderer globs this file).
3. `src/agents/<name>/agent.ts` — `export const agent: AgentModule = { id:
   meta.id, createRuntime }`. Model it on `src/agents/copilot/agent.ts` /
   `runtime.ts`.
4. Implement `createRuntime(host: AgentHost): AgentRuntime` (`start`,
   `reconcile`, `refresh`, `stop`, `whenReady`, `getAuthStatus`,
   `loadModelCatalog`; `login`/`cancelLogin`/`logout` only if the SDK signs in
   interactively; optional `getAuthPresence` to report a cheap, **non-starting**
   sign-in presence so the Settings "Set active" control can be honest without
   starting an inactive provider's runtime; optional `complete` - the generic stateless one-shot call behind every
   tool-triggered secondary agentic turn (`src/shared/agents/oneShot.ts`): run the
   caller's `{ instructions, prompt }` on a fresh, tools-disabled session with the
   same model/provider/proxy and the caller's abort signal, return the reply text,
   and **report every model call it makes to its third argument, the usage sink**).
   Get proxy/token from
   `host.resolveConnection(meta.id, settings)` — an agent never touches the
   secret store or settings store. An **in-process** agent applies its proxy by
   wrapping the resolved connection with `host.createProxyFetch(connection)`
   (a WHATWG `fetch`, the global one when no proxy is set) and must **not**
   import a proxy library itself; a child-process agent keeps
   `connection.proxy` and passes it to its runtime as environment variables.
5. Build an `AgentService` (`src/shared/agents/agentService.ts`) around the SDK
   and hand it to `host.installService(service)`. It must emit normalized
   `AgentEvent`s only — no SDK type may cross the boundary. Map the tools from
   `host.toolkit()` (`toolHandlers`, `toolDescriptors`, `allowlistEntries`,
   `instructions`) onto the SDK. `allowlistEntries`
   are in Copilot's `custom:<name>` form; translate if the SDK differs. **Do not
   import `src/tools` or `src/main`** — everything arrives through the host.
    Report the model and the usage per the "Diagnostics and usage contract"
    above (`createModelObserver`, `buildModelUsage`): the user reads those totals.
6. **Hardening is per-agent.** Copilot's `toolPolicy.ts` denies every built-in
   tool except the AEM tools and `load_skill`; a new SDK must get an equivalent
   deny-by-default policy (and equivalent verification, cf. AGENTS.md §8 skill
   facts) *before* it may see a tool. Read-only against AEM stays absolute (§7.4).
7. Keep all SDK-specific paths robust to **code-splitting**: agent code lives in
   `out/main/chunks/`, so never derive a root from `__dirname` depth (use
   `findProjectRoot` from `src/agents/copilot/runtimePaths.ts` as the pattern —
   copy, don't import).
8. Dependencies: add the SDK to `package.json`; if it ships a native runtime, add
   its `electron-builder.yml` filters/`asarUnpack` (see Copilot's).
9. Tests in `tests/unit/agents/<name>/`, **including the shared conformance
   suites** (`describeAgentDiagnosticsConformance`, and
   `describeAgentOneShotConformance` if the runtime defines `complete`) -
   `tests/unit/agents/agentConformance.test.ts` fails without them. The fake E2E path needs **nothing**: with
   the fake enabled the hub gives *every* discovered definition a fake runtime.
   Do check that `tests/unit/main/agents/registry.test.ts` / `hub.test.ts` still
   pass, run `npm run typecheck`, `npm run build`, launch the built app, and run
   the Playwright suite. If SDK is Node-heavy, verify the packaged/`out/`
   layout in real (non-fake) mode — unit tests cannot see chunk-path bugs.
10. Record evidence in the current archive under `docs/verification/` (indexed by
    `docs/verification.md`); update this section and
    `docs/agent-plugin-architecture.md`.

**Disable temporarily:** `disabled: true` in `meta.ts` (agent.ts is never
loaded). **Remove:** see "Removing an agent" above. With one agent left the
active agent falls back to the first definition; with none the chat pane says
"No agent available".

### `src/main/`

`index.ts` is the composition root — read it first to see how the pieces meet.
`agentComposition.ts` holds the wiring helpers (`createBrokeredExecute`,
`createBrokeredQueryExecute`, `resolveBundledResourcesDirectory`,
`startAppRuntime`, `exposeFakeAgentServiceForTests`).

**A turn lives from `sendMessage` to its own terminal event — never "while the
session is idle".** `AgentChatController` registers `activeTurn` before the
adapter is asked to send, and every turn-scoped event is filtered by it
(`isOwnedEvent`), as is `currentToolContext()`. So the turn is cleared only by
`isTerminalTurnEvent` (an `error`, or a `session.state.changed` to
`idle`/`closed`/`error`) — deliberately not by reading `sessionStatus.state`,
because a **chat-scoped** event lands between registration and the turn's own
`sending`: a resumed Copilot session applies the stored model at prompt time, the
SDK reports `session.model_change`, and it is mapped to a turn-less `model.changed`
(`cause: "runtime-reported"`). Reading the state there once discarded the fresh
turn, which dropped the whole turn's events for the renderer (no "Thinking", no
billets, no answer) and made every tool that needs the tool context fail with
`no active chat/turn to bind to` — the "first prompt after a restore does
nothing" defect. The same rule governs `observeTurnSignals`'s collector. See
`docs/verification/followons-2026-10.md` "The first prompt after a restore shows
its work".

`chatJournal.ts` (the append-only writer) and `chatJournalReader.ts` (a bounded,
tolerant read) are accompanied by `chatHistory.ts`: `snapshotChatHistoryIds`
lists the chats directory's observably present ids once (file names and mtimes
only) and `readChatHistoryPage` reads one page of them - the browsable History
list derived on demand from the journals under `chats/` (title from the
first user prompt, date/server/session from the header) — there is deliberately
no `ChatMetadata` store — plus `removeChatJournal` for single-chat deletion. The
file-name guard `toChatFileName` lives in its own `chatJournalPaths.ts`, because
the writer now reads a chat's already-recorded session ids at open time
(`chatJournalReader.readChatSessionIds`) and importing the reader directly would
cycle through that shared guard. `agentChatController.deleteConversation`
orchestrates it: close the chat if open, delete every SDK session the journal
recorded (best-effort per session), remove the journal. A runtime recycle
re-opens the same chat under a new SDK session, so the journal records each one
(a `session.opened` record after the header) and deletion removes them all.

`src/main/addons/` is the add-on machinery: `manager.ts` (`ensure`,
single-flight, typed failures), `store.ts` (the atomic install under
`<dataRoot>/addons/<id>/<identity>`), `manifest.ts` (the `addons.json` and
`addon.json` schemas, the latter carrying the folder's `contributes`),
`downloader.ts` (the catalogue and one archive), `devSource.ts` (`out/addons`
for a build from this repository), `addonHost.ts` (the generic `AddonHost`: a
hidden window, the sessions, the address policy, the pane URL, a log line),
`loader.ts` (ensure → `import()` → `apiVersion` → `activate`, once per add-on,
success-only caching) and `testProbe.ts` (an unpackaged-build-only probe for the
E2E). The pins parser moved to `src/shared/addons/pins.ts` because the renderer
reads the pins too. `updates/download.ts` is the one verified archive download,
shared with the updater.

`main/webview/` is the browser pane's runtime: `session.ts` owns the single
persistent Electron session (proxy, TLS exceptions, cookie persistence),
`proxyPolicy.ts` / `proxyAuth.ts` / `certificateExceptions.ts` /
`proxyResolution.ts` are its network policy, `bridgeBroker.ts` +
`bridgeTransport.ts` carry a fetch across the boundary, and `toolHttpLog.ts`
writes `logs/tools.log`. `responseHeaderFilter.ts` is the one rule list that
rewrites a response's headers before Chromium classifies it - the default rule
drops `Content-Disposition: attachment` from a renderable media type, because
AEM serves a DAM asset URL that way and the link click would otherwise become a
download the session cancels (so the asset previews instead of appearing dead).
A host- or content-specific case is a new rule entry (`hosts`, `contentTypes`,
`disposition`, remove/set mutations), never a branch in the session wiring.
None of it is AEM-specific.

`main/aem/` holds what is AEM-specific: `resourceUrl.ts` and `queryUrl.ts`
build URLs, `responseValidation.ts` classifies HTTP responses,
`queryResponse.ts` reads QueryBuilder semantics, `getJsonProjection.ts` /
`queryProjection.ts` shrink results, `aemGetJson.ts` / `aemQuery.ts`
orchestrate.

`main/browser/` owns the browser pane: `browserController.ts` (the state machine),
`hostView.ts` (the `WebContentsView` and its preload/session wiring),
`navigationEpoch.ts` (**how a late result from a previous page is rejected** —
central to correctness), `serverSwitch.ts`, `certificatePrompt.ts`,
`urlPolicy.ts` + `windowOpenPolicy.ts` + `windowOpenRouter.ts` (http(s)-only URL
policy; new-window requests classified as popups - `window.open` with window
features, left as real windows for SSO - vs tabs, loaded in the same view),
`viewBounds.ts`.

`main/credentials/` remembers the sign-ins the pane has seen submitted and puts
them back: `credentialVault.ts` (the store - `(origin, username)` keyed, the
password in `secretStore`/DPAPI, a plaintext `sign-ins.json` index holding no
password, everything loaded into memory once at startup so the fill and
`login`-event paths are synchronous), `capture.ts` (the `credentials:captured`
listener; **the origin comes from `event.senderFrame.url`, never from the
payload**, top frame and http(s) only), `autofill.ts` (attaches to every
`WebContents` in the pane's session via `app.on('web-contents-created')` - so
`window.open` SSO windows are covered - and injects on `dom-ready` /
`did-navigate-in-page`), `fillScript.ts` (the injected script: empty fields
only, one non-hidden password field only (AEM's sign-in form also carries hidden
new/confirm-password fields), no `new-password`, no submit, bounded
`MutationObserver`, and a typed different saved username swaps the password),
and `hostAuth.ts` (an `isProxy: false` `app.on('login')` challenge is answered
from the same vault - the sibling of `webview/proxyAuth.ts`, with the same
one-time-callback discipline). The Settings "Browser" tab's only management is
**Erase saved sign-ins** (`credentials:erase`, all-or-nothing, through the
shared destructive-confirm prompt), a button that stands alone: there is
deliberately no list, no picker (see `docs/backlog.md` "Saved sign-ins: a
per-origin picker") and no stored count - a number beside the button had no
action attached to it. `appPaths.credentials` is technical, under
`%LOCALAPPDATA%\etoolbox-daisy`.

**Names describe what a thing is: `AEM` only for AEM-specific behaviour.**
The browser pane, its preload (`webview-preload`), its persistent session
(`main/webview/session.ts`, partition `persist:webview`), the bridge
(`contracts/webviewBridge.ts`) and host switching are generic - a configured
host may be any web application, not only AEM. The `aem_` prefix and the AEM
vocabulary belong to what genuinely speaks AEM's own APIs: `aem_query`,
`aem_get_json`, `aem_create_page`, the semantic search, the JCR path linkifier,
and AEM's editor/shell URL shapes. Do not name a generic component after AEM.

### `src/renderer/`

**Adobe Spectrum Web Components for all UI** —
<https://opensource.adobe.com/spectrum-web-components/>. Twenty-one packages,
all pinned to `1.12.2` (including `alert-banner`, which renders the browser
pane's status/message row, and `contextual-help`, the Settings fields' help
badges); add new ones at that same version. Elements are registered by
side-effect import in `src/renderer/src/main.ts`.

**Banner copy never ends with a period.** Every message row
(`lib/alertBanner.ts`'s `sp-alert-banner` surfaces) reads as a label, not a
sentence: "Settings saved", "No agent available. Browsing AEM still works",
"Exported to table-20261014-101530.csv". A trailing period is never added, and
in-text sentences are joined with a period only where they need it. An E2E once
failed precisely because a helper text had no period while its assertion
expected one (AGENTS.md §11) - that asymmetry is the rule, applied to the app's
own copy.

**Every Settings field carries contextual help.** Each field's label row is
built by `settings/fieldHelp.ts`'s `labelledField(fieldId, label, control,
helpText)` - the visible label, then an `sp-contextual-help` badge immediately
after it - or, for a control with no label of its own (the Browser tab's
checkbox), a bare `createContextualHelp(text, accessibleName)` in a
`.field-label-row`. A control that is not an input at all carries none (the
Agents tab's auth row is a status light, not a field). The help is one short
phrase stating the field's role and then its limitations, **fixed in code**
(there is no translation layer and none is planned), **never ending with a
period**, and every Settings field must have one: new work is a call to
`labelledField` with its own text, never a hand-written `<sp-field-label>` +
control pair. The per-section tests assert the exact badge set
(`tests/unit/renderer/settings/*.test.ts`), so a field added without help fails
them. The badge derives its accessible name from the visible label
(`Help: <Field>`, a `(required)` suffix dropped), opens its popover
`bottom-start` so it stays inside the panel, and is styled by `settings.css` as
an understated marker - 80% scale, 70% opacity at rest, returning to full opacity
on hover, with no fill or content-colour change.

`chat/` separates view-model from view on purpose: `transcriptViewModel.ts`,
`composerViewModel.ts`, `historyViewModel.ts` and the query tool's `queryResultViewModel.ts` (now in
`src/tools/aem-query/renderer/`) are pure and heavily tested; `transcriptView.ts` and `composer.ts` only render. `renderMarkdown.ts`
goes through `marked` + `DOMPurify`. **Never set a cell or message with
`innerHTML`** — the transcript uses `textContent`, and there are mutation tests
guarding that.

**History is a whole-size panel, like Settings.** `shell/historyPanel.ts` lists
the stored conversations (`window.daisy.agentChat.listConversations`, derived in
main); each row is a title, a start date, and (only when the chat names a
configured host) a host chip. The list is **loaded in small batches**: the panel
matches a real paged IPC - `listConversations({ next })` where `next` is an
opaque cursor - and appends each page as it arrives, so a folder with many
journals (or one on a slow disk, where every journal read is expensive) paints
its first rows immediately instead of staying blank for the whole scan. The
pager lives in main (`src/main/chatHistoryPager.ts`): the first call snapshots
the chats directory's observably present ids once (cheap - file names and
mtimes only), orders them newest-first by journal mtime, and serves 25 journals
(`HISTORY_PAGE_SIZE`) per call, handing back a `next` only while more remain;
an unknown/expired cursor (`CHAT_CURSOR_TTL_MS`, 5 min) starts a fresh scan,
and an exhausted scan is dropped. The panel paints the first page at once but
holds the later pages back and appends them together (`HISTORY_COALESCE_MS`,
500 ms of the list standing still, or the end of the scan), because every
append resizes the scrollbar thumb and a shrink per page read as jitter. A list
already showing (a reopen, a delete's settle) is kept until its replacement is
ready and swapped in whole - blanking and refilling it was the visible twitch.
`listChatHistory` (one whole scan) is gone,
replaced by `snapshotChatHistoryIds` + `readChatHistoryPage` in
`src/main/chatHistory.ts`.

The rows carry no buttons of their own: **one set of actions travels**. The
panel builds `Resume` (the `sp-icon-replay` glyph), `Reveal in folder`
(`sp-icon-folder-open-outline`, the chat footer's own `revealJournal` call - the
two reveal controls wear the same glyph - main derives
the journal path from the id) and `Delete` once, and re-parents that one element
into whichever row the reader hovers or tabs to (`mouseenter`/`focusin`), so
each row reserves the same strip and no row carries a second set; the click
handlers read the currently-anchored conversation. Visibility is CSS -
`visibility: hidden` until the anchored row's `:hover`/`:focus-within` - and
because a hidden control cannot take focus, the panel reaches the row first and
then the button when it restores the caret after a repaint. **Delete**
confirms in the pane's message alert banner. That
confirmation is the one shared destructive-confirm method
(`confirmDestructiveAction`, `settings/statusBanner.ts`): a sticky, one-button
`Press {action} to <phrase>` prompt in the pane-owned
status row, the same one Settings uses to remove a host/project/proxy - never a
row-local second dialog. The panel is handed that
sink (`browserPane.surfaceStatus`) rather than creating a banner of its own. The

**A confirmation prompt is modal, and the strip is how it is shown - not how
modal it is.** A `showPrompt` row asks a yes-or-no question about what is on
screen, so while it is up the region it was raised over is taken out of reach:
the banner is created with the page-view slot as its `blockingScope`
(`createStatusBanner({ blockingScope: viewSlot })`), and the prompt sets `inert`
on that slot plus `banner-blocked-scope`, which lays a **white veil** over it
(62% `--spectrum-white-rgb`, so the content under it shows through at the weight
of disabled content) over the Settings/History panel,
the hosts picker or the home veil behind it (`styles/banner.css`). `inert` is
the whole block - pointer, tab order and the accessibility tree - so no control
behind a prompt needs disabling individually, and the row itself sits below the
slot, outside the scrim, so its copy and OK stay live. The row also runs the
**same one-time accent wash a new `ask_user` question runs**, defined once for
both surfaces in `styles/attention.css` (`banner-row--attention` here,
`chat-composer__frame--attention` there, one `@keyframes`). Two rules keep the
blocking honest: **Escape answers "no"** and only drops the prompt - the banner
listens in the window's capture phase, ahead of the panel's own document-capture
Escape handler, so the panel stays - and **leaving the panel cancels the
prompt** (`browserPane.ts` calls `surfaceStatus.cancelPrompt()` in
`openPanel`, `closeActivePanel` and the veil-clearing branch of
`revealPageForExternalNavigation`), because a prompt is anchored to the rows
that raised it and a prompt left over another panel would act on rows no longer
on screen. Everything else in the row is unchanged and **not** blocking:
`showNotice` (Open in folder / Details), `showError` (including a failed
navigation's `Reload`), `showStatus`, the standing floor and the loading row.
The browser toolbar's own certificate and unknown-origin prompts
(`browserToolbar.ts`) are deliberately **not** modal: they answer a refused
navigation rather than protect a panel, and the page behind them is the native
`WebContentsView`, which no DOM scrim can paint over - see `docs/backlog.md`.

The chat toolbar's History button and the
browser pane's home screen (its "History" action, beside "Select a host" and
"Settings") both open it through the same
`BrowserPanelHost`; the shell owns resume (it starts `browser.switchServer` for
the chat's host *alongside* `chatPane.openConversationFromHistory(id, { hostSettled })`,
which paints the journal first - so a slow or unreachable host never holds the
transcript back - resumes the session whatever the host did, holds a *send* until
the switch settles, and reports a failed resume rather than silently starting
fresh) and delete (`agentChat.deleteConversation`, then
`chatPane.handleConversationDeleted` for the open chat and the last-chat pointer).

**At most one "unfinished process" indicator is on screen.** A running tool-call
billet supersedes the transient "Thinking" item (`transcriptStore.ts`'s
`thinkingVisible` requires no running tool call), and while the turn is blocked
on an `ask_user` question the *running billet* is hidden too — `transcriptView.ts`'s
`hiddenWhileAwaitingInput`, which reads `TranscriptStore.isAwaitingUserInput()` and
skips only ordinary billets, so a question
(`presentation: 'conversation'`) and a `format_table` result (`'message'`) stay
visible. A running billet's progress line is written in place (the billet is
rebuilt only when its non-progress content changes), so a spinner never restarts
on a tick. **A billet may only spin while its turn is live.** Recording an
interruption settles the calls that turn had in flight (and a `format_table`
still counting), a turn leaving the in-flight state settles anything it left
running, and a transcript rebuilt from the journal settles every call the journal
never resolved (`TranscriptStore.abandonRunningToolCalls`, called by
`journalReplay.ts`) — all three read the calls' own statuses, never only the
store's `runningToolCalls` index, because that index is what an interruption
empties. So a call the journal never resolved — the app closed mid-turn, or a
navigation cancelled it — shows `Interrupted` with the static icon, never a
spinner that can never stop; a real result arriving afterwards still overwrites
the placeholder. The one exception is a
turn that ended **waiting on the user** (an unanswered `ask_user`): nothing was in
flight, so its calls settle as `abandonedAwaitingInput` and show **no status word
at all** — just the tool name and the settled icon (`journalReplay.ts` spots the
still-running conversation call and passes `awaitingInput`; a call the app died
under while it was *working* still reads `Interrupted`).

**The ongoing billet is the transcript's lowest entry.** `transcriptView.ts`
renders settled entries in journal order, then moves every ongoing entry — the
running tool-call billets and the Thinking row, but not a `format_table` message
or a pending `ask_user` conversation — after them (relative order preserved).
The move is presentation only: the store, the journal and a restored transcript
keep journal order, so a future restore may show the old entry where it was
recorded. A repaint whose rendered order changed reports the bottom-most
ongoing billet as a reveal target (`TranscriptView.repaint`), and `chatPane.ts`
reveals it: a spinner that appears, or is moved to the bottom by a nested call
settling above it, is brought on screen even for a reader who scrolled up. A
progress tick that leaves the rendered order unchanged does not move the
viewport. This is what stops the outer `aem_semantic_search` billet from being
stranded at the top while its nested `Load more` work happens below it.

**Only one billet is expanded at a time (accordion).** Expanding a tool-call
billet collapses every other tool-call billet and the Thinking billet; expanding
Thinking collapses every tool-call billet. `expandedToolCalls` therefore holds at
most one id and `expandedThinking` is mutually exclusive with it; a repaint
re-applies that one open state. Clicking an open billet still collapses it.

**An assistant message with no text paints nothing.** A tool-only turn (the
model ends it with `assistant.message.completed`, `content: ""`) still has a
message item, and it stays in the store and the journal for debugging — it is
only the *painting* that is skipped, so no empty gray bubble appears
(`transcriptView.ts`'s `isEmptyMessage`; whitespace-only counts as empty, since
`marked` renders it to nothing). A message that has *started* but has no text yet
is skipped the same way, so it appears the moment its first delta arrives rather
than flashing an empty frame. A `presentation: 'conversation'` tool call (`ask_user`)
that paints nothing — an `actions` prompt, or a question still pending in the
composer — is skipped by the same rule (`transcriptView.ts`'s `isEmptyConversation`),
so no empty `.chat-ask-user` shell is left between billets either; the call stays
in the store and the journal.

**The application owns the transcript's scroll position.** `chat.css` pins
`overflow-anchor: none` on `.chat-transcript` so the browser's own scroll
anchoring cannot move `scrollTop` behind `transcriptFollower.ts`'s back: the
follower reads *any* `scroll` event at a position it did not set as the reader
scrolling away, and a restored transcript whose `sp-table`s are still measuring
many times their final height is exactly where anchoring would do that (see
`docs/verification.md` "The restored transcript was not scrolled to the bottom
(2026-10-13)"). With anchoring off, the only position the browser picks by itself
is a clamp to the maximum — which still reads as "at the bottom". Do not remove
that rule as a tidy-up.

**The hosts picker carries the open page.** `browserPane.ts` routes a panel
selection to `toolbar.navigateToHost(origin)`, which opens the page on screen on
the picked host (`resolveContextualHostUrl`, `src/shared/tools/core/navigation.ts`)
and otherwise the bare origin. It carries path, query and fragment, but only for an
allowlisted leading segment (`CARRYABLE_PATH_ROOTS`: `/content`, `/editor.html`,
`/sites.html`, `/assets.html`, `/assetdetails.html`, `/aem`, `/mnt/overlay`,
`/crx`, `/system`, `/ui` (`/crx` and `/system` are whole subtrees, with one carve-out: a
`logout` segment under either is never carried)), never with an authentication parameter, never from a page that is
not on a configured host, and never while the Home veil, an error row or no
document is up; re-picking the open host loads its root. `navigateTo(origin)` and a
typed address are unchanged and are the escape hatch. Widening the allowlist is the
one constant; the origin always comes from the picked host.

**The chat footer carries a token gauge and opens a Usage panel.** The gauge sits
right before the reveal-log control and reads gross input then output for the
whole conversation (`↑ 12.3k ↓ 1.8k`, exact figures in its tooltip). It is
**hidden whenever nothing was reported** - a new chat, a restored one whose
journal has no usage, an agent that reports durations only - never zeros or
dashes. A total some call did not report is a lower bound (`≥`). A click opens
`shell/usagePanel.ts` through the same `panelHost` as Settings/History; the pane
projects the rows (`chat/sessionUsage.ts`'s `describeUsagePanel`) and the panel
only draws them. The projection is agent-neutral (it reads only the normalized
events, live and replayed from the journal), keeps costs of different units apart
and never derives a figure it cannot prove (uncached input needs input and cache
reads from every call). New session and a History resume rebuild it.

**An application-caused navigation reveals the page over any panel.**
`browserPane.ts` dismisses its active panel (and clears the Home veil) when a
navigation *the application* causes begins, so the destination is never hidden
behind Settings, History or the hosts picker. Two signals reach the one
`revealPageForExternalNavigation`: the toolbar's `onNavigationStarted` (a
transcript link, a typed/selected address, Back/Forward, Refresh - all
renderer-initiated) and the agent's `browser_navigate`, which main announces
with the `browser:agent-navigation` push (`browserController.openForAgent`, sent
once the target has validated) that the app preload exposes as
`window.daisy.browser.onAgentNavigation`. An in-page navigation produces neither
- it surfaces only as `browser:state-changed` - so a panel the user opened is
left alone while the AEM page navigates itself.

**Application-wide keyboard shortcuts have no menu to hang off.** `index.ts`
clears the application menu, so a shortcut cannot be an accelerator - and the
browser pane is a `WebContentsView`, so a renderer key listener would do nothing
while the AEM page has focus. Main therefore matches a keystroke in
`before-input-event` on *both* the shell's and the browser view's `WebContents`
(`src/main/shortcuts.ts`, attached by `browserController.ts`, which holds both)
and pushes a *semantic* action (`app:shortcut`, `src/shared/shortcut-ipc.ts`); a
thin dispatcher in `shell/mainShell.ts` runs the very handler its toolbar or
panel control runs, never a second navigation path. The home screen advertises
these keystrokes in a static **Shortcuts** section (`homeScreen.ts`'s
`HOME_SHORTCUTS`, beneath "Useful commands"); that list is hand-maintained prose
and **must be revised whenever a shortcut is added, edited or removed**, so it
cannot drift from the key map. A unit test cross-checks every advertised
keystroke against `resolveShortcut`, so an entry that no longer names a live
binding fails the suite. The home screen's hero and action buttons are a **fixed
header**; only the sections beneath them scroll (`homeScreen.ts`'s
`browser-home__header` / `browser-home__scroll`), so the scrollbar starts below
the buttons and never runs up under the close control's pinned top-right
position and its hover backdrop - do not fold the header back into the scroll
box. Chat actions (`Ctrl+H`,
`Ctrl+,`, `Ctrl+N`) bind on the shell only, so the remote page keeps its own
`Ctrl+<letter>` editing shortcuts; `Ctrl+B` is deliberately unbound (bold in
AEM's rich-text editor). Backspace-to-go-Back is deliberately **not** bound:
whether the caret is in a text field is only knowable in the renderer, and
Chrome removed the browser-wide form of it for exactly that data-loss reason -
so there is no renderer-side shortcut at all. Zoom (`Ctrl+NumpadAdd` /
`Ctrl+NumpadSubtract` / `Ctrl+0`; Ctrl+wheel is deliberately not a zoom gesture)
is acted on in main and never crosses the boundary: `resolveShortcut` returns a
union (`{kind:'action'}` / `{kind:'zoom'}` / `{kind:'find'}`), and
`attachShortcutHandling` applies `applyZoom` (`src/main/zoom.ts`) to whichever
view the input landed on - so the focused pane is zoomed with no routing.
Shortcut matching accepts both `input.code` and `input.key`: a real OS keystroke
can carry an empty `code` (the numpad's `+`/`-` arrive as `code: ""`, `key: "+"`),
which is exactly why the numpad zoom keys did nothing while the letter shortcuts
worked - see §8. Find (`Ctrl+F`) does cross it, for the AEM page: the bar is renderer UI
(`shell/findBar.ts`, one instance per pane, only one open at a time) over a
`FindController` (`shell/findController.ts`) and a debounce
(`LIVE_SEARCH_DEBOUNCE_MS`). The **browser** bar's controller drives Chromium's
`findInPage` over the browser view: main resolves the logical target to a
`WebContents`, and the `browser.find`/`stop-find` invokes plus the
`browser:find-result` push carry it. The **chat** bar searches the transcript
subtree directly (`chat/transcriptFind.ts`) and highlights with the CSS Custom
Highlight API - Chromium's find cannot be scoped, so run on the shell document it
also matched the query in the find bar's own field and the composer's placeholder
and its stepping wandered between those and the transcript; the scoped search
recomputes after a transcript repaint (`FindController.refresh`).
`attachShortcutHandling` maps the neutral find key to `browser.find` for the AEM
view or `app.find` for the shell, which routes by `document.activeElement` inside
`mainShell.ts`. The browser bar is a control *of the page*: it opens only while a
document is visible (no panel, no Home veil) and closes when a panel/veil opens.
Shell page zoom is compensated where the reserved rectangle is reported
(`browserController.setViewBounds` × `getZoomFactor`) so the native view never
drifts. See `docs/verification/followons-2026-10.md` "Find-in-page and zoom …
(2026-10-16)".

`dev/` holds **dev-only modules** — manual previews/mocks that are never
business logic and are unreachable in a packaged build (gated by
`window.daisy.devTools`; see §9). The first is the ask-user preview: the pure
parser `dev/askUserPreview.ts` (`!!ask ...`) plus `dev/askUserPreviewTrigger.ts`,
a factory that owns all of the preview's state and turns a parsed request / a
submitted answer into the synthetic `AgentEvent`s the pane paints. The pane
(`shell/chatPane.ts`) wires the factory and paints what it returns, so a preview
is retired by deleting its files under `dev/` and the single marked wiring block
in the pane. The second is the **open-by-id trigger**: the pure parser
`dev/openChatById.ts` (`!!open <chatId>`) plus the pane's
`openStoredConversation`, which reads that chat's journal, paints it, and
opens/resumes it (the header's session id first, else a fresh session under the
same id) — the only way to reach a chat the last-used pointer and its host gate
can never select. The **update preview** is `dev/updatePreview.ts`
(`!!update <version>` / `!!update off`): it injects a synthetic `UpdateStatus`
through `lib/updateStatusFeed.ts` (the one subscription point that
`mainShell.ts` and the Updates tab use, beside main's push), so the chat
notice, the Home link and the Settings button all show a pending update with no
manifest or IPC. A fourth module, `dev/devCommands.ts`, is the one **command
registry**: each command exports its `[form, description]` usage lines, and the
registry answers a lone `?`/`help` argument for all of them (`!!ask ?`,
`!!open ?`; `!!?` lists every command), printing the usage into the transcript
as a synthetic assistant message. It is checked *before* the command parsers, so
`?` is never mistaken for an argument. Keep new dev-only modules here rather
than mixing them into `chat/`/`shell/`. These modules are intentionally
**untested** — they exist to exercise other code, and testing the test tooling
is redundant (their behaviour is covered end-to-end by the real features'
specs).

### Tools are plugins: one folder under `src/tools/<name>/`

A tool is a self-contained folder; **deleting the folder removes the tool**
(main registry, renderer registry and transcript rendering all discover tools
with `import.meta.glob`, no central list to edit). Nothing else may import from
a tool folder.

```
src/tools/<name>/
  tool.ts              exports `tool: ModelToolModule` (manifest +
                       createExecutor) - or `tool: InternalToolModule` (name +
                       createExecutor only; no model-facing surface)
  <name>.ts            the tool's own request/result types, URL building, projection
  renderer/index.ts    exports `renderer: ToolRendererModule` (describeCall = getDetails;
                       `readConversation` for `presentation: 'conversation'`,
                       `readTableMessage` for `presentation: 'message'`)
```

- The contract lives in `src/shared/tools/core/` (`toolModule.ts`,
  `toolRenderer.ts`, `jcrPath.ts`). The unions are **open**: each tool owns its
  own args/result types; `src/shared/tools/index.ts` no longer lists tools.
- `tool.ts` manifest: `name` must equal `descriptor.name`, `allowlistEntry` must
  be `custom:<name>`, `disabled: true` switches it off (loader, executor and
  instructions are all skipped). An **internal** tool (`internal: true`,
  `InternalToolModule`) declares none of `descriptor`/`allowlistEntry`/
  `instructions` - the model never sees it. A load failure, bad shape, name mismatch,
  duplicate name or throwing `createExecutor` disables **only that tool**; the app
  logs `TOOL_REGISTRATION_FAILED` and continues (`src/main/tools/registry.ts`).
- ESLint (Rule 4) confines a tool to its own folder plus `src/shared`; renderer
  code may not import Node/Electron. Proof fixture:
  `tests/fixtures/eslint-violations/tool-boundary-violation.ts`.
- Limit: a **type error** in any tool, even a disabled one, still fails global
  `tsc`. Only deleting the folder (or fixing it) avoids that.
- `aem_create_page` is present but `disabled`: the bridge is GET-only (rule 4
  stands) and it has no renderer yet.
- `ask_user` is not an AEM read: it puts a choice to the user and blocks the turn
  until they answer, through `ToolHost.requestUserInput` (resolved from the live
  turn, never from model input). It deliberately does **not** use
  `createToolExecutor` (that builder requires a live host), and it renders
  as a conversation rather than a billet: its renderer sets
  `presentation: 'conversation'` and supplies `readConversation`, so the
  transcript paints the question as an assistant message and the answer as a
  user message. It also has an **actions** mode (`actions`: 1–4 button labels,
  mutually exclusive with `options`/`freeInput`): the composer shows one button
  per action (no text field, no Send) and a single click answers immediately -
  the search skills use one, `["Load more"]`, with the composer's Stop as the
  cancel. An actions-only call has no `question`, so the transcript paints
  nothing for it - no empty `.chat-ask-user` shell is left either (see the
  "no text paints nothing" rule above; a pending question is skipped the same
  way). The SDK has a built-in `ask_user`; this app leaves it
  un-allowlisted and ships its own (see docs/compatibility.md 4.3). A dev-only
  `!!ask ...` composer trigger previews the UI locally (see section 9).
  Presentation: every mode washes the composer frame accent-blue once and fades
  to that variant's resting background (`chat-composer__frame--attention`, removed
  on `animationend` so a repaint cannot replay it); a one-click-actions or
  >5-option dropdown question wears a gray, borderless "strip" frame
  (`chat-composer__frame--strip`) and paints its "type your own answer" control
  and Submit as light-surfaced, dark-content buttons rather than blue, while the
  radio/checkbox variants keep the white framed input with a blue link and Send.
  See `docs/verification.md` "The ask-user question flash and the dropdown strip
  styling (2026-10-12)".
- `aem_query` is **JSON-only**: it renders no table. Its `toPayload` keeps the
  structured `rows`/`pagination`/`selection` so the model can hand the result on
  (and so a diagnostic sees it), but the transcript shows only the billet. Its
  instructions point the model at `aem_query_format_ask` to show results.
  **The capped total:** every page request sends a numeric `p.guessTotal=100`
  (`TOTAL_GUESS_CAP`), so the total is `exact` below 100 and an `atLeast` lower
  bound at it (never the old, false `estimated`); `hasMore` is derived, not copied
  from `more`. See §8's QueryBuilder fact.
  **Priority paths:** when the pane's host selects a project with *Priority
  paths* (`contentPriorityPaths`, read at execution time from
  `host.environmentFacts()`, never from the model), a `roots` or plain-`path`
  query runs as ordered *segments* (`planPrioritySegments`, `executePrioritizedQuery`
  in `aemQuery.ts`): each priority path first, in written order, then the rest
  of each scope root with the priorities excluded through an `excludepaths`
  regex. (A `N_group.p.not` path group does **not** negate a `path` predicate -
  verified live 2026-10-13 - so the earlier group silently excluded nothing and
  the "rest" segment lost matches.) Paging is a stateless offset mapping across
  the segments, so **Load more** shows no seam; an unprovable segment end
  degrades to `hasMore: 'unknown'`. See `docs/compatibility.md` §11.4 and
  `docs/backlog.md` "Priority search paths".
- `format_table` is the **only** table renderer. It was internal; it is now
  **model-callable** too (descriptor, `custom:format_table` allowlist entry and
  instructions), so a custom skill can show its own table. The composites still reach
  it through `invokeTool`; `ToolRegistry.internalNames` is now only `memo_reflection`.
  It also takes optional typed `columns` (`{ key, label?, type?: 'text' | 'status' }`)
  and a `title`; `data` is an array of row objects. It also takes `mode: 'new' | 'append'`, an
  optional `totalLine` that replaces the derived total text, and an optional
  `totalPending: boolean` that draws a small spinner before the total while an
  exact count is still being fetched (the run's **last** call decides it, exactly
  as it decides `total`). Its
  renderer sets `presentation: 'message'` + `readTableMessage`, so the transcript
  paints an assistant message - a `#`-prefixed Spectrum table with the total
  line beneath it (only the total line when the run has no rows), the Path cell clickable, every cell via
  `textContent` - instead of a billet. `transcriptView.ts` groups
  `format_table` calls into **runs** (new starts one, append adds to it), unions
  the columns, and paints one table at the run's last call; the call lines are
  hidden. `getDetails()` is the safety net only: `N rows` / `Rows: N`. Cells go
  through the one AEM linkifier (`splitAemPathLinks` in `linkTargets.ts`), the
  same core the markdown surface uses - so an absolute `http(s)` URL (a
  configured host -> pane, any other -> system browser) and a full AEM path are
  links in any column, not only `Path`, and a **page-relative** `jcr:content/...`
  value is a plain, non-navigating hover target offering only its node's **CRX**
  (no Edit, no cursor, no hover styling), resolved against the last full path the
  run rendered - carried cell-by-cell, row by row, so a blanked repeated page path
  still resolves and a `Load more` append continues it. The segment-to-DOM
  rendering is shared in `linkSegmentDom.ts`; a column header only picks a
  presentation class (clamp/wrap), never linkification. **Its gutter has two
  bands - the header band (the column-header row, and, while the message holds
  nothing but the table, its heading and its total line, the message surface
  above it) and the footer band (the total line, and the message surface below
  the table) - and offers Copy and Export**, in the same travelling hover
  popover the Edit/CRX link actions use (the regions + actions are
  `tableHover.ts`'s `tableGutterFrom`/`tableHoverActions`, with
  `isTableDataRow` excluding the rows and the side padding alongside them lying
  in neither band; the popover itself is the now-generic `hoverActionPopover.ts`,
  `HoverAction[]` instead of link actions only, and its `HoverActionPlacement`
  puts a gutter popover at the anchor's top-right (`top-end`) or - for a table
  that draws no total line - at its bottom-right (`bottom-end`), so the buttons
  hang **below** the table instead of rising over its last row). A message that
  carries prose of its own keeps the popover on the table's own chrome. **Each
  band is one affordance:** the popover is positioned where the pointer enters a
  band and is never re-anchored while it stays there, so moving one pixel off the
  header row into the message's own background leaves the buttons exactly where
  they are - `transcriptView.ts`'s `HoverTarget` compares gutter hits by
  **shell and band**, not by the element they resolved to, while crossing to the
  other band deliberately re-anchors it. Copy writes tab-separated
  `text/plain` plus an HTML `<table>` to the clipboard so a paste into
  Excel/Google Sheets keeps the grid; Export hands a CSV
  (comma/CRLF/UTF-8-BOM) to main, which shows the OS save dialog and writes the
  file (`table-export:save-csv`, `src/main/ipc/tableExport.ts`). Both serialize
  the displayed table - header, data rows, and the total line as a trailing row,
  without the `#` index column (`tableExport.ts`); a run with no columns offers
  neither, and a cancelled dialog is not an error. The buttons wear
  `sp-icon-copy` / `sp-icon-export`, and a successful export raises the chat
  pane's sticky notice - "Exported to table-20261014-101530.csv <Open in
  folder>" (`StatusBanner.showNotice`; banner copy never ends with a period)
  - whose action reveals the written file in the OS file manager through
  `table-export:reveal-last` (no payload: main remembers the path it wrote, so
  the renderer can never steer the reveal) and dismisses the notice. The gutter
  popover is **right-aligned to the table**, not centred on it (a link's stays
  centred).
- `environment_facts` reports **every configured host** as a label, an origin and
  its effective content/component/DAM roots, flagging the one the browser pane is
  currently on. It takes no arguments: the application resolves the facts from
  the settings document and the live pane URL, through
  `ToolHost.configuredHosts` / `ToolHost.environmentFacts` — never from model
  input. Its success payload is structured, so its renderer can read it:
  `describeCall` receives the succeeded result as a second argument, letting this
  zero-argument tool summarise the call with the current host's URL and show the
  hosts as collapsible rows. It deliberately carries no `aem_` prefix: "environment
  facts" is a question any environment could answer (see the naming rule below). A
  host's roots now live on the **project** it selects: `ServerConfig` carries only
  an optional `projectId`, and a project (`projectConfig.ts`) holds the free text
  (`contentRoots`/`componentRoots`/`damRoots`); `src/shared/tools/core/environment.ts` owns the
  one interpretation of that text (comma-or-semicolon split, comma wins, trimming,
  the `/content`/`/apps`/`/content/dam` defaults), the nesting-aware `effectiveRoots`, and
  `resolveHostEnvironmentRoots(host, projects)` — the one place a host is resolved
  to its roots (defaulting when it selects no project). Shared by the tool, the
  per-turn context block and `aem_query`'s `roots` fan-out. The model never sees
  the project: only the resolved roots, as before. `resolveSearchRoots` is the
  one exception that adds DAM roots — content then DAM, collapsed — and only the
  two search composites use it, so a plain `aem_query` never traverses DAM by
  default.
- **`http_fetch`, `page_read`, `page_audit`** (2026-10-25, for custom skills; see
  `docs/custom-skills.md`). `http_fetch` `{ url, method?: GET|HEAD, accept? }` fetches
  through the pane's authenticated session for a configured host, else through
  `ToolHost.externalFetch` (`src/main/externalFetch.ts`: cookie-less, public hosts only -
  link-local, metadata, loopback and private addresses are refused). `aem_get_json` is a
  composite on it (`uses: ['http_fetch']`; its nested billet is `transparent`).
  **That anonymous fetch pins the address it validated**: a name is resolved once per
  hop, every answer checked, and the connection goes through an undici `Agent` whose
  `connect.lookup` returns only those addresses (a resolution failure or an empty answer
  is a refusal, never "let the request decide"); the address table covers the full
  non-public IPv4 and IPv6 sets, including mapped/NAT64/6to4/Teredo forms; bodies are cut
  in **bytes of the decoded stream**, at the caller's own limit (the tool passes its
  model or nested limit down) and a cut response says `truncated`. **With a proxy
  configured the proxy resolves the name**, so only literal addresses and
  internal-looking names are checked and address policy is the proxy's
  (`docs/compatibility.md` §11.8). Only an **application** read may be authentication
  evidence: `BridgeRequestOptions.authEvidence` is set by `aem_query`, both composites
  and a nested `http_fetch`, never from a model argument, so a model-chosen `accept`
  cannot latch (or hide) a lost session. `accept` must be 1-200 printable ASCII
  characters.
  `page_read` `{ selector, include?, attributes?, limit?, frame? }` reads the open page's
  DOM through the broker's read channel (`webview-bridge:read`, `ToolHost.bridge.readDom`).
  **Credential-looking values are withheld** (`token|csrf|secret|password|auth|nonce`
  attributes, a hidden or password input's `value`, inline `script`/`style` in `html`)
  behind `[withheld]`, and the result carries `redacted: true`; the walk stops at `limit`
  and at a wall-clock budget without materialising the match list.
  `page_audit` `{ url?, categories?, formFactor? }` runs Lighthouse in a hidden offscreen
  `WebContents` over an in-process CDP transport — and it is **not a `src/tools` folder:
  it is contributed by the `page-audit` add-on** (`src/addons/page-audit/tool.ts` the
  executor, `pageAudit.ts` the runner and its hardening, `pageAuditTransport.ts`,
  `evidence.ts`, `types.ts`). Nothing outside that folder knows the tool exists: the
  build derives its declaration into `src/shared/addons/pins.json`, and the application
  registers a proxy (`src/main/tools/addonProxy.ts`) that advertises it from the first
  launch and loads the add-on on its first call (`src/main/addons/loader.ts`). Its
  billet comes from the pins' `billet` spec; its `presentation: 'report'` result
  carries the report under `data.report`, which the renderer paints generically.
  **The tool builds the whole report itself**: one score table (`Category`/`Score`/`Status`
  with the pass ≥ 90 / warn ≥ 50 / fail thresholds), then **one section per category
  holding a table per issue** - every audit that did not pass, **and every weight-0
  `informative` insight Lighthouse measured a saving for** (`metricSavings` > 0 ms or
  `wastedBytes` > 0; Lighthouse 13's performance category weights only its five
  metrics, so its actionable findings are those insights; a breakdown-only insight that
  just explains a metric stays out) - carrying Lighthouse's own evidence - the columns
  from the audit's `details.headings` (a failing element as
  `nodeLabel — selector — snippet — explanation`, an insecure URL, a
  `url:line:column` source location, a console message, sub-items in their own trailing
  column) - and, for an audit with no items, a single `What to fix` row holding
  Lighthouse's own explanation. Nothing is capped, so the report is the full rundown;
  the same evidence stays in the tool result, so the model can discuss a fix afterwards.
  The tables are painted by the app, never copied by the model.
  The runner is serialized with at most two waiting (a third is refused as retryable),
  120 s deadline; a non-configured origin uses an isolated cookie-less session
  (`addon-<id>-anonymous`). **Every** audit's requests - a configured host's included -
  are held to `inspectAuditRequest` (its own configured origins trusted,
  `data:`/`blob:`/`about:` local, the rest through the host's address policy) and again
  to `will-navigate`/`will-redirect`; a configured host's audit shares the pane session
  and filters only its own window, so the user's browsing is untouched; the window
  denies new windows, permissions (scoped to itself) and non-proxied WebRTC UDP, and a
  refused request is reported by URL. That filter is **best effort against DNS
  rebinding** - Chromium resolves the name itself (`docs/compatibility.md` §11.8,
  `docs/backlog.md`). The add-on creates no window of its own: it asks the `AddonHost`
  for a hidden window (which forces `show:false`, sandbox, isolation, no Node and web
  security) and for the sessions, the pane URL and the address policy, so the audit's
  window and its network position stay the application's decisions while the hardening
  inside it is the add-on's. The runner takes an optional third `progress` callback that
  the executor forwards to `reportToolProgress`: the billet reads
  "Downloading add-on page-audit 34%" while the add-on installs, then "Loading tools"
  while the lazy imports run (the slow first audit), then "Auditing the page". Their
  results are untrusted page data (`session.md`). Rule 7.4 is unchanged: `method` stays
  GET/HEAD.
  **Why Lighthouse and Puppeteer are one add-on** (`lighthouse` 13.5.0,
  `puppeteer-core` 25.16.0, in `src/addons/page-audit/package.json` only): Lighthouse 12+
  has no Chrome driver of its own and takes a Puppeteer `Page`; `puppeteer-core` (no
  Chromium download) supplies it through our `DebuggerTransport`, so the audit drives
  the hidden `WebContents` instead of a second browser. Dropping Puppeteer would mean
  writing a Lighthouse driver. Cost: ~137 MB of `node_modules` across ~114 packages
  (largest: `lighthouse`, `@sentry/*`, `@paulirish/trace_engine`,
  `@opentelemetry/semantic-conventions`, `chromium-bidi`), downloaded on the first audit
  and kept under `%LOCALAPPDATA%\etoolbox-daisy\addons`; no `.node` files, so nothing to
  rebuild. Keep both pinned in the add-on's own lockfile (never the root
  `package.json` — electron-builder would package them again) and imported only from
  that add-on.
  Known open: external-HTTPS audits are flaky in the offscreen window, the audit's
  rebinding window, and the packaged `page_audit` has still not run (`docs/backlog.md`).
- A skill's front matter may carry `table-only: true`: the transcript suppresses the
  model's prose for that skill's turn, as it does for the search skills (the
  hard-coded `DETERMINISTIC_TABLE_SKILLS` list is gone; a bundled fallback remains).
- `browser_navigate` opens a page in the browser pane. It also takes an optional `mode` (`view`/`edit`/`sites`/`assets`/`crxde`/`asset_details`/`properties`): with a mode `path` is a raw repository path and the application builds the URL (`shapeModeBrowserPath`; consoles carry no `.html`); without one a verbatim path is completed only by `completeBrowserPath` (extensionless `/content` page gets `.html`). Also a `place` (standard AEM places, application-owned paths), the `admin` mode alias, a repository-root check on modes, and a tolerant `host` (label, origin, host:port). Billet rows: URL / Mode / Place / Result. It takes a host **label**
  (or none, for the pane's current host) and a **verbatim browser path**
  (`/content/site/page.html`, `/editor.html/content/site/page.html`, `/crx/de`);
  the application resolves the label to a configured host and builds the URL from
  that host's own origin, so no scheme, port or origin can reach the pane from a
  tool argument. It calls `ToolHost.openPage({ serverId, path })`, which the
  browser controller serves through `openForAgent`. That navigation is
  **agent-initiated**: it still bumps the navigation epoch (so in-flight requests
  from the previous document are discarded) but does **not** cancel the agent's
  own turn, so the model can move to a host and then resolve a page name there in
  the same turn. A *user* navigation still cancels, as it always did
  (`wireNavigationEpochCancellation` skips only `initiator: 'agent'`); after an
  agent switch settles, if the pane did not land on the target host the epoch is
  bumped as a user navigation, so an in-page link click mid-switch still cancels.
  Because the navigation is the application moving the pane for the user, main
  also pushes `browser:agent-navigation` (once the target has validated) so the
  renderer reveals the destination over any whole-size panel or the Home veil
  (see §5's "An application-caused navigation reveals the page over any panel").
  It is hand-rolled (like `ask_user`), so it works with no active server when the
  host is named explicitly. No `aem_` prefix: navigating a browser pane is not
  AEM-specific.
- **Tool names: `aem_` only for AEM-specific actions.** A tool takes the `aem_`
  prefix only when the action itself has no equivalent outside AEM — `aem_query`
  (AEM's QueryBuilder), `aem_get_json` (AEM's Sling/JSON rendering),
  `aem_create_page` (`cq:Page`). A generic action takes no prefix —
  `environment_facts`, `browser_navigate`, `ask_user`, `format_table`.
- **The search page size is one constant**: `SEARCH_PAGE_SIZE` (20) in
  `src/shared/tools/core/search.ts` is the default `limit` of `aem_query` and
  of both search composites; change it there. `resolveSearchPageSize` is the
  one fallback for an optional parsed argument. For `aem_semantic_search` the
  same `limit` is also the **display** page size: it queries as many hit pages
  as it takes to answer that many matches. The skills carry no page-size
  number - `navigate` and `search-component` omit `limit`, and
  `resources/rules/session.md` tells the model not to choose one; an explicit
  `limit` remains a permitted override. So are the other search limits -
  `MIN_QUERY_LIMIT` (1), `MAX_QUERY_LIMIT` (200, the model-facing cap of
  `aem_query` and both composites) and `LOAD_ALL_ROW_LIMIT` - no tool keeps a
  private limit constant.
- **A tool result may end the turn.** A success payload carrying
  `TURN_COMPLETE_RESULT_KEY` (`'turnComplete'`,
  `src/shared/tools/core/turnCompletion.ts`) tells every adapter to end the
  model's turn at that result instead of resuming it. The two search composites
  set it when a search is finished - the table is the whole answer, so the
  model's follow-up ("search is finished") would only cost a round trip - and
  `aem_semantic_search` sets it on its single final result (it has no
  candidate-result phase). Copilot ends the turn with a quiet
  `session.abort()` + `idle` (never `cancelling`, which the pane paints as an
  interruption); OpenRouter stops the run through its stop condition with
  `allowFinalResponse: false`; the fake ends the scripted turn. See
  `docs/verification/followons-2026-10.md` "A search no longer spends a model
  round after its table (2026-10-15)".
- Tests live in `tests/unit/tools/` (manifests, executors),
  `tests/unit/main/toolRegistry.test.ts` (discovery + isolation + enabled-set
  snapshot) and `tests/unit/renderer/chat/toolRegistry.test.ts`.
- **Tool-to-tool bridge.** A tool's executor may call another tool by name
  through `host.invokeTool(name, args, context)` — the target's real executor,
  validation included — but only a tool it lists in its manifest's `uses`. The
  registry (`createInvokeTool`, `src/main/tools/registry.ts`) refuses a
  self-call, an undeclared target and a nesting deeper than
  `MAX_NESTED_TOOL_DEPTH` (3) with `ACCESS_DENIED`, a missing/disabled target
  with `NOT_FOUND`, and maps a throwing executor to `UNEXPECTED_RESPONSE`; a
  declared `uses` target that is not enabled is reported as a registration
  failure. Each nested call is reported to the chat controller
  (`recordNestedToolCall`) and journaled as ordinary `tool.call.requested` /
  `tool.result` events of the live turn, so it renders **flat** — exactly as if
  the model had made it (a `format_table` still paints its table, an `ask_user`
  still shows its buttons) — and replays from the journal. A tool still never
  imports another tool folder; `invokeTool` is the only coupling.
- **Composite tools are named "base tool + mixins", in run order**:
  `aem_query_format_ask` = `aem_query`, then `format_table`, then `ask_user`. Its
  folder is the kebab-case of the same name.
- `aem_query_format_ask` is the first composite: given `terms` **or** hand-built
  QueryBuilder `predicates` (exactly one; plus optional `roots` — default the
  host's content roots followed by its DAM roots (`resolveSearchRoots`), skipped
  when the predicates carry their own `path` —
  `properties`, and `limit`, default `SEARCH_PAGE_SIZE`) it runs `aem_query`, shows the page with `format_table` (`new`, then
  `append`), and while `hasMore` is not `false` offers `ask_user`
  `{ actions: ["Load more"] }`, looping on each click. The model gets only a
  short summary (`textResultForLlm`), never the rows to relay — the point is
  that weak models no longer have to copy JSON between tools. When the predicates
  match a component by `sling:resourceType`, each hit is shown against its owning
  page: `Path` is the page and a `Node` column is the component node's path
  within it (wrapped at any character, like `Path`; derived from the query,
  never asked of the model), with a repeated page path blanked - one numbered row
  per placement, the page written only on the first. Its billet reads
  `Search: <terms or predicates>` with rows Terms or Predicates, Roots, Page size,
  then Pages, Rows, Total. **The honest total:** when page 1's total is an
  `atLeast` lower bound the composite starts one background count (an un-guessed
  `host.bridge.request` per effective root, sequentially, 5-minute deadline) and
  passes `totalPending: true` on every `format_table` call while it runs; on
  settle it makes one extra `append` carrying the exact `totalLine` (or, on
  failure, nothing - the capped fallback stays, and `AEM_COUNT_FAILED` is logged).
  The count is not a nested call: no billet, no journal entry of its own. It is
  aborted on loop end, on turn cancel, and on `hasMore: false`; a replayed
  transcript settles a leftover `totalPending` (`TranscriptStore.settlePendingTotals`).
  See `docs/verification.md` "An accurate search total (2026-10-13)".
  **Load all** is one request: once an exact total is proven and the remainder
  fits `LOAD_ALL_ROW_LIMIT` (2000, `src/shared/tools/core/search.ts`), a click
  makes ONE nested `aem_query` with `limit` = the remainder and the current
  offset, appended as a single `format_table` block, with no further question.
  That larger `limit` is accepted only for a *nested* call: the bridge
  (`createInvokeTool`) stamps `nested: true` on the `ToolExecutor` context
  (`types.ts`; adapters never set it), and `aemQuery.ts` then validates against
  `nestedAemQueryArgsSchema` (cap 2000) instead of the model's (cap 200).
  `p.limit=-1` stays inexpressible and the descriptor still advertises 200.
  One request must fit the 90 s per-request deadline.
- `aem_semantic_search` **owns the whole search in one call**. It is not
  stateful and has no callback protocol: `{ terms, context, roots?, limit?, filters? }`
  starts it, and the same call runs query -> read -> answer -> paint/ask until the
  search is exhausted or the user declines. The model never sees candidates and
  never decides which match; it supplies only the terms and the meaning
  (`context`), so a model that stops writing cannot strand the search. (The old
  two-call `searchId`/`matches` protocol is gone.)
  Per hit page it runs `aem_query` (via `invokeTool`; default
  `SEARCH_PAGE_SIZE`; roots default to the host's content roots then its DAM
  roots, `resolveSearchRoots`, and a fragment is resolved by
  `resolveSearchScope`), reads **every** hit in parallel (QueryBuilder
  `path.self` + `fulltext` + `p.hits=full` through `host.bridge`, pooled at the
  one application-wide `DEFAULT_REQUEST_CONCURRENCY` (4, the same constant that
  sets the bridge's request slots),
  falling back to the hit itself), and asks the active model about the page with
  **one** call through `ToolHost.answer` - a stateless, tools-disabled model
  call on the active agent (`AgentRuntime.complete` through `answerWith`, implemented by Copilot,
  OpenRouter and the fake). The answer returns one true/false per item; the
  shared prompt/parser live in `src/shared/tools/core/answer.ts`, so every agent
  asks the same question. An unusable answer is retried (`ANSWER_MAX_ATTEMPTS`,
  3 attempts in total: one call plus two retries) and
  then fails the search with `UNEXPECTED_RESPONSE` - never a silent "no match".
  Accepted rows go into `PageFillQueue` through the reusable `runPageFill`
  (`src/shared/tools/core/pageFill.ts`): query/process until `limit` matches are
  buffered or AEM is exhausted, then paint with `format_table` (`new`, then
  `append`). A display page is never painted for a page whose hits mostly failed
  to match, so the old "Did not find any relevant results so far" with a "Load
  more" under it cannot happen. While anything remains, `ask_user`
  `["Load more"]`; a click shows buffered surplus first and probes further pages
  only while the buffer is short, so a surplus answered match is never re-queried
  or re-answered. An empty source page stops probing rather than querying
  unattended. The total line counts the **relevant** matches
  (`describeRelevantTotal`: "Total: N so far", or "Did not find any relevant
  results"; no "so far" once nothing remains). Each matched row's `Path` is the
  **concrete node** the first excerpt's property lives on (`jcr:path` = the
  excerpt's `nodePath`), `Property` its bare name, `Citation` its text (the
  answer no longer picks an excerpt). Progress is
  `Reading i/n · Page n · m/limit collected` while reading,
  `Testing n candidate(s) · Page n · m/limit collected` while the answer runs,
  and `Showing n · Page n · m/limit collected` once a page is taken (the count
  is then the true remainder for the next page; `selectionLabel` clamps it to
  `limit`, so a 23-match overflow after a 20-row page can never read `23/20`),
  through
  `ToolHost.reportToolProgress` (written in place). The billet is summarised by
  the terms alone (plus the page once past the first); it never repeats the
  tool's own name, because the header already reads `aem_semantic_search` (the
  same reason `aem_query` shows `fulltext=...`, never "Query: ..."). The single
  final result carries `ended` and `TURN_COMPLETE_RESULT_KEY`.

#### Secondary agentic turns (a tool that asks the model something)

Some tools make a **secondary agentic turn**: a stateless model call on the chat's
behalf, outside the conversation - the semantic search asking which extracts match
is the first. There is **one reusable routine**, not a per-tool patch
(`src/shared/agents/oneShot.ts`):

- **Agent side - written once per SDK:** `AgentRuntime.complete` runs
  `{ instructions, prompt }` and returns the reply text, reporting every model
  call it makes to the usage sink. It knows nothing of any tool.
- **Application side - bound once:** `createSecondaryTurns`
  (`src/main/agentComposition.ts`, wired in `index.ts`) is the only path to
  `complete`, and it carries the usage sink, so a tool cannot reach the model
  without its tokens landing in the chat's gross totals (journaled, forwarded,
  shown in the gauge and the Usage panel).
- **Tool side - a thin function:** build a prompt, call the bound `complete`,
  parse the reply. `answerWith` is the first (`ToolHost.answer`, prompt and parser
  in `src/shared/tools/core/answer.ts`).

**To add another such tool: write its prompt and parser in
`src/shared/tools/core/` as a `xxxWith(complete, request)` beside `answerWith`,
add a `ToolHost` capability for it built on `secondaryTurns.complete` in
`index.ts` (copy the `answer` line), and touch no agent.** The fake agent already
serves `complete` (`queueAnswer` scripts the reply). A secondary turn that needs
tools, history or events is not this routine - ask first. Retries are the tool's
(`ANSWER_MAX_ATTEMPTS`); each attempt is counted.

#### Recipe: add a new tool

1. **Ask the user first** what the tool exposes: its arguments, what the
   collapsed billet summary says, how the expanded rows read (`getDetails()`,
   see below). The tool is not done until that is agreed and implemented.
2. `src/tools/<name>/<name>.ts` — the tool's own args/result zod schemas, URL
   building, projection and `create<Name>Executor` (use `createToolExecutor`
   from `src/shared/tools/core/toolModule.ts`). Export a `ToolDescriptor`, the
   tool name (`snake_case`, e.g. `aem_get_json`) and its allowlist entry.
3. `src/tools/<name>/tool.ts` — `export const tool: ModelToolModule = { name,
   descriptor, allowlistEntry: 'custom:<name>', instructions, createExecutor(host)
   }` (an `InternalToolModule` = `{ name, internal: true, createExecutor(host) }`
   omits the model-facing fields). `name` must equal `descriptor.name`.
   `instructions` is a paragraph telling
   the model when to use it; it is composed into the session prompt only while
   the tool is enabled. Copy `src/tools/aem-get-json/tool.ts`.
4. Network access only via `host.bridge.request(envelope, url)` (GET through the
   browser pane). **No write path exists** (§7.4); a POST-capable tool needs an
   owner decision and a bridge change — ask.
5. `src/tools/<name>/renderer/index.ts` — `export const renderer:
   ToolRendererModule` with `toolName`, `describeCall` and optionally
   `readResultTable` (see `aem-query/renderer`). Pure data, no DOM/`innerHTML`.
6. Imports: a tool folder may import only its own files and the shared barrel
   (`../../shared`); never another tool, `src/main`, `src/renderer` or an agent.
   Something two tools need goes into `src/shared/tools/core/`.
7. Shared, closed vocabularies: error codes (`ToolErrorCode`) stay shared; a tool
   cannot invent one. Add a code to `src/shared/contracts/errors.ts` only with
   the user's agreement and report it.
8. Tests: `tests/unit/tools/` (manifest + executor), the renderer composition in
   `tests/unit/renderer/chat/toolCallDetails.test.ts`, and **update the exact
   enabled/disabled-set assertions** in `tests/unit/main/toolRegistry.test.ts`
   and `tests/unit/renderer/chat/toolRegistry.test.ts` — they deliberately fail
   when a dropped-in folder silently becomes model-callable. Add an E2E if the
   rendering hinges on a custom element.
9. Consider whether a bundled skill in `resources/skills/` should mention it
   (skills are global and are not hidden when a tool is disabled).
10. `npm run typecheck`, `npm run build`, launch the app, run Playwright; record
    evidence in the current archive under `docs/verification/` (indexed by
    `docs/verification.md`).

**Disable temporarily:** `disabled: true` in `tool.ts`. **Remove:** delete the
folder and its `tests/unit/tools/*` cases (and any registry-set assertion).

### Adding a tool: design its `getDetails()` by hand

`transcriptView.ts` renders every tool call as a borderless, icon-led billet
that expands to show a standard **`getDetails()`** representation — a one-line
summary plus label/value rows — composed by the tool's `renderer/index.ts` and
dispatched by `describeToolCall()` in `src/renderer/src/chat/toolCallDetails.ts`.

**A tool's details are ALWAYS rendered in one exact shape** — the pattern
`aem_query`'s renderer established and the only permitted one: a `summary`
string plus an ordered list of **Title-cased `label`/`value` rows**
(`ToolCallDetails`, `src/shared/tools/core/toolRenderer.ts`). The identifying
value comes first, and an optional row whose value is absent is **omitted**, not
left blank. Build the rows with the shared **`parameterRows([[label, value], …])`**
helper (`undefined` value ⇒ row dropped) so every renderer agrees; never a raw
argument dump, never another shape. `describeCall(args, data?)` may read either
the arguments or the succeeded result — a zero-argument tool reads `data`.

- **Creating a tool includes designing its `getDetails()`.** Do not lean on the
  generic fallback (`describeGenericArgs`), which dumps the raw argument object.
  It exists so an unrecognised tool can never be *invisible*, not as an
  acceptable finished design. Give the tool a `renderer/index.ts` whose `getDetails`
  exposes the command and/or parameters a reader actually needs — e.g.
  `aem_get_json` shows the requested path and the effective `.0.json`/`.1.json`
  request; `aem_query` shows the exact query string.
- **An agent creating a tool must ask the user what to expose.** Which
  arguments, what the collapsed summary should say, and how the expanded rows
  should read are the user's call, not the agent's to guess. The tool is not
  done until that composition is agreed and implemented.
- Cover it: `tests/unit/renderer/chat/toolCallDetails.test.ts`, plus an E2E
  when the composition hinges on a custom element (see §9).

**A failed or rejected call is the same billet, not a different card.** It keeps
the borderless surface and collapsed-by-default disclosure every other call has;
the only visible difference while collapsed is the toggle's icon - a red
`sp-icon-cross600` (`.chat-tool-call__icon--negative`, Spectrum's semantic
negative icon colour, drawn at 12px because the edge-to-edge glyph otherwise
reads heavier than the tool icon in the same 16px box) instead of
`sp-icon-actions` - beside the status word. The
reason is the **last row of the same details table**, appended by
`transcriptView.ts`'s `toolCallProblemRow`: a failed call's `Error` row holds the
error message with the suggested action appended to it, a rejected call's
`Reason` row holds the policy's reason. Nothing is shown outside the disclosure.
Do not reintroduce a tinted surface or an always-visible reason paragraph;
`chat-tool-call__detail` is now only the reason under a failed/rejected
`ask_user` question.

### Add-ons are downloaded plugins: one folder under `src/addons/<id>/`

An add-on is a **self-contained child application, like a DLL**: it owns its
tools, its skills, its third-party libraries, its window and session hardening,
its types and its tests, and the application knows it only through the generated
pins and a **generic** host interface. Nothing outside its folder names it
(`tests/unit/addons/addonIsolation.test.ts` enforces that), and deleting the
folder leaves the repository green with no other edit. Full detail, layout, the
host API, lockfile policy, security notes and the decoupling acceptance:
`docs/addon-architecture.md`. One exists today — `page-audit` (Lighthouse +
`puppeteer-core`, contributing the `page_audit` tool and the `check-page` skill).
The Copilot CLI is **not** an add-on any more: it is GitHub's release channel and
is resolved at sign-in time by the agent that uses it
(`src/agents/copilot/cli/`).

- **Tools are declared, skills are derived.** `addon.json`'s `contributes.tools`
  declares each tool completely (name, descriptor, allowlist entry, instructions,
  presentation, billet); each `skills/<name>/SKILL.md` is parsed with the app's own
  front-matter parser to produce that skill's catalogue entry. The build validates
  both with **one schema** (`src/shared/addons/contribution.ts`) and fails on a
  name the app or another add-on owns, a descriptor that disagrees with its tool,
  a malformed front matter, or a billet `path` the descriptor does not declare.
- **The pins are the only run-time source.** `src/shared/addons/pins.json` is
  generated by `scripts/build-addons.mjs` (`identity`, `apiVersion` and
  `contributions` per id) at install/build time and is **git-ignored** (never
  committed, never regenerated by hand). The identity is the first 16 hex
  characters of a sha256 over the add-on's shipped files (its `tests/` and
  `e2e/` excluded) **and** every `src/shared` module its bundle inlines, so it
  changes exactly when what ships changes. There is no version number to bump or
  forget, and `apiVersion` (`ADDON_API_VERSION`) stays the compatibility contract.
  **The pins are not re-exported by `src/shared/addons/index.ts`**, and that is
  load-bearing: an add-on imports that barrel for the `AddonHost`/`AddonModule`
  contract, so a re-export would pull the generated JSON into every add-on's
  bundle - which needs the file before the script that writes it has run (a clean
  checkout has none, so `npm ci`'s `postinstall` failed on CI with `Could not
  resolve "./pins.json"`) and hashes generated output into the identity (a new
  identity on every build, so every release re-published and re-downloaded an
  unchanged add-on). Anything that wants the pins imports
  `src/shared/addons/pins` itself; `tests/unit/addons/buildDerivation.test.ts`
  bundles each real add-on and fails if the pins reach it.
- **Advertised before download.** At startup the app registers a **proxy** per
  pinned tool (`src/main/tools/addonProxy.ts`) and an index entry per pinned skill,
  so the model, the session instructions, the composer's `/` list and the home
  screen all see them from the first launch. Nothing is downloaded until a call or
  a skill load needs it, and everything one add-on contributes shares that one
  load (`src/main/addons/loader.ts`: ensure → `import()` → `apiVersion` →
  `activate(host)`, single-flight, success-only caching). A failure is
  `CANCELLED` or a retryable `STORAGE_ERROR` naming the add-on and the reason.
- **Installed under `%LOCALAPPDATA%\etoolbox-daisy\addons\<id>\<identity>\`**
  (`appPaths.addons`). No Settings UI: removing an add-on means deleting its
  folder, and it is downloaded again on next use. Every failure is typed
  (`offline`, `hash`, `extract`, `identity`, `apiVersion`, `cancelled`)
  and logged as `ADDON_FAILED`; `ADDON_INSTALLED` records a success.
- **No binary add-ons.** The capability existed only for `copilot.exe` and its
  build path hard-coded `@github/copilot-<platform>`, so it was removed with it.
  The deferred SDK-runtime add-on must first add an explicit payload source to
  `addon.json` (`docs/backlog.md`).
- **A JS add-on is its own npm package** (`src/addons/<id>/package.json` +
  `package-lock.json`, `private`, `type: "module"`, **not** a workspace member
  and **not** listed in the root `package.json` — electron-builder packages the
  root's production dependencies, which is exactly what must not happen).
  `npm ci` at the root runs `postinstall` → `npm run addons:install && npm run
  addons:build`, so the add-on dependencies and the generated `pins.json` are
  both ready without a manual step.
- **Every private package carries the application's version.** An add-on's
  `package.json` version is its own bookkeeping instead: it is **not** compared
  with the root's any more (all add-ons sit at `1.0.0` until an owner raises one
  for a procedural reason), and it is **excluded from the identity**, so raising
  it re-publishes and re-downloads nothing. `npm install --prefix
  src/addons/<id> --package-lock-only` keeps the lockfile's copy in step if you
  do raise it.
- **Loaded with a real `import()`.** A plain dynamic import is rewritten into
  `require()` by the bundler, which cannot load an ESM folder outside the asar;
  `src/main/addons/loader.ts` keeps one runtime `import()` (a documented
  `new Function`) and is the pattern to copy.
- **The generic host.** A loaded add-on receives an `AddonHost`
  (`src/shared/addons/addonHost.ts`): a hidden window, the sessions
  (`pane()`, and `isolated(name)` → partition `addon-<id>-<name>`), the address
  policy, the configured origins, the pane URL and one log call. Main forces only
  the safety-critical window options (hidden, sandboxed, context-isolated, no Node
  integration, web security on) and refuses a session it did not hand out;
  **everything else about its window and its network is the add-on's** (frame
  rate, throttling, window-open denial, permissions, its request filter, nav
  guards, its deadline). It reports a failure as `ADDON_RUNTIME_FAILED` with its id.
- **The add-on imports only its own files and `src/shared`** — never
  `src/main`, `src/renderer`, `src/tools` or `src/agents` — and Electron types
  only; its own npm dependencies are its own. ESLint enforces both directions
  (the dependency list is read from each add-on's `package.json`), and the
  fixture is `tests/fixtures/eslint-violations/addon-boundary-violation.ts`.
- **Development never downloads.** `npm run build` / `npm run dev` run
  `npm run addons:build`, which writes `out/addons/<id>/` (bundled `index.js`,
  `addon.json`, a junction to the add-on's `node_modules`);
  `src/main/addons/devSource.ts` returns that folder and `ensure` never touches
  the network. `scripts/app-build.mjs` copies the built add-ons into
  `<install>/resources/addons` for a run-from-source install. `electron-builder.yml`
  excludes `out/addons/**` and `src/addons/**` from the asar.
- **`EDAISY_ADDON_SOURCE=<folder>`** (unpackaged only) forces the download path
  against a local folder — `tests/e2e/addon-download.spec.ts`.

#### Recipe: add an add-on

1. `src/addons/<id>/addon.json` — `{ id, apiVersion: 1, entry: "index.js" }`,
   plus `contributes.tools` for each tool it offers; `id` must equal the folder
   name, and there is **no version** (the build derives the identity). A JS add-on
   adds `package.json` (`private`, `type: "module"`, version equal to the app's)
   and `index.ts` exporting `export const addon: AddonModule = { apiVersion,
   activate(host) { return { tools: { … } } } }`.
2. Its tools live in its own `tool.ts` (a factory
   `(toolHost: ToolHost) => ToolExecutor`), its skills in `skills/<name>/SKILL.md`,
   its tests in `tests/` and `e2e/` — never shipped, never hashed.
3. `npm install --prefix src/addons/<id>` (its lockfile).
   `src/shared/addons/pins.json` is regenerated automatically by
   `postinstall`/`npm run build`, so there is nothing to commit for it. A name
   clash, a bad billet path or malformed front matter fails the build here.
4. Nothing else. There is no feature to wire: the proxy, the allowlist entry, the
   session instructions and the skill catalogue all come from the pins, and the
   renderer paints the billet from them. Remove the dependency from the root
   `package.json` if it was there; add the exclusion to `electron-builder.yml`
   only if the package was a root dependency.
5. Tests: the add-on's own, plus `tests/unit/main/addons/` (host, loader, proxy),
   `tests/unit/addons/` (build derivation, the isolation invariant) and a
   built-app case in `tests/e2e/addon-download.spec.ts` style if the download
   path matters.
6. Record evidence in the current archive and update
   `docs/addon-architecture.md`.

### `resources/skills/` and the skill subsystem

Nine bundled skills, each a `SKILL.md` in `resources/skills/`: `search`,
`semantic-search`, `search-component`, `search-page`, `navigate` and `remember`
(all user-invocable — they appear in the
composer's `/` autocomplete), plus `daisy-conventions`, `query-results` and
`page-template` (auxiliary — `user-invocable: false`, so the model still gets
them in its catalogue but the `/` menu does not list them). `page-template` holds
the one template-name-to-path resolution, loaded by `search-page` and
`search-component` alike; do not copy that procedure into either skill.
A tenth, `check-page`, is **an add-on's skill**: it lives in
`src/addons/page-audit/skills/check-page/`, the build derives its catalogue entry
from that `SKILL.md` into the pins, and it is listed (and `/`-completable) from the
first launch — the add-on is downloaded the first time the skill is loaded. It is
the Lighthouse report: one `page_audit` call, and the tool paints the score table
and one section per category with Lighthouse's evidence.

**One app-owned mechanism, identical for every agent** (plan:
`docs/skill-subsystem-plan.md`). No SDK ever sees a skill directory: Copilot's own
skill loading is off and its built-in `skill` tool is replaced (every app tool sets
`overridesBuiltInTool`), OpenRouter has no skill code of its own. Three ordinary
tool plugins carry it — `load_skill` (`{ name }`: loads a skill's body), `skill_resource`
(`{ skill, path, startLine? }`: reads a file or lists a folder of the skill) and
`skill_script` (`{ skill, script, input? }`: runs a `scripts/**/*.js` module) —
each through the new `ToolHost.skills: SkillHost`
(`src/shared/skills/skillTypes.ts`). The model reaches a skill's files only through
these tools, never by a filesystem path. Main owns the implementation:
`src/main/skills/skillStore.ts` (indexes the two sources, validates), `skillHost.ts`
(the `SkillHost`, error-code mapping), `skillFiles.ts`/`skillFrontMatter.ts`, and
`sandbox/` (`runSkillScript`: a QuickJS-in-a-worker sandbox, 5 s deadline, 64 MB,
no I/O, no network; the worker ships as `out/main/scriptWorker-<hash>.js`). The
limits hold at the worker boundary too: the worker has its own heap cap
(`workerHeapMb`, 192; exhaustion is a `memory` failure), console output and an
oversized result are bounded *inside* the guest before they reach Node, and one
turn's script runs go one at a time in call order (other turns run in parallel).
`skill_resource` serves only files the startup index lists (a file that grew
since is refused, not read) and `skill_script`'s `input` is any JSON value.
Scripts are ES modules that `export default` a function of the input; relative
imports work; **JS only** (a `.py` file is readable, not runnable).

**Three sources, user wins.** Bundled skills come from `resources/skills/`; an
add-on's skills from the pins (their bodies from `<install>/skills/<name>/`, read on
first use — the catalogue entry needs no download); user
skills from exactly `~\etoolbox-daisy\skills` (`appPaths.skills`), read at startup
and again on the Skills tab's icon-only reload button (`skills:reload`; no restart
needed - rules have the same, `rules:reload`). A user skill with a bundled skill's name
**replaces** it (owner decision; plan D3 said the opposite), but a *rejected* user
skill never displaces a bundled one. A skill needs a valid lowercase name and a
non-empty `description`; limits: `SKILL.md` 64 KB, 200 files, 5 MB total, depth 4;
dot-entries and symlinks are not indexed, a skill folder or `SKILL.md` that is a
link/junction is rejected (`Links are not followed.`), and paths are real-path
contained.
Rejections log `SKILL_REJECTED`; a failed script logs `SKILL_SCRIPT_FAILED`.
**A failed reload keeps what was already loaded**: `skillStore.reload()` (and
`ruleStore.reload()`) rejects instead of committing an empty or partial catalogue, the
IPC reports `ok: false` with an application-authored corrective message (never a path),
and `load()` is left able to read again; rapid reloads share one in-flight read. A
reload that arrives before the agent hub exists (the first seconds after launch) queues
one refresh that the hub applies once it has started.

**Settings "Skills" tab** (after Agents) holds the **Custom skills
folder** link (`skills:open-folder`, no payload: main creates the folder and opens it in
the OS file manager), an icon-only **Reload skills** button (`skills:reload`, test id `skills-reload`;
the browser toolbar's refresh icon with a native `title` tooltip; re-indexes both
sources and refreshes the composer's `/` list and the agent runtime) and the
**Custom rules folder** link (`rules:open-folder`, same
shape - see "User rules" below) with its own icon-only **Reload rules** button
(`rules:reload`, test id `rules-reload`), each with contextual help, then the
**Self-learning** checkbox (`memos.enabled`) and the **Memos folder** link
(`memos:open-folder`) - see "Memos" below. The three folder buttons share one
width so they line up as a column, and every help badge on the tab ends with the
same ". Changes apply ..." formula (after reloading for skills, on the next
prompt for rules, memos and the checkbox). The tab reads as three
subsections (skills, rules, the memos pair), separated by the **one
`.subsection-gap` utility** (24px, in `settings.css`, also on the
Hosts/Projects/Proxies multifield list and the Agents provider cards) rather than
a bespoke rule per tab. There is no per-skill list. Writing and installing a
custom skill (front matter, `table-only`, the example skill `links-check`) is
documented in `docs/custom-skills.md` and `docs/examples/skills/`. Test ids:
`settings-tab-skills`, `skills-open-folder`, `skills-reload`, `rules-open-folder`,
`memos-open-folder`, `data-field="memos-enabled"`.

Every **new** bundled skill must carry a user-facing summary in its front
matter: a `metadata.user-description` (one friendly phrase, no technical
detail) alongside the model-facing `description`. The store scans
`metadata.user-description` and falls back to `description` when it is absent, so
the home screen and the composer's `/` list render the friendly text (`search` and
`semantic-search` already carry one). This is a contract, not a preference: a skill
without it ships its technical `description` to the user.

**A skill's displayed summary never ends with a period.** The home veil and the
composer's `/` popup render that summary verbatim, so it reads as a label, not a
sentence - exactly like the app's own banner copy (see §5, "Banner copy never
ends with a period"): `Find pages and assets by their content`, never
`Find pages and assets by their content.` This binds the `metadata.user-description`
of every bundled skill **and** the technical `description` that is shown when a
skill carries none (the store's fallback), so a skill added without a
user-description still shows a period-free label. `?`/`!` are no substitute - the
summary is a phrase, so it ends with neither. `tests/unit/main/skills/bundledSkills.test.ts`
holds every bundled, user-invocable skill to this, reading the real files; user
skills in `~\etoolbox-daisy\skills` are the owner's own text and are not
rewritten by the application.

**Skills are auto-inferred from their descriptions, not only invoked by name.**
The composition root composes the model-facing catalogue — every skill (bundled
and user) with its technical `description` — onto the session instructions
(`renderSkillCatalogue` in `src/shared/skillInvocation.ts`, appended to
`toolkit.instructions` in `src/main/index.ts` once the store has loaded), so
the model can choose a skill from its description the way other harnesses do;
`user-invocable: false` skills are in that catalogue too (they are the
agent-only ones). Loading is the `load_skill` tool call (`SKILL_TOOL_NAME`), and
`transcriptStore.ts` shows it as a billet when the model chose it - so a reader
(or an investigation into a session that went wrong) can tell whether a skill
was loaded at all, and which one - while using it to suppress a search skill's
prose (below). That call's billet is the existing `load_skill` renderer's (the
collapsed summary is the bare skill name - the header already says `load_skill` -
expanding to Source / Files / Scripts); a *failed* load is shown
too, as a FAILED billet. An explicit `/name` is resolved by `resolveSkillPrompt`
(`src/shared/skills/skillActivation.ts`), which frames the input and the
controller journals a synthetic `load_skill` call pair after a successful send; its
result says `activatedBy: 'user'`, which keeps it out of the transcript (the
user's own message already names the skill). The three skill tools' billets
read `<skill>` / `Read <skill>/<path>` /
`Run <skill>/<script>` (`getDetails()` compositions proposed in the plan, D7).
`tests/live/skills.live.spec.ts` certifies the whole path live with the
`skill-selftest` user skill.

`/search <terms>` and `/semantic-search <text>` accept their argument as one
plain string — no separate "comment" is required. The `/skillname` rewrite in
`src/shared/skillInvocation.ts` frames the trailing text as the skill's input
and forbids asking the user to restate it; the skill bodies then say that input
is the search string. Both halves are load-bearing: without the framing the
model loads the skill and asks what to search for (observed live). A bare
`/name` gets the same treatment: the activation is followed by a directive to run
the procedure from its first step and *not* to answer with an acknowledgement of
the skill - without it a weak model treated the whole message as background
material and called no tool (measured live 2026-10-26). The bodies
are written for **both** paths: an explicit `/name` turn and a turn where the
model loaded the skill on its own.

All three search skills answer with **exactly one application-rendered table**:
`/search` makes a single `aem_query_format_ask` call (`{ "terms": ... }`), which
runs `aem_query`, `format_table` and the `ask_user` `["Load more"]` loop itself
through the tool-to-tool bridge (a hand-built predicate query is the same single
call with `predicates` instead of `terms`); `/semantic-search` makes one
`aem_semantic_search` call (`{ terms, context }`), inside which the application
reads and answers each hit page, tables the passing `{ jcr:path, property,
citation }` rows and runs the Load-more loop itself - the model never returns
candidates or verdicts; and
`/search-component <component>` resolves a title or name to a resource type from
`cq:Component` nodes under the component roots (`aem_query`), then makes one
`aem_query_format_ask` call over the component **instances**
(`type=nt:unstructured` + `property=sling:resourceType`). Its step 1 is a strict,
ordered procedure (like `navigate`'s): a resource type is path-like - it contains
a `/` - and anything else is a title that **must** be resolved, never invented
from the phrase (a live run turned "Media Library" into `media-library` and found
nothing). The table then shows
each hit against its owning page (`Path`) with the component node's path within
it (`Node`) — one numbered row per placement, with a repeated page path
blanked — so the instance shape stays index-served
and its background honest count proves an exact total (see
`docs/compatibility.md` §11.3). Its `description` is written to win the
auto-inference race against `search`: a request that pairs looking/searching with
a component belongs here, and `search`'s own description now defers such a
request. A request that also names the pages' template or another page property
is still `search-component`: it adds a `filters` entry, which the application
applies to the page that owns the component (see "Page-property filters" above).
`/search-page <template or page type>` finds the pages built on a
template (path, name or title; static or editable) and/or a page resource type: it
gets the template path from the shared `page-template` skill, which lists
`cq:Template` under `/conf` and `/apps`, limits the templates to the project by
keeping those whose own page resource type
(`structure/jcr:content/sling:resourceType` editable, `jcr:content/sling:resourceType`
static) falls under the component roots, and matches the phrase; the search is one
`aem_query_format_ask` call on `cq:Page` with `cq:template` and
`sling:resourceType` filters; its query shapes are documented, not yet verified
live (`docs/compatibility.md` §11.6). The application hides the model's own prose for a `/search`,
`/semantic-search`, `/search-component` or `/search-page` turn, **but only once that turn's
`format_table` has actually landed**: the turn is marked table-only at send
(`isDeterministicTablePrompt` in `src/renderer/src/chat/transcriptViewModel.ts`) or
mid-turn when the model loads one on its own (`transcriptStore.ts`'s `load_skill`
handling), and the prose is dropped when the turn's own `presentation: 'message'`
tool settles - so the table is the whole answer, while a model that ignores the
skill keeps the prose it wrote, which is then the turn's only output (a prompt-time
suppression left such a turn painting nothing at all; measured 2026-10-26). See
the `format_table` bullet in the tools section above and
`docs/verification.md` "Skills are auto-inferred from their descriptions ...
(2026-10-11)" and "`search-component`: the component-instance shape ... (2026-10-13)".

The read-only / no-side-channel policy that used to live in the on-demand
`aem-tool-selection` skill (deleted) now lives in the **always-injected**
session instructions (`resources/rules/session.md`, composed by
`composeAssistantInstructions` in `src/shared/tools/core/toolModule.ts`): a
skill is only read when the model chooses to load it, so it can never
*guarantee* an invariant. Per-tool "when to use me" guidance stays in each
tool's own `instructions` and descriptor — never a central, tool-enumerating
skill — which is what scales as the public-AEM-REST-API tool count grows.

**A skill states only its own procedure.** What holds for every search or every
skill is written once, in `resources/rules/`: the scope rules, the
current-page rules, ambiguity, read-only, and "a skill's input is the user's whole
request". Do not repeat them in a skill (the old "reached two ways", "write no
prose", "Pass `roots` only when...", "Never call `aem_query` yourself" and
`## Read-only` paragraphs were each copied across three or four skills and are
gone).

### `resources/rules/`

The application's own rules: the model-facing prose that is not a skill, as markdown
so it reads as text in the repository. Application-owned, shipped with `resources/`
inside `app.asar` (so an update delivers it), read by main from the install
location only
(`resolveBundledResourcesDirectory`). It parallels `resources/skills/` (bundled) and
`~\etoolbox-daisy\skills` (the user's); here `resources/rules/` is the bundled side
of `~\etoolbox-daisy\rules`. (Renamed from `resources/instructions/` when user rules
arrived, so the word "rules" is used throughout.)

| File | Holds | Placeholders |
| --- | --- | --- |
| `session.md` | The always-on session instructions: current-page context, **Scope**, **Filters** (including the publication state), **Ambiguity**, paths, read-only, tools, errors | `{{tools}}` - the enabled tools' paragraphs, exactly once (`composeAssistantInstructions`) |
| `skills.md` | The skill-catalogue preamble, incl. "a skill's input is the whole request" | `{{skillTool}}` (any number), `{{catalogue}}` - exactly once (`renderSkillCatalogue`) |
| `user-rules.md` | The frame around the user's generic rules, appended to the session instructions | `{{rules}}` - exactly once (`renderGenericRules`) |
| `project-rules.md` | The frame around a project's rules, sent on the model prompt | `{{project}}` and `{{rules}}` - each exactly once (`renderProjectRules`) |
| `project-rules-ended.md` | The one-line note sent when a chat moves from a project with rules to one without | none |
| `memos.md` | The frame around the generic memos plus the memo-writing guidance, sent on a conversation's first prompt | `{{memos}}` (`renderGenericMemos`) |
| `skill-memos.md` | The frame around a skill's memos, appended to the `load_skill` tool's result | `{{memos}}` (`renderSkillMemos`) |
| `memo-reflection.md` | The quiet reflection prompt sent after a turn with failure signals | `{{signals}}` (`renderReflectionPrompt`) |

`session.md` and `skills.md` carry the read-only policy, so `loadRuleResources`
(`src/main/rules/ruleResources.ts`) rejects at startup when either is missing and a template
without its placeholder throws: **the application does not start without them**.
The three rules templates are loaded the same way. `src/shared` reads no files,
so the compose functions take the template as a parameter. Tests read the real
files (`tests/support/ruleResources.ts`).

### User rules (`~\etoolbox-daisy\rules`)

The user's own standing instructions, as `*.md` files, merged with the bundled
ones. Named **rules** (the Open Agent term), not "instructions". Mirrors the skill
subsystem: read at startup and again on the Skills tab's **Reload rules** button
(`rules:reload` - `ruleStore.reload()`, then a deferred runtime recycle so generic
rules reach the session instructions; project rules are read per prompt and need
only the store refresh. A shared-surface addition: `RULES_RELOAD_CHANNEL`,
`DaisyRulesApi.reload`, `rulesReloadResultSchema`, log code `RULES_RELOAD_FAILED`;
no `contracts/` file changed) by `src/main/rules/`
(`ruleStore.ts`, `ruleFrontMatter.ts`, `ruleRendering.ts`), the folder is
`appPaths.rules`, and the Settings **Skills** tab carries a second action link,
**Custom rules folder** (`rules:open-folder`, test id `rules-open-folder`).

- **Format.** A rule is one `.md` file; its file name is the rule's name. Optional
  front matter with a single key, `project:` (a label or a list of labels, matched
  trimmed and case-insensitively against a Settings **Project** label). No front
  matter, or no `project` key, makes the rule **generic**. Subfolders, dot-entries
  and links are ignored; an unreadable or malformed file is rejected
  (`RULE_REJECTED`) and the rest still load.
- **Limits.** One file 32 KB (`RULE_FILE_MAX_BYTES`); generic rules 64 KB in total
  (`GENERIC_RULES_MAX_BYTES`); each project 16 KB (`PROJECT_RULES_MAX_BYTES`). A
  rule that would overflow a budget is rejected whole, in name order.
- **Generic rules** join the session instructions (`index.ts` composes
  `toolRegistry.instructions`, the skill catalogue, then the generic rules **last**,
  so they win on a conflict).
- **Project rules** cannot join the session instructions: those are fixed when the
  agent runtime starts, while a chat can change host - and so project - mid-conversation.
  They ride on the **model prompt** instead (`agentChatController.sendMessage`): with
  a chat's first prompt, again whenever the current project's rules differ from the
  last ones sent, after any `openConversation`, and - once - an "ended" note when the
  chat moves to a project with none. The project is resolved fresh per prompt from the
  host the pane is on (`createCurrentProjectLabel`, `agentComposition.ts`). A failed
  send does not count as sent. The block precedes the current-page block and is
  **not journaled** (`user.prompt.pageContext` is capped at 8000 characters and a new
  journal field would be a contract change - `docs/backlog.md` "User rules:
  deferred follow-ups").
- **Precedence.** User rules win over the bundled instructions on a conflict,
  **except** the read-only policy (rule 7.4): a rule cannot grant an AEM write path,
  and none exists to grant.

### Memos (`~\etoolbox-daisy\memos`) - self-learning

The agent writes short lessons as `.md` files and the application reads them back
into later conversations. The owner browses the folder and may fold memos into
bundled prose by hand. Main owns it: `src/main/memos/` (`memoStore.ts`,
`memoHost.ts`, `memoRendering.ts`, `turnSignals.ts`), `src/main/ipc/memos.ts`;
the contract is `src/shared/memos/` (`MemoHost`, `MEMO_TRIGGERS`, limits).

- **Layout.** `memos\generic\<yyyymmdd-hhmmss>-<slug>.md` or
  `memos\skills\<skill>\...`; front matter `title`, `created`, `trigger`
  (`request`/`correction`/`error`/`loop`), optional `chat`. The application picks
  the folder and name; the model never supplies a path. A per-skill memo needs a
  loaded skill, else the store refuses and the model writes a generic one.
- **Writing** is the `memo` tool (`src/tools/memo/`, `{ title, text, trigger,
  skill? }`, text ≤ 2 KB). Three paths: an explicit "remember/keep in mind" or
  `/remember` (the bundled `remember` skill); a user correction (the always-sent
  guidance `resources/rules/memos.md` asks for a memo in the same turn, `ask_user`
  only when wording or scope is genuinely unclear); and an **automatic
  reflection**: `turnSignals.ts` collects a turn's failed tool results (not
  `CANCELLED`/`STALE_CONTEXT`/`AUTH_REQUIRED`), agent errors, a call repeated 3
  times with identical arguments, a dismissed-then-re-asked question; nested calls
  excluded. After such a turn (not cancelled, no memo already written, not itself
  a reflection) the controller sends one quiet prompt
  (`resources/rules/memo-reflection.md`), journaled as `user.prompt` with
  `origin: 'reflection'` and never painted. The transcript shows only the internal
  `memo_reflection` marker billet and any memo billet; prose is suppressed; Send
  stays enabled (`ComposerStatus.reflecting`) and a user send aborts it quietly.
- **Loading**, fresh from disk on use: generic memos ride on a conversation's first
  prompt and after an open/resume (`memos.md`, newest first within 16 KB); a
  skill's memos are appended to the `load_skill` tool's result (`skill-memos.md`, 8 KB),
  for a model-chosen load and an explicit `/name` alike. Over-budget memos are
  silently skipped (notice deferred, `docs/backlog.md` "Memos").
- **The stored-memo notice** is the pane's sticky `showNotice` row: "Memo was
  stored. Press **Open** to view it in folder", whose action calls
  `memos:reveal` (main derives the file from the memo id) so the OS file manager
  highlights it - the same idea as the chat footer's reveal-log control. **The
  billet** reads `Memo saved: <title>` / `Memo for <skill>: <title>` and shows
  the title, scope, trigger, text and file; like every other billet it carries no
  hover toolbar, and there is no Undo (`memos:undo`, `readActions` and
  `toolCallActions.ts` were removed).
- **Off switch.** Settings → Skills → Self-learning (`memos.enabled`, default on):
  off stops loading, guidance and reflection, and the `memo` tool refuses.

**The roots are a convenience, not a boundary.** A user may search any path; the
tools never refuse or question a full path outside the host's roots. What the model
must not do is *build* a path for a phrase the user wrote. A search's `roots`
(`searchRootsSchema`, `src/shared/tools/core/scope.ts`) therefore accepts a full
path, passed through as written, or a path **fragment** (`us/en`) exactly as the
user wrote it, which `resolveSearchScope` turns into a full path: the host's
priority paths that end with it, then its content roots that do, then one
`aem_query` for `cq:Page`s named like its last segment, filtered by the whole
fragment. One proved match is used; several, none, or a lookup that could not see
every page make the **application** ask the user (`ask_user`, options plus free
input), never the model. A description in words ("the US site") is rejected with a
corrective message. `aem_query` itself still takes full paths only
(`queryRootsSchema`). `MAX_SEARCH_ROOTS` (10) is the one shared cap; the default
(content, then DAM) fan-out is silently cut to it - `docs/backlog.md`.

The per-turn current-page block (`renderCurrentPageContextForModel`) is **facts
only**: how to read it is in `session.md`, once. It now names all three root
families the skills scope with - the host's **content roots**, **component roots**
and **DAM roots** - so a page/component search can pass the content roots and an
asset/file search the DAM roots in its single call, without a second
`environment_facts` call.

**Which root family a search uses is a prose decision, not a code branch.** The
subject decides, and the skill passes the family explicitly: content roots for a
**page** or **component**, DAM roots for a **file** or **asset**, both when both
are asked for, content roots when neither is named - `resources/rules/session.md`
"Scope". The search composites' deterministic `resolveSearchRoots` default
(content then DAM, collapsed) is kept only as a fallback for a call that passes
no `roots`; the skills are told not to rely on it.

**Page-property filters: one generic shape, applied by the search's own shape.**
`aem_query_format_ask` and `aem_semantic_search` take an optional `filters`
array. A filter is `{ property, operator?, value?, negate?, group? }`, the
property named **relative to the item's content node** (`cq:template`, not
`jcr:content/cq:template`). The operators are `equals` (default), `like`,
`exists`, the date range `after`/`onOrAfter`/`before`/`onOrBefore`
(`daterange`) and the numeric range `above`/`atLeast`/`below`/`atMost`
(`rangeproperty`); one value per filter, so a between is two filters. Filters are
ANDed; filters sharing a `group` label are ORed. `negate` is the `p.not`
complement of the whole filter and never combines with `group` (refused).
`applySearchFilters` (`src/shared/tools/core/searchFilters.ts`) builds the
predicates by shape:
- a component search gets an OR over ancestor content nodes (depths 1..15,
  `FILTER_ANCESTOR_DEPTH`), because QueryBuilder has no joins. The ancestor chain
  contains exactly one `jcr:content` - the owning page's - so a property only a
  page content node carries (`cq:template`, `cq:lastReplicationAction`) is exact;
  a property a container could also carry would match the container;
- `type=cq:Page` / `type=dam:Asset` gets its own `jcr:content/<property>`;
- a plain full-text search is typed to pages and assets first;
- any other shape is refused with `INVALID_ARGUMENT`, never filtered silently.

The model chooses a filter from what the request means; the *particular
properties* live in the prose, never in the tool: `resources/rules/session.md`
"Filters" names the publication state (`cq:lastReplicationAction = Activate`,
negated for not published) and the component skill names `cq:template` (resolved
through the shared `page-template` auxiliary skill) and `cq:lastModified`. Never
add a property-specific argument to a tool. The filtered predicates drive the
page query and the honest count. The component `Path`/`Node` split and the
echoed `predicates` keep the model's own; both billets show a `Filters` row. The
groups `9001_group`..`9005_group` (the type group plus up to
`MAX_SEARCH_FILTERS` = 4 filter groups) are reserved. See
`docs/compatibility.md` §11.7.

### In-app updates (`src/main/updates/`)

The app swaps only `resources/app.asar` (22.6 MB since the add-ons left the
asar, 135.4 MB before; the install is 477 MB), driven
by a hand-rolled `update.json` in plain GitHub folders - no `electron-updater`.
Full description and the release procedure: `docs/updates.md`. The **add-on
catalogue** `addons.json` lives in the same folder and is published by the same
workflow, zips first and `update.json` last (see "Add-ons" above and
`docs/addon-architecture.md`); the folder keeps only the archives that catalogue
names (the publish step deletes the rest), and each published `update.json`
carries an `addons` node - its id -> identity map, written by
`scripts/package-update.mjs` and deliberately not read by the app - so the
release, not the folder, records what a version pinned.

- **Places.** The Settings **Updates** tab's `updates.url` (https only) is tried
  first, then `updates.urls` in `package.json`. A `github.com/.../tree/<ref>/<path>`
  URL is rewritten to `raw.githubusercontent.com`. The first strictly newer
  manifest with a `<platform>-<arch>` entry wins.
- **Whether an archive may be swapped in is derived, not declared.** A swap
  replaces one file (`resources/app.asar`), so the manifest names the runtime
  layer its archive needs - `runtime: { format, electron, payload }`, where
  `payload` is a path-and-size hash of `resources/app.asar.unpacked` - and the
  app describes the layer it is running (`src/main/updates/runtime.ts`:
  `process.versions.electron` plus the same hash of the payload beside its own
  archive) and compares. A difference is "installer required", not a swap, and
  the status names the parts that differ (`UpdateRuntimePart`). The producer side
  is `scripts/runtime-descriptor.mjs`, run by `package-update.mjs` against the
  packaged output; `tests/unit/main/updates/runtimeDescriptorScript.test.ts`
  holds the two implementations together byte for byte. Bumping Electron,
  changing `asarUnpack` or shipping a new Copilot runtime therefore needs no
  manual step, and cannot be forgotten. It is the **only** mechanism: an archive
  entry without a descriptor is refused rather than guessed at, and there is no
  counter anywhere (`updates.runtimeGeneration` / `minInstalled` were removed
  outright).
- **Modules.** `manifest.ts` (parse/validate, file-name and sha512 rules,
  the runtime descriptor), `runtime.ts` (the descriptor: hash, comparison,
  installed side), `updater.ts` (single-flight check, download + verify + stage,
  status), `applier.ts` (swap script, `.bak` kept), `proxy.ts` (reuses the
  browser's default proxy, else the active agent's), `composition.ts` (the
  sandbox switch); `ipc/updates.ts` carries `updates:check` / `updates:apply` /
  `updates:get-status` and the `updates:status-changed` push. Main owns the
  status; the renderer only renders it.
- **UI.** The **Updates** tab (last in Settings): Check and, on the same line,
  Update (visible only while an update is pending, confirmed through the shared
  `confirmDestructiveAction`-style prompt) with no help badge on the buttons;
  then, after a subsection gap, the **Check for updates on startup** checkbox
  (`updates.checkOnStartup`, default
  off; a startup check is silent) and the **Custom update URL**. A found update raises the chat pane's sticky
  notice once per version (Details → Settings → Updates) and puts an accent-blue
  "Update X available" `sp-action-button` (`home-update-link`; the shared
  `.action-button--primary` class in `base.css`, also on Settings' **Update**) on the Home screen's version
  line (a `.browser-home__meta` row; a hidden button or empty row takes no
  space); the button starts the update itself, after the same confirmation as
  the Settings tab's **Update**. `!!update <version>` previews all of it (dev only).
- **Sandbox.** `EDAISY_UPDATE_SANDBOX` (a folder holding `resources/app.asar`) is
  honoured only when `!app.isPackaged`: the swap runs in-process, keeps `.bak`,
  does not restart. This is how QA and `settings-updates.spec.ts` run the whole
  flow.
- **Contract changes (2026-10-21).** `contracts/appSettings.ts` gained the
  `updates` group (`url?`, `checkOnStartup`), `settingsSnapshot.ts` and
  `settings-ipc.ts` follow (`updateUpdateSettings`), `app-api.ts` gained
  `DaisyUpdatesApi`, and `updates-ipc.ts` is new. Existing settings fixtures
  gained `updates: { checkOnStartup: false }`.
- **Unproven / deferred.** The macOS runtime paths (`runtimePaths.ts`), the
  Mac zip targets and `asarUnpack`, the three-platform workflow matrix
  (`publish-update.yml`) and the Mac swap's ad-hoc `codesign` re-seal exist but
  have never run on a Mac or in CI: `docs/backlog.md` "In-app updates: macOS
  runtime and unrun CI". Updates are published only by that workflow; there is
  no local publish command.

### `tests/`

- `tests/unit/**` — mirrors `src/` one-for-one (`tests/unit/agents/<name>/` for
  an agent folder, `tests/unit/tools/` for tools, `tests/unit/main/agents/` for
  registry/hub; an add-on's own tests live beside it in `src/addons/<id>/tests/`
  and its E2E specs in `src/addons/<id>/e2e/`, picked up by the generic globs,
  `tests/unit/main/addons/` for the manager). jsdom for renderer tests.
- `tests/integration/**` — real sockets, real proxies, real CA, real runtime
  (`proxy-runtime.test.ts`, `agent-runtime.test.ts`).
- `tests/live/**/*.live.spec.ts` — opt-in scenarios against the real app, real
  AEM and the selected agent/model (`npm run test:live`, never in `verify`);
  helpers in `tests/support/live/`, unit-tested in `tests/unit/support/live/`.
- `tests/e2e/**` — Playwright driving the **built** Electron app, one spec per
  step.
- `tests/support/**` — shared fakes (`fakeAgent`, `fakeBrowserSide`,
  `fakeBridgeTransport`, `testClock`, `testIds`, `agentDefinitions` — the agent
  definitions used where a real `meta.ts` glob is not wanted, `toolUnions`).
- `tests/fixtures/eslint-violations/**` — files that **must** fail lint; they
  prove the architectural boundary rules are actually switched on.

### Empty placeholders

`src/aem/`, `src/storage/` and `tests/fixtures/` contain only `.gitkeep`. They
are reserved by the plan; nothing lives there yet.

---

## 6. Commands

The scripts, and what each is for. `package.json` is strict JSON and cannot
carry comments, so the explanation lives here, one line above each script:

```bash
# the gate: typecheck + lint + format:check + vitest
npm run verify

# build everything: icons, add-ons, electron-vite, then the webview preload
npm run build

# electron-vite dev, with icons, add-ons and the webview preload built first
npm run dev

# publish the add-on archives + dist-addons/addons.json; reuses what `build` just made
npm run addons:zip

# rebuild out/addons/<id>/ and src/shared/addons/pins.json only
npm run addons:build

# install each add-on's own dependencies; `npm install` / `npm ci` do this via postinstall
npm run addons:install

# regenerate the git-ignored resources/icon.ico and icon.icns from resources/icon.png
npm run icons

# the second, sandbox-safe preload pass (run by `build` and `dev`)
npm run build:webview-preload

# unit + integration tests only (vitest)
npm run test

# Playwright against the BUILT app - run `npm run build` first
npm run test:e2e

# opt-in: live scenarios against the BUILT app, real profile, real hosts, real model calls
npm run test:live

# Windows x64 portable zip: builds the app first, then packages
npm run package:win

# macOS zips (x64 + arm64 per electron-builder.yml): builds the app first, then packages
npm run package:mac

# tsc --build over every project reference
npm run typecheck

# eslint over the whole repository
npm run lint

# prettier --check over the whole repository
npm run format:check
```

**Live tests (opt-in, never in `verify`).** `npm run test:live` runs
`tests/live/**/*.live.spec.ts` (`playwright.live.config.ts`) against the *built*
app with the user's REAL profile, the currently selected agent/model and real AEM
hosts, and certifies behaviour from the app's own chat journal. Run
`npm run build` and close any running EToolbox Daisy first (single-instance
lock). Each run makes real model calls (cost). See `docs/live-testing.md`. Vitest
and `npm run test:e2e` never pick these specs up.

Current baseline: **`npm run test` → 4845 passed / 13 skipped** (+3 against the
4842 below - **add-on versions are bookkeeping, `update.json` records the pins,
and the published `update/` folder is pruned** (2026-10-29): `npm run addons:build`
no longer compares an add-on's `package.json` version with the application's
(`page-audit` now sits at `1.0.0`, still excluded from the identity, so its
identity stayed `31d53ac7b937f194`); `scripts/package-update.mjs` writes
`"addons": { "<id>": "<identity>" }` into `update.json` and refuses two matrix
legs that pin different add-ons for one version; the publish job deletes every
add-on archive the catalogue does not name, and the orphan
`update/page-audit-95874191c4d370f0-any.zip` is gone. The +3 is one identity case
(both version fields are ignored, a dependency change still moves the hash) and
two merge-script cases (the pins are written; disagreement is refused). See
`docs/verification/followons-2026-10.md` "Add-ons carry bookkeeping versions ...
(2026-10-29)". Before that it was **`npm run test` → 4842 passed / 13 skipped**
(+1 against the
4841 below - **a clean checkout builds the add-ons again, and their identity
stops changing** (2026-10-29): the shared barrel no longer re-exports the
generated pins, so an add-on's bundle neither needs `src/shared/addons/pins.json`
before `scripts/build-addons.mjs` has written it (the "Publish update" CI leg's
`Could not resolve "./pins.json"`) nor hashes that generated file into the
add-on's own content identity (which changed on every build, so no release could
reuse an installed add-on); the +1 is the new `buildDerivation` case that bundles
each real add-on and fails if the pins reach it. See §5's add-ons bullet and
`docs/verification/followons-2026-10.md` "A clean checkout can build the add-ons
again, and their identity stops changing (2026-10-29)". Before that it was
**`npm run test` → 4841 passed / 13 skipped** (+53 against the
4788 below - **an add-on contributes its own tools and skills, and nothing
outside it names them** (2026-10-28): the `page_audit` tool and the
`/check-page` skill moved into `src/addons/page-audit/`, with its types, its
runner, its hardening and its tests; the application keeps only generic machinery
(`AddonHost`, `loader.ts`, `addonProxy.ts`, the pins' contributions, the skill
store's third source, a pins-driven billet renderer). Shared-surface changes are
listed in `docs/verification/followons-2026-10.md`'s section. The +53 is the
add-on's own 5 files (moved: 78 cases) less the removed capability/renderer/executor
cases, plus `addonRuntime` (21), `buildDerivation` (14), `contributedTools` (7),
the add-on skill cases (`skillStore` +6, `skillHost` +3), `addonIsolation` (2), the
policy/table-only/report selections and the registry's contributed-tool cases.
Playwright is 175 tests (the add-on's 4 report specs moved into its `e2e/`).
The gate was green: `npm run verify` (with the documented QuickJS sandbox flake in
`scriptRunner.test.ts`, green in isolation), `npm run build`, the built-app report
specs (4/4) and `addon-download` (3/3). Before that it was
**`npm run test` → 4788 passed / 13 skipped** (+10 against the
4778 the tree measured before this change, which had drifted +19 past the 4759
recorded below - **`UPDATE_CHECK_FAILED` says which source failed and why**
(2026-10-27): each update source that cannot be read now logs its own line with
the source URL, `durationMs`, whether a configured proxy carried the request
(`proxied`) and a closed `reason` (`network`, `timeout`, `http-status` +
`statusCode`, `insecure`, `too-large`, `invalid-manifest`; the check's own
failure logs `unexpected`), and the aggregate line carries `count` so "every
source failed" is distinguishable from "no source was configured". The logger
gained its closed `LOG_REASONS` vocabulary and the `proxied` flag; the updater
reads the proxy selection through a new `usesProxy` dependency. The +10 is 8
`updater` cases (one per reason, the proxy flag, and the no-source aggregate)
and 2 `logger` cases (the fields are written; a forged reason is rejected). See
§5 and `docs/verification/followons-2026-10.md`). Before that it was
**`npm run test` → 4759 passed / 13 skipped** (+2 against the
4757 below - **`check-page` is a bundled skill** (2026-10-26): the Lighthouse
report moved out of `docs/examples/skills/` into `resources/skills/check-page/`,
with a bundled skill's `MANDATORY ...` description, its user-facing label and
`table-only: true`; `links-check` is the remaining example. The `+2` is the two
per-skill cases the new folder adds (`bundledSkills.test.ts`'s front-matter case
and its displayed-summary case) plus `searchPageSize.test.ts`'s per-skill case,
less the example case `exampleSkills.test.ts` loses. The table-only set is now
`check-page` plus the four search skills. See §5 and
`docs/verification/followons-2026-10.md`. Before that it was
**`npm run test` → 4757 passed / 13 skipped** (+13 against the
4744 below - **`page_audit` paints the full evidence** (2026-10-26): the audit
result now carries every issue's own evidence (one table of columns and rows per
audit, from Lighthouse's `details`: failing elements with selector, snippet and
explanation, insecure URLs, deprecated APIs with `file:line:column`, console
messages, sub-items) and **`page_audit` is a composite that paints the whole
report itself** - `uses: ['format_table']`, the score table then one table per
issue - so nothing is copied between tools by the model and nothing is capped
(`PAGE_AUDIT_MAX_FAILURES`/`failureCount` are gone). An "issue" is an audit that
did not pass **or** a weight-0 `informative` insight Lighthouse measured a saving
for, which is where Lighthouse 13's performance findings live (owner decision).
The check-page skill now just calls it. See §5 and
`docs/verification/followons-2026-10.md`. The +13 is
the new `tests/unit/addons/page-audit` cases (table evidence, a node's four parts,
sub-items, a key-less heading's sub-items, the no-items fallback, the cell-length
ceiling, no cap, and the measured-saving rule), the new
`tests/unit/tools/pageAudit.test.ts` cases (the evidence kept in the result, the
three painted tables, the evidence copied verbatim, the score status, and nothing
painted on a failure) and the shipped `page_audit` case in
`toolRegistry.test.ts`, less the assertions the old cap made.
Playwright stays **171 tests** - the one touched case
(`search-tables.spec.ts`'s Property cell) now finds the cell by column, because
every plain table cell wraps at any character. Before that it was
**`npm run test` → 4744 passed / 13 skipped** (+4 against the
4740 below - **a table-only turn is hidden only once its table lands** (2026-10-26):
suppression moved from the prompt to the turn's own `presentation: 'message'`
tool settling, so a model that answers a table-only skill with prose and calls no
tool keeps that prose instead of leaving a turn that paints nothing at all (the
reported "`/check-page` does nothing the first time" - see §5 and
`docs/verification/followons-2026-10.md`). `TranscriptStore.markTurnSuppressed` is
`markTableOnlyTurn`; a bare `/name` prompt now also gets a directive to run the
skill's procedure. The +4 is 3 net `transcriptStore` cases (deferred suppression,
the no-table regression, the billet-is-not-a-table guard, the clear() reset) and 2
`journalReplay` cases, and Playwright is **171 tests** (+1:
`search-tables.spec.ts`'s no-table case, which failed against the built app with
the old prompt-time suppression). Before that it was **`npm run test` → 4740
passed / 13 skipped** (+42 against the
4698 below - **add-ons carry a content identity, and the Copilot CLI is resolved
by its own agent instead of shipped** (2026-10-26): an add-on has **no version of
its own** any more - `scripts/build-addons.mjs` derives a 16-hex sha256 over its
sources, so the identity changes exactly when the content does (an unchanged
add-on is never re-published or re-downloaded), and every private package's
`package.json` version must equal the application's (build-enforced; excluded
from the hash). `copilot-cli` and binary add-on support are **gone**:
`src/agents/copilot/cli/` resolves the sign-in CLI - newest of {an installed copy
above `COPILOT_CLI_MINIMUM_VERSION` 1.0.83, the agent's own verified cache under
`<stateDirectory>/cli`}, else the latest GitHub release
(`github-copilot-<ver>-<platform>-<arch>.tgz`, sha256 from the release API, ustar
extraction), else a typed failure pointing at the token field. It is **agent
logic, not an application service**: `AgentHost` gained nothing (the
`resolveCopilotCli` capability drafted mid-change was removed again), the agent
takes `createProxyFetch` and reports through `reportAuthProgress`, and it carries
its own `download.ts` because an agent may not import `src/main`. `auth.ts`'s
plaintext-credential scan skips `<stateDirectory>/cli` (digest-verified binaries,
not CLI output). `ArchiveExpectation` became
`{ digest: { algorithm, hex }, size }` so the one verified downloader serves
GitHub's sha256 too. ESLint gained a second agent-boundary block for a folder
nested one level inside an agent (`src/agents/*/*/**/*.ts`), where `src/shared`
is one `../` further away. Zips are now byte-reproducible (sorted entries, fixed
timestamp) and `merge-addons.mjs` refuses two archives under one platform key.
+42 measured: 43 cases in `tests/unit/agents/copilot/cli/` (6 version, 8
discovery, 6 tar, 7 release, 11 resolver, 5 probe), 1 merge-conflict case and the
sign-in's version-reporting case, less the binary-add-on cases (3 in
`manifest.test.ts`, 2 `resolveFile` in `manager.test.ts`) deleted with the
capability. (The delta is measured against the number this file recorded; the
tree had also carried uncommitted work since that run.)
Playwright `addon-download.spec.ts` 3/3 against the rebuilt app (the spec now
reads the pinned identity from `pins.json`); the full suite was not re-run (170
tests, no new cases). Five mutations caught (floor, newest-wins, the darwin
loader symlink, the merge digest guard, the private-version rule). See
`docs/verification/followons-2026-10.md` "Add-ons carry a content identity, and
the Copilot CLI is resolved instead of shipped (2026-10-26)".
Before that it was **`npm run test` → 4698 passed / 13 skipped** (+27 against the
4671 below - **the runtime layer decides the update, and the bundled resources
ship inside the asar** (2026-10-26): the manual `updates.runtimeGeneration`
counter is **gone**, not deprecated - `package.json`, `composition.ts`, the
manifest's `minInstalled` and the updater's fallback were all removed. An in-app
update replaces one file (`resources/app.asar`), so the manifest names the runtime
layer its archive needs - `runtime: { format, electron, payload }`, `payload`
being a path-and-size hash of `app.asar.unpacked` - and the app describes the
layer it is running (`src/main/updates/runtime.ts`) and compares; a difference is
`installerRequired`, `UpdateRuntimePart` names which part
(`format`/`electron`/`payload`) so Settings can say what needs the fresh install,
and an archive entry carrying **no** descriptor is refused rather than guessed at.
The producer is `scripts/runtime-descriptor.mjs`, run by `package-update.mjs`.
`resources/` (skills, rules, icons) moved from `extraResources` into `app.asar`
with it, so an asar-only update finally delivers them; measured on Electron 44
that `readdir(withFileTypes)`, `lstat`, `readFile`, `realpath` and
`nativeImage.createFromPath` all work inside an asar. +27: 13
`runtime.test.ts`, 3 `runtimeDescriptorScript.test.ts` (the release script and the
app agree byte for byte), and 11 across `manifest.test.ts` (+7), `updater.test.ts`
(+3) and `updatesSection.test.ts` (+1); `composition.test.ts` lost the counter
cases. Playwright is **170 tests**; `settings-updates.spec.ts` is 2 - and its swap
case now derives the dev install's descriptor with
`scripts/runtime-descriptor.mjs`, so the built app is driven through the
*equality* path as well as the refusal. `settings-skills`/`skill-autocomplete`/
`home-screen` re-ran green (7). The packaged app was also launched and its home
screen read over the DevTools protocol: six bundled skills out of the archive, and
`package-update.mjs` on that build wrote `electron 44.9.3` + one payload hash.
Three mutations caught, each restored afterwards: the payload hash without sizes
(unit); `checkRuntime` always compatible (the built-app refusal case at
`expect(updates-apply).toBeHidden()`); and the app's hash pinned to a constant
(the built-app *swap* case, which proves it depends on the descriptors being
equal). See §5's "Whether an archive may be swapped in is derived" and
`docs/updates.md`.
Before that it was **`npm run test` → 4671 passed / 13 skipped** (+4 against the
4667 below - **the first prompt after a restore shows its work** (2026-10-26): a
turn's lifetime is now driven by the event that ends it, not by "is the session
idle right now?" - a resumed Copilot session reports its model (`session.model_change`
-> a turn-less `model.changed`) between `sendMessage` registering the turn and the
adapter's `sending`, and reading the state there discarded that turn, so the whole
turn's events were dropped for the renderer (no "Thinking", no billets, no answer)
and every tool that needs `currentToolContext()` failed with `no active chat/turn
to bind to`. New `isTerminalTurnEvent` + `clearTurnIfTerminal(event)` +
`observeTurnSignals` settling on the same event, 4 cases in the new
`tests/unit/main/agentChatControllerTurnBinding.test.ts`, and the opt-in live
scenario `tests/live/first-prompt-after-restore.live.spec.ts`, which reproduced it
in the real app before the fix (`thinking=false`, no new billet, `states=idle`
only, answer never painted) and passes after (`thinking=true`, one billet,
`idle/sending/streaming`, answer painted). Playwright stays 169 tests - the new
scenario is opt-in (`tests/live/`), and the chat-related specs were re-run (36
green). See §5's "A turn lives from `sendMessage` to its own terminal event" and
`docs/verification/followons-2026-10.md` "The first prompt after a restore shows
its work (2026-10-26)".
Before that it was **`npm run test` → 4667 passed / 13 skipped** (+16 against the
4651 below - **the table gutter has two bands** (2026-10-25/26): the header band
(the column-header row and the message surface above it, the heading included)
and the footer band (the total line and the message surface below the table).
An ordinary data row is still never the gutter (hovering a cell is that cell's
own link/CRX popover), the side padding alongside the rows belongs to neither
band, and a message that carries prose of its own keeps the popover on the
table's own chrome. `tableHover.ts` gained `isTableDataRow`, the band split in
`tableGutterFrom` (driven by the pointer's y) and a `placement` per hit;
`hoverActionPopover.ts`'s `HoverActionPlacement` (`top` / `top-end` /
`bottom-end`) lets a gutter popover hang off the anchor's bottom edge, so a table
*without* a total line shows the buttons **below its bottom edge**, beside the
pointer, instead of up over its last row. **Each band is one affordance**:
`transcriptView.ts`'s `HoverTarget` compares gutter hits by shell **and band**, so
the popover is positioned where the pointer enters it and never re-anchors within
it (the reported 1-pixel jump off the header); its `pointerInside` also closes
the popover when the pointer moves into the rows or the inert side padding. The
+16 is 5 net `tableHover` cases plus the other working-tree changes (the freeze
itself adds no unit case - jsdom has no Spectrum overlay); Playwright is **169
tests** (+3 in `table-export.spec.ts`: the two bands, the per-band freeze, and
the total-less footer placement - 7/7 green). Five mutations were caught (the
container branch disabled, the data-row exclusion removed from the region test,
the `pointerout` exclusion removed, the gutter identity compared by element
instead of by shell+band, and the total-less footer anchored to the last row
instead of the table's bottom edge - the last one reproduces the reported ~90px
rise over the last row). See §5's `format_table` bullet and
`docs/verification/followons-2026-10.md` "The table's Copy/Export gutter covers
the whole message (2026-10-25)" and "The table gutter becomes two bands, with a
placement" (2026-10-26).
Before that it was **`npm run test` → 4651 passed / 13 skipped** (+47 against the
4604 below - **heavy add-ons** (2026-10-25): Lighthouse/`puppeteer-core` and
`copilot.exe` left the base install for add-ons downloaded on first use
(`src/addons/<id>/`, `src/main/addons/`, `scripts/build-addons.mjs`), so
`app.asar` went 135.4 MB → 22.6 MB and `win-unpacked` 767 MB → 477 MB. New:
`AgentHost.resolveAddonFile` + `reportAuthProgress` and the `agent:auth-progress`
push; `PageAuditFailureKind` gained `'unavailable'`; the archive fetch+verify was
factored into `src/main/updates/download.ts`; `@github/copilot` moved to
devDependencies; ESLint rule 10 (an add-on folder is a plugin,
`lighthouse`/`puppeteer-core` are add-on-only). Playwright is **166 tests** (+3,
`addon-download.spec.ts`, 9/9 under `--repeat-each=3`); a full run was not
re-measured. See §5 "Add-ons", `docs/addon-architecture.md` and
`docs/verification/followons-2026-10.md` "Heavy add-ons ... (2026-10-25)".
Before that it was **`npm run test` → 4604 passed / 13 skipped** (+14 against the
4590 below - **a confirmation in a message row is modal** (2026-10-25): a
`showPrompt` row makes the region it was raised over - the page-view slot, so the
Settings/History panel, the hosts picker or the home veil - `inert` and veils it
in white (the content fades to disabled weight while the surface stays light, so
the dark strip below stands out), runs the same one-time accent wash a new
`ask_user`
question runs (one definition, in the new `styles/attention.css`), answers "no"
on Escape ahead of the panel's own handler, and is cancelled when its panel is
left or replaced. `showNotice` (Open in folder / Details), `showError` (a failed
navigation's `Reload` included), `showStatus`, the standing floor and the loading
row are untouched, and the browser toolbar's certificate/origin prompts stay
non-modal by owner decision. Shared-surface change, no `contracts/` change:
`StatusBanner` gained `cancelPrompt()` and `createStatusBanner` a `blockingScope`
option, and `lib/alertBanner.ts` gained `flashBannerRow` + the
`BANNER_ATTENTION_*`/`BANNER_BLOCKED_SCOPE_CLASS` exports. The +14 is 9
`statusBanner` and 5 `browserPane` cases; Playwright is **163 tests** (+2,
`blocking-confirmation.spec.ts`, which reads the built app's own pixels through
the new `tests/support/e2e/pixels.ts`), the touched specs all ran green
(blocking-confirmation, history, panel-banner-not-covered, settings-updates,
saved-sign-ins, home-screen, settings-panel-close, settings-skills, and
settings-hosts 4/4 on repeat after its documented one-off flake), and no full
Playwright run was re-measured. A same-day addendum turned the dark scrim into a
**white veil** (content at disabled weight, the surface stays light) and gave the
History panel's Reveal and the chat footer's reveal-log control the same
`sp-icon-folder-open-outline` glyph, with the history spec now comparing the two
icons rather than pinning either. See §5's "A confirmation prompt is modal" and
`docs/verification/followons-2026-10.md` "A confirmation in a message row is
modal ... (2026-10-25)". Before that it was
**`npm run test` → 4590 passed / 13 skipped** (+57 against the
4533 below - **the security review follow-on** (2026-10-25): outside fetches pin the
validated address and fail closed on a resolution error, the address table covers the
full non-public IPv4/IPv6 sets, bodies are capped in bytes with the caller's own limit,
`page_audit` filters a configured host's requests too (nav guards, scoped permissions,
WebRTC off, prompt teardown, a capped queue), `page_read` withholds credential-looking
values behind a `redacted` flag and stops at `limit`/a wall clock, a failed skills or
rules reload keeps the previous catalogues, and a model-chosen `Accept` no longer
decides authentication evidence. Contract changes reported in that section:
`webviewBridgeDomResultSchema` gained `redacted`; `BrokerOutcome` gained `truncated`;
`BridgeRequestOptions` gained `authEvidence`; `ToolHost.externalFetch` gained `maxBytes`.
See §5's `http_fetch`/`page_read`/`page_audit` bullets and
`docs/verification/followons-2026-10.md` "Security review follow-on ... (2026-10-25)".
Before that it was **`npm run test` → 4523 passed / 13 skipped** (+234 against the
4289 below - **custom skills for validator-style audits** (2026-10-25): the new
`http_fetch`, `page_read` and `page_audit` tools, a model-callable `format_table`
with typed columns, the `table-only` skill flag, and **Reload skills**; see the
Skills tab and the `http_fetch` bullet in §5, and `docs/verification/followons-2026-10.md` "Custom skills for
validator-style audits ... (2026-10-25)". Playwright is 161 tests; a full run was 155
passed / 6 failed - the four environment-bound `network-error` cases plus the
load-correlated `host-proxy-selection` and `settings-hosts` flakes, both green on
repeat). Before that it was **`npm run test` → 4289 passed / 13 skipped** (+106 against the
4183 below - **the chat footer's token gauge and the Usage panel** (2026-10-24):
a gauge (gross input/output, hidden while no call has reported either) before the
reveal-log control opens a whole-size Usage panel (model, context, input uncached
and cached, output, cost); the reveal-log icon became
`sp-icon-text-align-justify`. The totals are projected in the renderer
(`chat/sessionUsage.ts`) from `model.usage` / `model.changed` / `context.usage`,
now **forwarded** by the controller (they were journal-only); contract changes in
`contracts/agentEvents.ts` (`costUnit`, `aiCredits`, the new `context.usage`),
`sessionState.ts`, and the agent kit (`shared/agents/usageReport.ts`,
`AgentRuntime.complete`'s usage sink). Both adapters now report **cumulative**
usage (OpenRouter via `getUsage()`), Copilot reports AI credits and the window,
and a runtime's secondary-turn calls (`AgentRuntime.complete`, one reusable routine)
are counted. A new
`tests/unit/agents/agentConformance.test.ts` fails the build for an agent that
does not run the shared usage-contract suites. Playwright is **161 tests** (+3,
`usage-gauge.spec.ts`); the latest full run was 156 passed / 5 failed: the four
environment-bound `network-error` cases plus one load-correlated flake in an
unrelated spec (`ask-user.spec.ts` 43 of 44 on repeat; an earlier run's
`history.spec.ts` "host never answers" flake also fails on a clean HEAD) - see `docs/verification/followons-2026-10.md` "Chat footer:
a token gauge and a Usage panel (2026-10-24)". Before that it was
**`npm run test` → 4183 passed / 13 skipped** (+1 against the
4182 below - **saved sign-ins on AEM's real Granite login form** (2026-10-24):
the form carries hidden `new_password` and `confirm_password` inputs beside
`j_password`. Capture and prefill now ignore hidden password candidates, while
a form that shows them for a password change is still refused. The AEM fixture
mirrors that shape, and `saved-sign-ins.spec.ts` now covers sign-in → sign-out →
prefill in the same launch as well as prefill after a restart; Playwright stays
**158 tests**. The original shape failed six focused unit cases before the fix,
and a built-app prefill mutation failed the same sign-out assertion with both
fields empty - see `docs/verification/followons-2026-10.md` "Saved sign-ins:
automatic capture, per-origin prefill, and one erase action (2026-10-24)",
second addendum. Before that it was
**`npm run test` → 4182 passed / 13 skipped** (+92 against the
4090 below - **saved sign-ins** (2026-10-24): the pane remembers a sign-in form
it saw submitted and prefills it on the next visit. A new
`src/main/credentials/` (`credentialVault.ts` - `(origin, username)` keyed, the
password in `secretStore`, a plaintext index with no password, loaded into
memory once at startup; `capture.ts` - the origin always from
`event.senderFrame.url`, top frame and http(s) only; `autofill.ts` +
`fillScript.ts` - attach to every `WebContents` in the pane's session via
`app.on('web-contents-created')`, inject on `dom-ready` /
`did-navigate-in-page`, fill empty fields only, never submit, and swap the
password when a different saved username is typed; `hostAuth.ts` - an
`isProxy: false` `app.on('login')` challenge answered from the same vault), the
preload's one outbound `credentials:captured` message, the Settings "Browser"
tab's **Erase saved sign-ins** (a lone button, all-or-nothing, through the
shared destructive confirm), `appPaths.credentials`, and **no `contracts/`
schema change** (the vault is not part of `appSettings`).
`statusBanner.showPrompt` now dismisses itself when its action is pressed, so
the outcome it starts takes the row (previously every caller had to `clear()`
first, and this section did not). New `tests/e2e/saved-sign-ins.spec.ts`
(capture → restart → prefill → erase → restart), Playwright **158 tests**; a
full run was 153 passed / 5 failed (the four environment-bound `network-error`
cases + the documented `chat-transcript-scroll` flake), and three mutations
(prefill disabled, capture disabled, prompt self-dismissal disabled) were each
caught in the built app - see
`docs/verification/followons-2026-10.md` "Saved sign-ins: automatic capture,
per-origin prefill, and one erase action (2026-10-24)". Before that it was
**`npm run test` → 4090 passed / 13 skipped** (+30 against the
4060 below - **transcript: the ongoing billet is lowest and one billet expands
at a time** (2026-10-23): `transcriptView.ts` moves running tool-call billets
(and Thinking) after every settled entry, so the spinner is never stranded at
the top; a repaint that changes that order (or updates a table above it) reveals
the ongoing billet, and only one billet - tool call or Thinking - can stay
expanded. The +4 is the new transcript cases, and the +1 is the semantic
progress-overflow case (`23/20` can never be shown). Before that it was 4089
passed / 13 skipped (+29 against the 4060 below - the same work before the
overflow guard). Before that it was 4085 passed /
13 skipped (+25 against the 4060 below - **semantic search: the tool owns the
loop, the model only answers** (2026-10-23): one `aem_semantic_search` call
queries, reads every hit in parallel, asks the active model about each hit page
through the new stateless `ToolHost.answer` / `AgentRuntime.complete`, fills a
display page with `runPageFill`, and paints the table and asks "Load more"
itself. No candidates reach the model; the answer call is retried
(`ANSWER_MAX_ATTEMPTS`, 3 attempts in total). Playwright is **157 tests**, and a
full run was 151 passed / 6 failed - the four environment-bound `network-error`
cases plus `address-deep-link` / `address-hosts-picker`, both green 3/3 in
isolation - see `docs/verification/followons-2026-10.md` "Semantic search: the
tool owns the loop and the model only answers (2026-10-23)"). Before that it was
4060 passed / 13 skipped (+14 against the 4046 below - **semantic search fills a
page before it paints anything** (2026-10-23): accepted matches go into the
reusable `PageFillQueue`; the tool only shows a table once it holds `limit`
matches or AEM is exhausted; a surplus stays buffered for the next click (no
re-query, no re-answering), an empty source page stops probing, and the progress
line reads `Page n · m/limit selected · reading i/n`; the +14 was 8
`pageFill.test.ts` cases and 6 net new `aemSemanticSearch.test.ts` cases). Before
that it was 4046 passed / 13 skipped (+31
against the 4015 below - **authentication loss mid-run** (2026-10-22): a 401, a redirect or a
login-looking HTML body is classified at once, raises a sticky Reload notice,
reloads the pane and fast-fails further reads for that host until the next prompt;
Playwright is **156 tests** (+1, `auth-loss-banner.spec.ts`) - see
`docs/verification/followons-2026-10.md` "Authentication lost mid-run is detected
at once, announced, and the pane reloaded (2026-10-22)"). Before that it was 4015
passed / 13 skipped (+1 against the
4014 below - **a failed or rejected tool call is an ordinary billet**
(2026-10-22): it keeps every other call's borderless surface and
collapsed-by-default disclosure, differs while collapsed only by a red
`sp-icon-cross600` and its status word, and moves its reason out of an
always-visible paragraph and into the **last row of its details table** - the
error message with the suggested action appended (`Error`), or the policy's
reason (`Reason`). The +1 is the rejected case in `transcriptView.test.ts`; the
built-app `agent-chat` cases now expand the billet and assert the icon's
computed colour - see `docs/verification/followons-2026-10.md` "A failed or
rejected tool call is an ordinary billet (2026-10-22)"). Before that it was
4014 passed / 13 skipped (+5 against the
4009 below - **the Windows installer hashes its download without certutil, and
both installers reuse an installed Node.js** (2026-10-22): `install.cmd` called
`certutil` by bare name, so on a machine whose PATH lacks System32 the download
was never hashed and the script reported a false "does not match the pinned
SHA-256"; the hash now comes from PowerShell's `Get-FileHash` (PowerShell is
already required) with `certutil` at its absolute path as the fallback, a file
that cannot be hashed says so, and `PSModulePath` is cleared before any
PowerShell call (a PowerShell 7 parent hid `Get-FileHash`). Both scripts now
prefer an already-installed Node.js at 22.12 or newer that carries npm, and only
download the pinned, signature-checked one when there is none
(`EDAISY_NODE=pinned` forces the tested download). The +5 is
`tests/unit/install/installScripts.test.ts` (line endings, one Node pin across
both scripts, 64-hex hashes, the baseline, absolute Windows tool paths); 5/5
mutations caught - see `docs/verification/followons-2026-10.md` "The Windows
installer hashes its download without certutil, and reuses an installed Node.js
(2026-10-22)". Before that it was **4009 passed / 13 skipped** (+13 against the
3996 passed / 1 failed below - **page-property filters** (2026-10-22): the
publication special case became a generic `filters` array on both search
composites, with operators and date/number ranges, and `search-component` /
`search-page` filter by template through the shared `page-template` skill. The +13
is the new `searchFilters.test.ts` (20 cases, replacing the 9-case
`publication.test.ts`), the new bundled `page-template` skill's front-matter case,
and the fixed pre-existing `searchPageSize` failure - the `search-page` skill's
`limit: 200` was removed when its template listing moved into `page-template`,
which carries no page size. See
`docs/verification/followons-2026-10.md` "The publication filter becomes
page-property filters, and `search-component` filters by template (2026-10-22)".
Before that it was **3996 passed / 1 failed / 13 skipped** (+5
against the 3991 below - **an interrupted tool call never keeps spinning**
(2026-10-20): the transcript store's interruption notice, a turn leaving the
in-flight state, and the journal replay's final sweep all settle the calls' own
statuses (not just the `runningToolCalls` index an interruption used to empty),
so an interrupted billet shows the static icon and `Interrupted` live and after a
restart; an interruption also stops a `format_table`'s pending count. The +5 is 4
`transcriptStore` and 1 `journalReplay` case). Before that it was **3991 passed / 1 failed / 13
skipped** (+8
against the 3983 below - **the edit-mode toggle's long press** (2026-10-20): the
control carries Spectrum's `hold-affordance` and its `longpress` navigates the
open page to the `wcmmode=disabled` web-content view from either state, while a
click still toggles; `EditModeTarget` gained `webContentViewUrl` and the click
Spectrum still delivers after a long press is swallowed. The +8 is 2
`shellViewModel` and 6 `browserToolbar` cases; the same pre-existing
`searchPageSize` failure remains. See
`docs/verification/followons-2026-10.md` "The edit-mode toggle's long press asks
for the web-content view (2026-10-20)"). Before that it was **3983 passed / 1
failed / 13 skipped** (+23
against the 3960 below - **the publication filter** (2026-10-20): 22 new cases in
`publication.test.ts`, `aemQueryFormatAsk.test.ts` and
`aemSemanticSearch.test.ts`. The rest of the gap comes from other working-tree
changes. The same pre-existing `searchPageSize` failure remains. See
`docs/verification/followons-2026-10.md` "Published-only and not-published
search filter (2026-10-20)"). Before that it was **3960 passed / 1 failed / 13
skipped** (+76 against the 3884 below - **in-app updates** (2026-10-21): see "In-app updates"
in §5 and `docs/updates.md`. The one failure is pre-existing and not caused by
it: `tests/unit/tools/searchPageSize.test.ts` "search-page leaves the page size
to the application", because `resources/skills/search-page/SKILL.md` contains
`"limit": 200`. Playwright is **155 tests** (+1 in this change; the previously
recorded 153 was one behind, as the tree measured 154 before
`chat-interrupted-tool-call.spec.ts` was added);
a full run had only the known environment-bound `network-error` cases and
load-correlated flakes (`agent-chat.spec.ts:410`, `settings-tabs`), green in
isolation). Before that it was **3884 passed / 13 skipped** (+3 against the
3881 below - **the `search-page` skill**: the bundled-skill front-matter checks pick
up the new folder, and the deterministic-table cases cover it; no contract change -
see `docs/verification/followons-2026-10.md` "The `search-page` skill (2026-10-20)").
Before that it was **3881 passed / 13 skipped** (+21 against the
3860 below - **an asset link previews and every asset path offers CRX**: AEM
serves a DAM asset's own URL as `Content-Disposition: attachment`, so Chromium
turned the link click into a download that the view session cancelled
(`VIEW_DOWNLOAD_BLOCKED` → `BROWSER_SWITCH_FAILED`, measured in the real app
log) - the new rule-based `src/main/webview/responseHeaderFilter.ts` drops that
header from a renderable response before Chromium classifies it, so the same
bytes display. `classifyAemPath`'s asset branch now always offers **CRX** on the
asset's own node (and Edit for DAM). The +21 is 16
`tests/unit/main/webview/responseHeaderFilter.test.ts` cases (hosts, content
types, dispositions, remove/set mutations, composition), +3
`tests/unit/main/webview/session.test.ts` (the handler and the
`responseHeaderRules` option) and +2 `transcriptView` asset-cell cases; the
built-app `tests/e2e/asset-preview.spec.ts` is 2 cases (Playwright 152 tests) -
see `docs/verification/followons-2026-10.md` "An asset link previews, and every
asset path offers CRX ... (2026-10-19)". Before that it was
**`npm run test` → 3860 passed / 13 skipped** (+2 against the
3858 below - **a model-chosen skill load is a visible billet**:
`transcriptStore.ts` no longer hides every `skill` tool call. A load the model
chose becomes a normal tool billet on settle (the existing `skill` renderer's,
whose collapsed summary is the bare skill name, expanding to Source / Files /
Scripts; a failed load shows
as FAILED too), so an investigation can tell whether a skill was loaded and
which. The controller's synthetic marker for an explicit `/name` prompt carries
`activatedBy: 'user'` in its result and still paints nothing (the user's own
message already names the skill); `skill.ts` now also records `activatedBy:
'model'` on a real load. The skill block in `transcriptStore.test.ts` was
rewritten from 5 cases (all "hidden") to 7 (a model-chosen billet, a failed
load, the `/name` marker hidden, a load with no recorded prompt, and the three
prose-suppression cases), a net +2; the built-app `search-tables.spec.ts` case
now asserts the billet appears (Playwright stays 150 tests). See
`docs/verification/followons-2026-10.md`
"A model-chosen skill load is a visible billet (2026-10-19)". Before that it was
**3858 passed / 13 skipped** (-13 against the
3871 below - **the memo billet loses its hover toolbar**: `ToolCallAction` /
`readActions` and `src/renderer/src/chat/toolCallActions.ts` are gone, the `memo`
renderer offers no actions, and `memos:undo` (channel, IPC handler, preload/API,
`MemoStore.remove`) was removed with its tests. A stored memo now raises the chat
pane's sticky notice ("Memo was stored. Press **Open** to view it in folder"),
whose Open action calls `memos:reveal` so Explorer highlights the file. The new
`chatPane.test.ts` case is +1, while 7 deleted `toolCallActions` cases, 2 registry
`readActions` cases, 1 `toolCallDetails` case, 3 IPC `undoMemo` cases, 1 IPC
channel-iteration case and the deleted store `remove` assertions account for
-14. The built-app `memos.spec.ts` first case was rewritten to the notice + Open
flow (Playwright stays 150 tests; both cases green, and the built mutation failed
it) - see `docs/verification/followons-2026-10.md` "A stored memo raises a
notice ... (2026-10-19)". Before that it was
**3871 passed / 13 skipped** (+12 against the
3859 below - **one page size everywhere**: `DEFAULT_QUERY_LIMIT` (50) is gone;
`SEARCH_PAGE_SIZE` (20) in `src/shared/tools/core/search.ts` is now the one
default of `aem_query` and of both search composites, `resolveSearchPageSize`
is the one post-parse fallback, the `navigate` and `search-component` skills no
longer set `limit`, and `resources/rules/session.md` tells the model not to
choose one (an explicit `limit` remains a permitted override). The new
`tests/unit/tools/searchPageSize.test.ts` (12 cases: the three tools' defaults,
the override, the descriptor's number, and one case per bundled skill) is the
+12; `npm run verify` is green - see `docs/verification/followons-2026-10.md`
"One page size everywhere (2026-10-19)". Before that it was
**3859 passed / 13 skipped** (+5 against the
3854 below - **bundled skill summaries read as labels**: the five user-facing
`metadata.user-description` values in `resources/skills/` lost their trailing
periods, because the home veil and the composer's `/` popup render them verbatim
and the app's copy is a label, not a sentence. `AGENTS.md` section 5 records the
rule ("A skill's displayed summary never ends with a period", binding the
user-description and the technical-description fallback), and
`tests/unit/main/skills/bundledSkills.test.ts` holds every bundled,
user-invocable skill to it by reading the real files (the +5 is one case per
user-invocable bundled skill); the built-app `skill-autocomplete` and
`home-screen` specs were re-run green (Playwright stays 150 tests) - see
`docs/verification/followons-2026-10.md` "Bundled skill summaries read as
labels, with no trailing period (2026-10-19)". Before that it was
**3854 passed / 13 skipped** (+1 against the
3853 below - **the Settings strip's last two tabs swapped**: the order is now
Hosts, Projects, Agents, Skills, **Proxies, Browser**, so the library that
defines proxy entries reads before the Browser tab whose "Default proxy" points
at one of them (`settingsPanel.ts`'s `tabSections` and the `SettingsTab` union
reordered together; tab ids unchanged). The new `settingsPanel.test.ts` case
"orders the strip so Proxies comes before Browser" is the +1, and the built-app
`settings-tabs.spec.ts` gained the same order assertion inside its one case
(Playwright stays 150 tests) - see `docs/verification/followons-2026-10.md`
"The Settings strip puts Proxies before Browser (2026-10-19)". Before that it was
**3853 passed / 13 skipped** (+1 against the
3852 below - **the Skills tab's uniform help formula, order and button width**:
the three folder buttons share one width so they line up as a column, the
Self-learning checkbox sits above the Memos folder action, and every help badge
on the tab now ends with the same ". Changes apply ..." formula (after
restarting the app for skills and rules - both are read once at startup - and on
the next prompt for memos and the checkbox, which are read fresh); the new
`skillsSection.test.ts` order case is the +1, and the built-app
`settings-skills.spec.ts` gained the equal-width and order assertions with its
one case unchanged. The tab also reads as three subsections (skills, rules, the
memos pair), and **one `.subsection-gap` utility** (`settings.css`) now sets the
same 24px gap between subsections wherever it is applied - the Skills section,
the Hosts/Projects/Proxies multifield list and the Agents provider cards - while
the fields inside a subsection keep the plain gap; a new
`tests/support/e2e/layout.ts` (`verticalGap`) lets `settings-skills`,
`settings-hosts` and `step09-model-selection` assert that relationally, without
pinning either gap's exact value (Playwright stays 150 tests) - see
`docs/verification/followons-2026-10.md` "The Skills tab
... (2026-10-19)"). Before that it was **3852 passed / 13 skipped** (+142 against the
3710 below - **self-learning memos**: the memo store/host/rendering, turn signals,
IPC, the `memo` tool, controller reflection, Settings and replay cases; one
redundant `transcriptStore` reflection case deleted; Playwright **150 tests**,
with the new built-app `memos.spec.ts` (2 cases, 48/48 under `--repeat-each=8`
×3) and an extended `settings-skills.spec.ts`; the opt-in
`tests/live/memos.live.spec.ts` is written but not yet run - see
`docs/verification/followons-2026-10.md` "Self-learning memos ... (2026-10-19)").
Before that it was **3710 passed / 13 skipped** (+5 against the
3705 below: a History resume no longer waits for its host - the transcript paints
and the session resumes at once, a send is held until the host switch settles;
the new `chatPaneHistoryResume.test.ts` is 5, and a built-app `history.spec.ts`
case brings Playwright to 148 tests; see `docs/verification/followons-2026-10.md`
"History resume no longer waits for the host (2026-10-18)"). Before that it was
**3705 passed / 13 skipped** (+2 against the
3703 below: a History list already on screen is kept until its replacement is
ready and swapped in whole, so a reopen no longer twitches - `historyPanel.test.ts`
+2; the built-app `history-scroll-stability.spec.ts` gained the reopen
assertion, Playwright count unchanged at 147). Before that it was **3703 passed
/ 13 skipped** (+2 against the
3701 below: the History panel's later pages are appended together rather than
per page, so the scrollbar changes once - `historyPanel.test.ts` +2, and a new
built-app `history-scroll-stability.spec.ts`, Playwright 147 tests; see
`docs/verification/followons-2026-10.md` "History opens in small batches ...
(2026-10-18)", addendum). Before that it was **3701 passed / 13 skipped**
(+33 against the
3668 below - **the History panel's small-batch loading, its travelling actions
and its Reveal action**: `agent-chat:list-conversations` takes an optional
opaque `next` cursor and main serves 25 journals a page from a per-scan
snapshot (`src/main/chatHistoryPager.ts`; `HISTORY_PAGE_SIZE`,
`CHAT_CURSOR_TTL_MS`), the panel builds its Resume / Reveal in folder / Delete
buttons **once** and re-parents the one set into the row the reader hovers or
tabs to, and Reveal calls the chat footer's own `revealJournal` - a
`src/shared/agent-chat-ipc.ts` + `app-api.ts` contract change. The +33 is
`tests/unit/renderer/historyPanel.test.ts` (14, new),
`tests/unit/main/chatHistoryPager.test.ts` (7, new), `tests/unit/main/chatHistory.test.ts`
(+4, the snapshot/page seams replacing `listChatHistory`) and
`tests/unit/shared/agentChatIpc.test.ts` (+8, the request schema and the `next`
on the ok result); see `docs/verification/followons-2026-10.md` "History opens in
small batches, with one set of actions and a Reveal in folder (2026-10-18)").
Before that it was **3668 passed / 13 skipped** (+58 against the
3610 below - **user rules**: generic and per-project `*.md` rules from
`~\etoolbox-daisy\rules`, the Settings "Custom rules folder" link, and the
`resources/instructions/` → `resources/rules/` rename; see
`docs/verification/followons-2026-10.md` "User rules ... (2026-10-17)"). Before
that it was **3610 passed / 13 skipped** (+17 against
the 3593 below - the skill subsystem's review fixes: link rejection, indexed-only
resource reads, module confinement, sandbox limits at the worker boundary, the
per-turn script gate and JSON `input`; see `docs/verification/followons-2026-10.md`
"The skill subsystem: review fixes (2026-10-17)"). Before that it was **3593 passed / 13 skipped** (the skill
subsystem: one app-owned loader for both agents, user skills from
`~\etoolbox-daisy\skills` that win over bundled ones, the three skill tools, the
QuickJS script sandbox, the Settings "Skills" tab and the opt-in `npm run
test:live` harness - see `docs/verification/followons-2026-10.md` "The skill
subsystem ... (2026-10-17)"). Before that it was **3399 passed / 14 skipped** (+1 against the
3398 below - **one set of search limit constants**: `aem_query` and both search
composites take their limit range from `src/shared/tools/core/search.ts`;
`aem_semantic_search`'s max page size is now 200, was 100 - see
`docs/verification/followons-2026-10.md` "Follow-up: one set of search limit
constants (2026-10-16)"). Before that it was **3398 passed / 14 skipped** (+5 against the
3393 below - **"Load all" is one request**: a click makes a single nested
`aem_query` for the proven remainder (at most `LOAD_ALL_ROW_LIMIT`, 2000, which
replaces `LOAD_ALL_PAGE_LIMIT`) instead of paging. The wider `limit` is accepted
only for a nested call - a new optional `nested` flag on the `ToolExecutor`
context, stamped by `createInvokeTool` (a shared-surface change); the model's own
cap stays 200 and `p.limit=-1` stays inexpressible - see
`docs/verification/followons-2026-10.md` "\"Load all\" is one request, not a
series of pages (2026-10-16)"). Before that it was **3393 passed / 14 skipped**
(+23 against the
3370 below - **"Load all" appears when the honest total settles**: a transient
`user.input.actions.added` event adds the button to the already-displayed
"Load more" question instead of waiting for the next one; see
`docs/verification/followons-2026-10.md` "\"Load all\" appears the moment the
honest total settles (2026-10-16)"; +1 Playwright case in
`search-tables.spec.ts`). Before that it was **3370 passed / 14 skipped** (+2 against the
3368 below - **the home screen's Shortcuts section**: the browser pane's home
screen gains a static **Shortcuts** section beneath "Useful commands"
(`HOME_SHORTCUTS` in `homeScreen.ts`), listing the app's keystrokes. Each entry
carries its machine binding (the `code`/`key`/modifier fields `resolveShortcut`
reads) and the display label is derived from it, so the text cannot drift; the
unit cross-check fails if an entry no longer names a live binding, which enforces
AGENTS.md's "revise it when a shortcut changes" rule. The rows keep the skill
rows' text styling but put the keystroke and its description on one line, and
only the sections beneath the action buttons scroll (a fixed header keeps the
scrollbar clear of the close control). +2 `homeScreen` cases, the built-app
`home-screen.spec.ts` fresh-install and veil cases gained assertions, and
mutations were caught (a rebind breaking the cross-check, dropping the section,
and putting the header back inside the scroll container failing the E2E). See
`docs/verification/followons-2026-10.md` "The home screen's Shortcuts section
lists the app's keystrokes (2026-10-16)"). Before that it was
**3368 passed / 14 skipped** (+10 against the
3358 below - **the edit-mode toggle on AEM as a Cloud Service**: the page editor
is served in two URL shapes and the toggle now recognises both. On-prem it leads
the pathname (`/editor.html/content/site/page.html`, unchanged); AEMaaCS (and 6.5
with the unified shell) puts the real UI path behind the shell's `/ui` route in
the fragment (`<origin>/ui#/aem/editor.html/content/site/page.html?appId=aemshell`),
where the toggle used to stay hidden. The shell knowledge stays in one place: a
new `AEM_EDITOR_PATH_PREFIX` + `editorPagePath(candidate)` in
`src/shared/tools/core/currentPage.ts` (which also now shares the prefix with
`AEM_UI_PATH_PREFIXES`) reads the page out of either shape, dropping whatever the
route carried after it (the shell's `?appId=aemshell`). `resolveEditModeTarget`
consults the fragment only when the pathname is not itself the editor, and
untoggling a **shell** editor leaves the shell entirely - the web-content view is
an ordinary page, not a `/ui` route - so its route fragment and shell query are
dropped. Toggling on still produces the plain `/editor.html/...` (which AEMaaCS
accepts; the shell may re-wrap it, and the toggle then reads the shell form).
+6 `editorPagePath` cases, +3 `resolveEditModeTarget`, +1 toolbar, and the built-app
`edit-mode-toggle.spec.ts` gained a shell-URL step; two mutations caught (the
`/aem` app-segment strip and the shell query/fragment drop) plus a build-level
mutation that failed the E2E. See `docs/verification/followons-2026-10.md`
"The edit-mode toggle recognises AEM as a Cloud Service's shell editor URL
(2026-10-16)"). Before that it was
**3358 passed / 14 skipped** (+4 against the
3354 below - **the shell's zoom level persists**: it is stored as an optional
`zoomLevel` in `window-state.json` (`windowState.ts`; omitted at 100%, clamped to
the ±5 zoom bounds), restored on the shell's first `dom-ready` (after `index.ts`
sets `'isolated'`), and saved - debounced - after each shell zoom step
(`attachShortcutHandling`'s `onZoomChanged` → `BrowserControllerOptions.onShellZoomChanged`
→ `scheduleWindowStateSave`) and on the existing close/resize events. The AEM
view's zoom is deliberately **not** persisted. See `docs/verification/followons-2026-10.md`
"The shell's zoom level persists (2026-10-16)"). Before that it was
**3354 passed / 14 skipped** (+52 against the
3302 below - **find-in-page and zoom**: one `Ctrl+F` find bar per pane
(`shell/findBar.ts`) over a `FindController` and a 150ms debounce. The browser
bar drives native `findInPage` over the browser view (the same Chromium highlight);
it refuses unless the page is visible and closes when a panel/Home veil opens,
and only one bar is on screen at a time. The chat bar searches the transcript
subtree directly (`chat/transcriptFind.ts`, CSS Custom Highlight API) because
Chromium's find cannot be scoped - run on the shell document it matched the query
in the bar's own field and the composer's placeholder, and its stepping wandered
out of the transcript. `Ctrl+NumpadAdd`/`Ctrl+NumpadSubtract`/`Ctrl+0` zoom the
focused pane (`src/main/zoom.ts`; both views in isolated mode, never manual - manual reports a new zoom factor without zooming the page - Ctrl+wheel is not a
zoom gesture - the shell in page zoom with the reserved rectangle compensated by
its zoom factor
so the native view never drifts). New `browser.find`/`app.find` actions, three
find channels (`browser:find`/`stop-find` invoke + `browser:find-result` push),
and the built-app `tests/e2e/find-and-zoom.spec.ts` (2 cases, 6/6 under
`--repeat-each=3`); Electron 44 only emits `found-in-page` for `findNext: true`,
so the contract carries no `findNext`. +13 `shortcuts` (rewritten to the result
union), +6 `zoom`, +4 `browserController`, +13 `findBar` (rewritten onto a
controller), +12 `transcriptFind`, +6 `browserPane`, +1 `chatPane`, and shared
`tests/support/e2e/hostView.ts` + `hostFixture.ts`; three mutations caught - see
`docs/verification/followons-2026-10.md` "Find-in-page and zoom ... (2026-10-16)").
Before that it was
**3302 passed / 14 skipped** (+16 against the
3286 below - **application-wide keyboard shortcuts**: with no menu bar to carry
an accelerator, main matches a keystroke in `before-input-event` on *both* the
shell's and the AEM view's `WebContents` (`src/main/shortcuts.ts`) and pushes a
*semantic* action over the new `app:shortcut` channel (`src/shared/shortcut-ipc.ts`),
which the shell dispatches onto its existing toolbar/panel handlers - F5/Ctrl+R
refresh, Alt+Left/Right back/forward, Alt+Home home, Ctrl+L focus the address
bar, Ctrl+H History, Ctrl+, Settings, Ctrl+N New session. `Ctrl+B` (bold in AEM's
rich-text editor) and Backspace-to-go-Back are deliberately unbound, and the
chat actions bind on the shell only, so the AEM page keeps its own
`Ctrl+<letter>` shortcuts; there is no renderer-side shortcut at all. New
`tests/e2e/shortcuts.spec.ts` (1 case, 6/6 under `--repeat-each=6`) drives real
keystrokes from both panes. +10 `shortcuts`, +3 `browserController`, +3
`browserToolbar`, and a shared `tests/support/fakeWebContents.ts` +
`electronInput.ts` (`makeInput` moved out of `devTools.test.ts`); two mutations
caught - see `docs/verification/followons-2026-10.md` "Application-wide keyboard
shortcuts ... (2026-10-16)"). Before that it was
**3286 passed / 14 skipped** (−59 against the
3345 below - **the test-literal cleanup**: tests no longer certify production-owned
copy, CSS classes, icon tags or re-typed constants; those cases were deleted or
turned into state checks, and elements are located by test-id hooks - see §9 and
`docs/verification/followons-2026-10.md` "Test suite: no literal-certifying
tests, test-id hooks, shared helpers (2026-10-16)"). Playwright: 142 tests; a
full run is 135 passed / 5 failed, the 5 being environment-bound `network-error`
(4) and one load-correlated flake (`edit-mode-toggle` this run, 3/3 green in
isolation); the new `shortcuts.spec.ts` passed inside that full run. Before that
it was **3345 passed / 14 skipped** (+9 against the
3336 the working tree measured before this change - the 3333 recorded here
earlier was stale - **contextual help on every Settings field**: each field's
label row is now built by `settings/fieldHelp.ts`'s `labelledField(...)` - the
label, then an `sp-contextual-help` badge (Spectrum 1.12.2, newly added and
registered in `main.ts`) immediately after it - carrying one short phrase per
field, fixed in code; a control with no label of its own (the Browser checkbox)
gets a bare `createContextualHelp(...)` in a `.field-label-row`, while a
non-input control (the Agents auth row) gets none. +4 `fieldHelp`, +1 each in
`hostsSection`/`projectsSection`/`proxiesSection`/`browserSection`/
`agentsSection`, and a new built-app `settings-context-help.spec.ts`; three
mutations caught - see `docs/verification.md` "Contextual help on every Settings
field (2026-10-16)").
Before that it was 3333 (+5 against the
3328 of the previous entry - **technical data moved out of the visible folder**:
`~\etoolbox-daisy` keeps only settings, chats and logs; the browser profile,
agent state (`agents\<id>`, via the new `AgentHost.stateDirectory`), secrets,
window-state and tmp live under `%LOCALAPPDATA%\etoolbox-daisy` (macOS
`~/Library/Application Support/`, Linux `$XDG_DATA_HOME` or `~/.local/share/`,
via `getLocalDataDirectory`); `copilotHome.ts`
and the `copilot` path field are gone, no migration - see `docs/verification.md`
"Technical data moved out of the visible folder to %LOCALAPPDATA% (2026-10-16)").
Before that it was 3328 (+4 against the
3324 of the previous entry - **an agent navigation reveals the page it opens**:
with a whole-size panel (Settings/History/hosts picker) or the Home veil
covering the page-view region, the agent's `browser_navigate` left the new page
hidden underneath. Main now announces the agent's navigation with a new
`browser:agent-navigation` push (`browserController.openForAgent`, sent once the
target has validated) and `browserPane.ts` dismisses the active panel / clears
the veil through the one `revealPageForExternalNavigation` the toolbar's
`onNavigationStarted` (a transcript link, typed address, Back/Forward, Refresh)
already used; an in-page navigation still produces only `browser:state-changed`,
so a panel the user opened is left alone. Shared-surface change (not
`contracts/`): a new channel constant in `ipc-channels.ts`, the
`DaisyBrowserApi.onAgentNavigation` subscription, and its `app-preload.ts`
implementation. +2 `browserPane` (panel dismissed, veil cleared), +2
`browserController` (the push on a real navigation, and nothing on an invalid
path/unknown server); both mutations caught (the controller send removed → its
new case fails; the pane's reveal no-op'd → both pane cases and the new built-app
case fail). Before that it was 3324 (+6 against the
3318 of the previous entry - **a search no longer spends a model round after its
table**: a success payload carrying `TURN_COMPLETE_RESULT_KEY` (`turnComplete`,
`src/shared/tools/core/turnCompletion.ts`) ends the model's turn at that tool
result. The two search composites set it when the search is finished (the table
is the whole answer, so the resumed model's generic "search is finished" line
was pure cost) and `aem_semantic_search` sets it *only* on its terminal call.
Copilot ends the turn with a quiet `session.abort()` + `idle` (never
`cancelling`), OpenRouter through its stop condition with
`allowFinalResponse: false`, and the fake ends the scripted turn. +2
`turnCompletion`, +2 `sdkAgentService`, +1 `openrouter/agentService`, +1
`fakeAgentService`; three mutations caught (the predicate, the tool marker, and
the fake's break) and one built-app `search-tables.spec.ts` case added. The
Copilot path's actual token saving still needs the owner's live confirmation
(`docs/backlog.md`). Before that it was 3318 (+1 against the
3317 of the previous entry - **one destructive-confirmation method**: History's
Delete no longer confirms in a row-local mini-dialog; it raises the same sticky,
one-button `Press {action} to <phrase>` prompt in the
pane-owned message alert banner that Settings uses to remove a host/project/proxy
(the `This can't be undone. ` prefix was dropped: nothing in the app *can* be
undone, so it implied a distinction that does not exist). The prompt copy, the
"OK" label and the `showPrompt` call now live once, in
`confirmDestructiveAction` (`settings/statusBanner.ts`), and all four surfaces
(History delete, host/project/proxy removal) call it; the three Settings sections'
per-item `removeAction: StatusBannerAction` objects became plain `activateRemoval`
functions (their armed/busy guard unchanged), History's `HistoryPanelCallbacks`
became `HistoryPanelOptions` with a `status: StatusBannerSink` (the pane's
`surfaceStatus`), and the obsolete `.history-item__confirm-text` CSS went with the
mini-dialog. +1 `statusBanner` case (the shared method's copy, "OK" button and
`onActivate`). The built-app `history.spec.ts` now asserts the confirmation in
`.surface-status-banner[open]` and the "Conversation deleted" outcome in that same
row; a mutation neutering `confirmDestructiveAction` failed both its unit case and
both E2E cases. See `docs/verification/followons-2026-10.md`
"One destructive-confirmation method for Settings and History (2026-10-15)").
Before that it was 3317 (+10 against the
3307 of the previous entry - **A chat records its host when it is first used**:
the journal's `user.prompt` record gains an optional `serverId`, so a chat's host
is observed at first *use*, not only at open - the startup chat opens before any
page is restored, so its header often named none. `chatJournal.ts`'s
`flushPendingPrompt` fills a still-deferred header's absent `serverId` from the
prompt's, `sendMessage` supplies it from `currentHostContext()` (read
fresh), and `chatHistory` falls back to the first prompt that named a host
(first known host wins). Contract change: `contracts/chatJournal.ts`'s
`user.prompt` gains `serverId`. +2 contract cases, +3 `chatJournal`, +3
`chatHistory`, +2 `agentChatController` (3 existing exact `recordUserPrompt`
arguments updated); the built-app `history.spec.ts` first case now asserts the
startup chat, used on Echo, is listed with Echo, and its second pins the omitted
chip for a chat never used on a host. See `docs/verification.md` "A chat records
its host when it is first used (2026-10-15)". Before that it was 3307 (+11
against the 3296 of the previous entry - **Per-chat SDK session history**: a chat's
journal now records every SDK session it was opened with, so deleting it removes the
SDK's stored data for a runtime recycle's later session too, not only the
header's first. Contract change: a new `session.opened` record in
`chatJournal.ts`. `openChat` appends one when an already-open chat is recycled
to a new session (or a resumed chat is opened under a genuinely new id), and
replaces the still-deferred header's id when a recycle happens before first use;
an id it already recorded appends nothing. The new
`chatJournalReader.readChatSessionIds` returns every id in order (tolerating an
old header-only journal), and `deleteConversation` calls `deleteSession` for
each, still non-fatal per session (`readChatSessionId` → `readChatSessionIds`;
`toChatFileName` moved to a new `chatJournalPaths.ts` so the writer can read at
open time without cycling through the reader). +3 contract cases, +3 reader, +5
`chatJournal`, +2 controller (one a real-journal integration: open → header →
two recycles → read → delete all three ids, file gone); a built-app
`history.spec.ts` case (new) proves deleting a chat whose journal recorded two
sessions removes both and the file. See `docs/verification.md` "Per-chat SDK session history: deletion removes
every session a chat minted (2026-10-15)". Before that it was 3296 (+37 against
the 3259 of the previous entry - **History and conversation browsing**: the chat
toolbar's History button now opens a whole-size **History panel** listing the
stored conversations (title from the first user prompt, start date and host from
the journal header - derived on demand by the new `src/main/chatHistory.ts`, no
`ChatMetadata` store), with **Resume** (paint the journal, then genuinely resume
the header's session; a failure is reported, never silently replaced by a fresh
session) and a two-step **Delete** (new `agentChat.deleteConversation`: stop and
close if open, delete the SDK session via the new `AgentService.deleteSession`,
remove the journal). The shell switches the browser to the chat's host on
resume. Contract change: `AgentService.deleteSession` plus the
`agent-chat:list-conversations` / `agent-chat:delete-conversation` channels.
Owner decisions: History is a panel (not the child window
`requirements-decisions.md` §8 named), single-chat delete is in scope, the list
is derived from the journals, and there is no cross-agent resume-capability flag.
+13 `chatHistory`, +6 controller `deleteConversation`, +3 `sdkAgentService`
`deleteSession`, +1 fake, +6 `historyViewModel`, +7 `agent-chat-ipc` schemas, +1
home-screen action row, and the gate/e2e; four mutations caught and one built-app
spec added. The same work also put **History** and **Settings** buttons on the
browser pane's home screen (before/next to "Select a host") and renamed the home
screen's "Useful tools" heading to "Useful commands" - see
`docs/verification.md` "History and conversation browsing: a list, resume, and
delete (2026-10-15)"). Before that it was 3259 (+27 against the
3232 of the previous entry - **the hosts picker carries the open page**: picking
another host while a page is open opens that page (path, query and fragment) on the
picked host instead of its root, through the new shared
`resolveContextualHostUrl` / `isCarryablePagePath` in
`src/shared/tools/core/navigation.ts` (an allowlist of leading segments, an
auth-parameter guard, built on the same `validateBrowserPath` +
`buildNavigationUrl` as `browser_navigate`) and the toolbar's new
`navigateToHost`; the address bar is the escape hatch - see
`docs/verification.md` "The hosts picker carries the open page to the picked host
(2026-10-15)"). Before that it was 3232 (+5 against the
3227 of the previous entry - **"Load all"**: the chat's search table gains a
**Load all** button beside **Load more**, offered only once an exact total is
known and the remaining matches fit within `LOAD_ALL_PAGE_LIMIT` (100) further
pages, and a click pages to the end without asking again; it wears an
**accent-blue border and label**, distinguishing it from "Load more" (an
emphasized-action class keyed on its label, `composer.ts`) - see
`docs/verification.md` "\"Load all\": one click finishes a search that fits in
the page budget (2026-10-14)"). Before that, 3227 (+85 against the
3142 measured at the start of that work; the 3112 below is the older logged
figure - **search scope and instruction resources**: the model-facing prose moved
out of TypeScript into `resources/instructions/` (now `resources/rules/`; `session.md`, `skills.md`)
(the small per-tool search prose stays inline in each tool), a search's `roots`
accepts a path fragment that
`resolveSearchScope` resolves (config, then one `cq:Page` lookup, then a question
to the user), `MAX_SEARCH_ROOTS` is one shared 10, the current-page block is
facts only, and the journal's `user.prompt` carries an optional `pageContext`;
the search skills lost their duplicated prose. mutations caught - see
`docs/verification.md` "Search scope and instruction resources (2026-10-15)".
A full Playwright run was 126 passed / 9 failed: the 5 known environment-bound
cases (`settings-tabs.spec.ts:30`, four `network-error`), two
`agent-chat` cases (520, 637) that fail identically on a clean HEAD, and
the load-correlated `host-proxy-selection` / `address-deep-link` flakes).
Before that it was 3112 (+21 against the
3091 of the previous entry - **the edit-mode toggle**: a new browser-toolbar
button (`sp-icon-edit`, immediately after the address bar) that flips the open
page between its web-content visitor view and AEM's page editor
(`/editor.html/...`). It is hidden unless an editable `/content` `.html` resource
is open (`/content/dam` excluded, reusing `linkTargets.ts`'s `isDamPath`), and
"on" (labels **Edit mode** / **Exit edit mode**) only while the URL carries
`/editor.html/`; untoggling adds `wcmmode=disabled`, toggling on strips
`wcmmode`. A pure `resolveEditModeTarget` in `renderer/src/shell/viewModel.ts`,
the toolbar wiring, a hidden-state rule and a shared selected-state CSS rule
(now covering both `__agent-toggle` and `__edit-toggle`); 11 view-model + 10
toolbar cases (21 new) and 6 mutations caught - see `docs/verification.md`
"The edit-mode toggle: switch a page between the web-content view and the editor
(2026-10-14)"). Before that it was 3091 (+11 against the 3080 of the previous
entry - **DAM roots**: a `damRoots` free-text field joined
the project group (Settings "Projects" tab, placed last, and the tab's "Content
priority paths" and "Content roots" swapped), `environment_facts` reports it
(default `/content/dam`), and the two search composites default their roots to
content-then-DAM through a new `resolveSearchRoots` while a plain `aem_query`
stays content-only. `resolveEnvironmentRoots` now takes a named
`EnvironmentRootTexts` bag, `EnvironmentFacts`/`ConfiguredHostInfo` gain
`damRoots`, and the settings snapshot/IPC/store all carry it; 11 net new cases
across environment, environmentFacts, the two composites, agentComposition,
projectsSection, settingsStore and the settings projections; 2 mutations caught -
see `docs/verification.md`
"DAM roots: a project field, environment facts, and a search-only root fan-out
(2026-10-14)"). Before that it was 3080 (+25 against the
3055 of the previous entry - **Copy/Export from a `format_table` message's
gutter**: the column-header row and the total line - never an ordinary data row -
offer **Copy** and **Export** in the same travelling hover popover the Edit/CRX
link actions use. Copy writes tab-separated `text/plain` *and* an HTML `<table>`
to the clipboard so a paste into Excel/Google Sheets keeps the grid; Export sends
a CSV (comma/CRLF/UTF-8-BOM) through a new `table-export:save-csv` IPC, where main
shows the OS save dialog and writes the chosen file, then raises a sticky notice
with an **Open in folder** action (`StatusBanner.showNotice`, ranking between an
error and a transient status) whose click reveals the written file in the OS file
manager through a second channel, `table-export:reveal-last` - which takes no
payload, because main remembers the path it wrote. Both serialize the displayed
table - header, data rows, and the total line as a trailing row, without the `#`
index column - and a run with no columns offers neither. The link-only
`linkActionPopover.ts` became the generic `hoverActionPopover.ts` (`HoverAction`),
the gutter region + its two actions live in a new `tableHover.ts`, and the pure
serializers in a new `tableExport.ts`; 12 `tableExport` + 8 `tableHover` cases,
2 `statusBanner` cases for the new notice slot, 3 `alertBanner` cases pinning the
builder's control/text spacing, and a built-app `table-export.spec.ts` (4 cases)
- see `docs/verification.md`
"Copy and Export from a `format_table` message's gutter (2026-10-14)").
Before that it was 3055 (+21 against the
3034 of the previous entry - **one AEM linkifier, absolute URLs, and the "partly
linkified" page-relative path**: `splitAemPathLinks` (`linkTargets.ts`) is now one
stateful, value-driven pass - it links an absolute `http(s)` URL (a configured
host opens in the pane, any other in the system browser), a full AEM path, and a
page-relative `jcr:content/...` path against the last full path it saw - and both
surfaces thread its `AemLinkifyState` through that one core: `renderMarkdown.ts`
over a message's text nodes, `transcriptView.ts` over a `format_table` run's
cells, with the segment-to-DOM rendering shared in `linkSegmentDom.ts`. The
partial is plain, non-navigating text whose hover offers only its node's CRX (no
Edit, no cursor, no hover styling) - so a blanked repeated page path still
resolves, across a `Load more` append and in prose alike; 12 `linkTargets` + 5
`transcriptView` + 4 `renderMarkdown` cases, and one `message-links` E2E case; see
`docs/verification.md` "One AEM linkifier: absolute URLs and the partly linkified
path (2026-10-14)"). Before that it was 3034 (+5 against the
3029 of the previous entry - **no empty conversation shells, and a turn paused on
a question is not "Interrupted"**: a `presentation: 'conversation'` tool call that
paints nothing (an `ask_user` `actions` prompt, a pending question) is now skipped
by `transcriptView.ts`'s new `isEmptyConversation`, so no empty `.chat-ask-user`
shell is left between billets; and a call the journal left running because the turn
was blocked on the user settles as a new `abandonedAwaitingInput` status that shows
**no status word** (just the tool name, settled icon) instead of "Interrupted" -
`journalReplay.ts` detects the pending `ask_user` and passes `awaitingInput` to
`abandonRunningToolCalls` - see `docs/verification.md` "No empty conversation
shells, and a turn paused on a question is not \"Interrupted\" (2026-10-14)").
Before that it was 3029 (+2 against the
3027 of the previous entry - **the component search's table adds a `Node` column
and blanks a repeated page path**: `aem_query_format_ask` splits each hit at
`/jcr:content/` (the standard `Path` column keeps the owning page, a `node` key
carries the component node's path within it), and a page path identical to the
row above is left empty (the `#` numbering still counts every row) - see
`docs/verification.md` "the columns read `Path` / `Node`, and a repeated page path
is blanked (2026-10-14)"). Before that it was 3027 (+3 against the
3024 of the previous entry - **an empty assistant message paints nothing**: a
message whose text is empty (a tool-only turn whose model ends with
`assistant.message.completed`, `content: ""`) no longer renders as an empty gray
bubble - `transcriptView.ts`'s `isEmptyMessage` skips painting it, leaving the
item in the store and the journal for debugging, and it also removes the empty
frame that used to flash before a streaming message's first delta. 3
`transcriptView` cases, one of which asserts the item is still in the store; see
`docs/verification.md` "An empty assistant message paints nothing, but stays in
the journal (2026-10-13)"). Before that it was 3024 (+2 against the 3022 of the
previous entry - **the `search-component` skill and a component-path
split**: a new bundled, user-invocable skill
(`resources/skills/search-component/SKILL.md`) finds the pages that use a
component - resolving a title to a `sling:resourceType` from `cq:Component` nodes
under the component roots, then one `aem_query_format_ask` call over the
component **instances** (`type=nt:unstructured` + `property=sling:resourceType`).
When the predicates match a component by `sling:resourceType`,
`aem_query_format_ask` splits each hit at `/jcr:content/` into the owning page
(`Path`) and the component node's path within it (`Node`) - derived
from the query, never asked of the model, so the page path cannot go missing,
and a page path repeating the row above is blanked (the numbering still counts
every placement) - and
`format_table` maps a `jcr:title` column to `Title`. `/search-component` also joins
`DETERMINISTIC_TABLE_SKILLS`, so its assistant prose is suppressed like
`/search`, and both it and `search` carry descriptions that route a
component-usage request to it. Later live runs tightened it (skill prose only):
step 1 is a strict ordered procedure that must resolve a slashless phrase to a
real `sling:resourceType` (never inventing one), the table is exactly
`Path` + `Node` (no `properties`), and the description carries the no-prose
rule; and one Copilot adapter crash was fixed - the runtime's `reasoningId` can
exceed this application's 200-character id bound, so the adapter now mints its
own (`appReasoningId`). A live fulltext run then exposed a real paging bug - the
priority-path "rest" segment's `N_group.p.not` exclusion does not negate a `path`
predicate, so it overlapped the priority segments and lost 82 of 160 matches
while the honest count still said 160; the segment now excludes with an
`excludepaths` regex (verified live). The instance shape is
index-served, so the background honest count now proves an exact total (the
earlier `property.depth` shape's un-guessed count was aborted by Oak). 2
`aemQueryFormatAsk` executor cases (the split, and its non-component
counterpart), a `formatTable` header expectation, and the `resources/skills`
count in `skill-autocomplete.spec.ts` moved from 3 to 4. See
`docs/verification.md` "`search-component`: the component-instance shape ...
(2026-10-13)").
Before that it was 3022 (+23 against the
2999 of the previous entry - **an accurate search total**: `aem_query` sends a
numeric `p.guessTotal=100` and reports an `exact`/`atLeast`/`unknown` total with a
derived `hasMore` (`totalMatchesSchema.estimated` → `atLeast`), and
`aem_query_format_ask` runs one background un-guessed count whose result updates
the table's total line in place behind a spinner (`format_table` gained an optional
`totalPending`), with a new `src/shared/tools/core/queryBuilder.ts`, a new logger
code `AEM_COUNT_FAILED`, an optional `ToolHost.reportToolDiagnostic`, and a
multi-flight AEM bridge broker (owner override of `requirements-decisions.md` §6 /
`implementation-plan.md` Step 06 - see `docs/verification.md` "An accurate search
total (2026-10-13)"). Before that it was 2999 (+33 against the
2966 of the previous entry - **priority search paths**: a project gains
`contentPriorityPaths` (Settings "Projects" → "Priority paths"), `environment_facts`
reports `priorityPaths` per host, and `aem_query` returns results from those paths
first with seamless Load-more paging; contract changes in `projectConfig.ts`,
`settingsSnapshot.ts`, `settings-ipc.ts`, `navigation.ts` and the
`EnvironmentFacts`/`ResolvedEnvironmentRoots` types - see `docs/verification.md`
"Priority search paths (2026-10-13)"). Before that it was 2966 (+44 against the
2922 of the previous entry - **the Settings "Projects" tab**: the host's
`contentRoots`/`componentRoots` moved into a new `projects` library (`id`+`label`
required, roots optional) with a **Projects** tab after **Hosts**, and each host
gains an optional **Project** combobox whose "(Default)" applies the
`/content`/`/apps` defaults. A contract change (`serverConfig.ts` loses the roots
and gains `projectId`; new `projectConfig.ts`; `appSettings.ts`/
`settingsSnapshot.ts`/`settings-ipc.ts` follow), a new
`resolveHostEnvironmentRoots(host, projects)` in `tools/core/environment.ts`, a
new `projectPicker.ts` + `projectsSection.ts`, and the `environment_facts` output
unchanged (the project stays Settings-side). New: `settingsStore` project
mutations (9), `projectsSection` (12), `projectPicker` (4), the `appSettings`
project-integrity cases (3), `resolveHostEnvironmentRoots` (4), a
`createConfiguredHosts` case, and 6 `ipc/settings` project cases; see
`docs/verification.md` "Settings \"Projects\": host structure facts move off the
host, and a host picks one (2026-10-13)"). Before that it was 2922 (+3 against the
2919 of the previous entry - **the semantic-search continue call is no longer a
blank billet**: `describeCall` keys on the call's own `terms`, so a continue call
(`{ searchId, matches }`) reads `judging N match(es)` (no `Semantic search:`
prefix - the header already names the tool) with Search ID/Matched rows instead
of `Semantic search:` with a dead chevron, and the two search renderers' shared
JSON helpers (`asRecord`/`asCount`/`asText`) moved to
`src/shared/tools/core/toolRenderer.ts` - 2 `aem-semantic-search` renderer + 1
`toolCallDetails` case; see `docs/verification.md` "The semantic-search continue
call no longer renders as a blank billet (2026-10-12)"). Before that it was 2919
(+4 against the
2915 of the previous entry - **a restored unfinished call reads "Interrupted"**:
`ToolCallStatus` gains `abandoned`, labelled "Interrupted" and drawn with the
static icon, and `replayJournalIntoTranscript` settles every still-running call
at the end of the replay (`TranscriptStore.abandonRunningToolCalls`), so a call
the journal never resolved - the app closed mid-turn - no longer spins forever
("Load more" cannot resume: the executor's state died with the process) - 1
`journalReplay` + 2 `transcriptStore` + 1 `transcriptView` cases; see
`docs/verification.md` "A restored unfinished tool call no longer spins forever
(2026-10-12)"). Before that it was 2915 (+4 against the
2911 of the previous entry - **one unfinished-process indicator at a time**:
"Thinking" is hidden while any tool call runs, a running billet is hidden while
the turn waits on an `ask_user` question (`TranscriptStore.isAwaitingUserInput`,
with the view's `hiddenWhileAwaitingInput` deciding by a tool's presentation), and
a running tool-call billet's progress line is written in place so its spinner no
longer restarts on each tick - 2 `transcriptStore` + 2 `transcriptView` cases; see
`docs/verification.md` "Semantic search: a live progress line, concrete node
paths, and a 20-hit page (2026-10-12)", follow-up). Before that it was 2911 (+12
against the
2899 of the previous entry - **semantic-search feedback, concrete node paths and
a 20-hit page**: a new transient `tool.call.progress` agent event plus the
optional `ToolHost.reportToolProgress` capability, rendered as a spinner and a
live "Reading n of m" line on a running tool-call billet (2 `agentEvents` schema
cases, 3 `agentChatController` cases, 2 `transcriptStore` cases, 3
`transcriptView` cases, 1 `aemSemanticSearch` progress case); the
`aem_semantic_search` table's `Path` is now the concrete node the excerpt's
property lives on and `Property` its bare name, wrapped at any character (1
`aemSemanticSearch` case, 1 `transcriptView` case, and the strengthened
`/semantic-search` E2E case); and `SEARCH_PAGE_SIZE` is 20, not 50 — see
`docs/verification.md` "Semantic search: a live progress line, concrete node
paths, and a 20-hit page (2026-10-12)"). Before that it was 2899 (+6 against the
2893 of the previous entry - **relevant-match totals, an internal `format_table`
and one page-size constant**: `format_table`'s `notice` became `totalLine`,
`aem_semantic_search`'s total counts relevant matches, `format_table` is
`internal` (a new optional `ToolModule.internal` flag - a shared contract
change - and `ToolRegistry.internalNames`), `aem_query_format_ask` accepts
`predicates`, and `SEARCH_PAGE_SIZE` is the one default page size; see
`docs/verification.md` "Relevant-match totals, internal format_table, one page
size (2026-10-12)"). Before that it was 2893 (+21 against the
2872 of the previous entry - **`aem_semantic_search`, a stateful composite tool
that reads and offers EVERY hit for judging**, plus a `format_table` `notice`
for an empty run: 17 tool cases, 2 `format_table` notice cases, 1 transcriptView
notice case, 1 `toolCallDetails` case; see `docs/verification.md`
"`/semantic-search` runs on the `aem_semantic_search` composite (2026-10-12)").
Before that it was 2872 (+6 against the
2866 of the previous entry - **the ask-user question flash and the dropdown
strip styling**: every `ask_user` mode now flashes the composer frame blue once
(the `chat-composer__frame--attention` overlay, removed on `animationend` so a
repaint cannot replay it) and fades to that variant's resting background, and the
two >5-option dropdowns now wear the same gray, borderless strip as the action
buttons with the "type your own answer" control and Submit painted as white,
dark-text buttons instead of blue; 4 `composer.test.ts` flash cases and 2 strip
cases; see `docs/verification.md` "The ask-user question flash and the dropdown
strip styling (2026-10-12)"). Before that it was 2866 (+8 against the
2858 of the previous entry - **`ask_user` hung because the runtime's built-in
`ask_user` hijacked the app tool**: every app tool now sets
`overridesBuiltInTool: true`, and a 15 s dispatch watchdog fails a turn whose app
tool started but never reached the application; 8 `sdkAgentService` cases; see
`docs/verification.md` "ask_user hung: the runtime built-in hijacked the app tool
(2026-10-12)"). Before that it was 2858 (+6 against the
2852 of the previous entry - **startup-restore presentation**: "New session" now
start-disabled and derived from `chatId !== undefined && pendingOpen === undefined`
(`chatPane.ts`'s `updateNewSessionEnabled`), the composer's Send disabled while a
restored session is still resuming (`ComposerStatus.resuming`), and
"Restoring conversation..." kept up for the whole resume instead of clearing when
it begins; 4 `composerViewModel` cases + 2 `chatPane` cases, and the pre-existing
"New session does nothing before any conversation" case tightened to assert the
disabled state; see `docs/verification.md` "Startup restore: ... (2026-10-12)").
Before that it was 2852 (+11 against the
2841 of the previous entry - **uniform agent diagnostics**: the shared
`modelObserver`, the shared conformance suite run by both adapters, minus the
duplicated per-agent cases; see `docs/verification.md` "Session diagnostics: one
uniform contract across agents (2026-10-11)"). Before that it was 2841 (+45 against the
2796 of the previous entry - **session diagnostics, Phase 1**: the journal-only
`model.changed` / `model.usage` / `model.call.failed` events (emitted by both
agents via `src/agents/copilot/sessionDiagnostics.ts` and
`src/agents/openrouter/usageDiagnostics.ts`, journaled but never forwarded to the
renderer), a `turn.summary` journal record folded by `chatJournal.ts`, and the
`AGENT_TURN_SUMMARY` log code. Contract changes: `agentEvents.ts`,
`chatJournal.ts`, `sessionState.ts`. See `docs/verification.md` "Session
diagnostics, Phase 1 ... (2026-10-11)"; Phase 2 is in `docs/backlog.md`). Before
that it was 2796 (+25 against the
2771 of the previous entry - **"Navigate to page": a `browser_navigate` tool, a
`navigate` skill, and cause-aware navigation cancellation**. `browser_navigate`
opens a page on a configured host (label -> origin resolved by the application;
verbatim browser path); `environment_facts` was renamed from
`aem_environment_facts` and now reports every configured host, not only the
current one; the navigation epoch carries an `initiator`, so an agent-initiated
switch (`openForAgent`) no longer cancels the agent's own turn while a user
navigation still does. New: `tests/unit/tools/browserNavigate.test.ts` (13),
`tests/unit/tools/environmentFacts.test.ts` (7), the `openForAgent` cases in
`browserController.test.ts` (5), the initiator cases in `navigationEpoch.test.ts`
(+2) and `agentComposition.test.ts` (+1). Two mutations were caught (the
agent-initiator skip, and `openForAgent`'s post-settle check). See
`docs/verification.md` "Navigate to page: a browser_navigate tool, the navigate
skill, and cause-aware navigation cancellation (2026-10-11)"). Before that it was
2771 (+5 against the
2766 of the previous entry - **a message the application updates in place is
revealed even after the reader scrolled up**: `TranscriptView.repaint` now
reports a `presentation: 'message'` run whose content changed (a `/search` or
`/semantic-search` table gaining a `Load more` page) and `TranscriptFollower.reveal`
scrolls that message's bottom into view and resumes following, superseding the
"do not scroll if the reader conscientiously scrolled up" rule. 2
`transcriptFollower` and 3 `transcriptView` cases, plus one
`chat-transcript-scroll` E2E case against the built app; a mutation (reveal
disabled) was caught with `bottomGap 2622`. See `docs/verification.md` "A message
the application updates in place is revealed ... (2026-10-11)"). Before that it
was 2766 (+2 against the
2764 of the previous entry - **the composer keeps focus after a Cancel/Stop**:
the Stop control's click handler now focuses the prompt field right after
`onStop()` runs, so both the true Cancel (abort) and the "back to text input"
dismissal of an `ask_user` question leave the keyboard in the field. Two
`composer.test.ts` cases (plus focus-spy assertions in two `chatPane.test.ts`
cases and two E2E specs). See `docs/verification.md` "The composer keeps focus
after a Cancel/Stop (2026-10-11)"). Before that it was 2764 (+12 against the
2752 of the entry before - **skills are auto-inferred from their
descriptions**: a `skill` catalogue is composed onto the session instructions,
the two search skills are mode-agnostic, and a model-loaded search turn has its
prose suppressed. 3 `renderSkillCatalogue`, 3 model-catalogue, 5 transcript-store
and 1 Copilot `skill.invoked` cases. See `docs/verification.md` "Skills are
auto-inferred from their descriptions ... (2026-10-11)"). Before that it was 2752
(+2 against the
2750 of the entry before - the search table is no longer rebuilt on every
repaint; two `transcriptView.test.ts` cases. See `docs/verification.md` "The
search table was rebuilt on every repaint (2026-10-11)"). Before that it was 2750
(+3 against the
2747 the working tree already measured - this section's previous 2744 was stale).
The +3 is the chat-panel fixes: a `buildNoAnswer` builder case
(`composerViewModel.test.ts`), the `ask_user` dismissed-answer case
(`askUser.test.ts`), and the pane's cancel-on-a-question case
(`chatPane.test.ts`). The same change also moved the search total line below the
table, swapped the composer's cancel icon to `sp-icon-cross600`, and added one
Playwright case. See `docs/verification.md` "Chat panel: cancel means \"no
answer\", the cross600 cancel icon, and the total line under the table
(2026-10-11)". Before that the working tree measured 2747 (the +3 nobody recorded
here); before that it was 2744 (+2 against the previous 2742: New session now
focuses the composer — `Composer.focus()` and its call in `startNewSession`
(`composer.test.ts` + `chatPane.test.ts`); see `docs/verification.md` "New
session focuses the composer (2026-10-11)"). Before
that it was 2742 (+6 against the
previous 2736: one conversation open at a time — the controller's
single-flight/`superseded` guard (`agentChatController.test.ts`) and the pane's
"New session" gate plus superseded-open swallowing (`chatPane.test.ts`); see
`docs/verification.md` "Chat: one conversation opens at a time - the \"is not the
open conversation\" banner (2026-10-11)"). Before that it was 2736 (+28 against
the previous 2708: the tool-to-tool bridge — `invokeTool` guards in
`toolRegistry.test.ts`, nested-call cases in `agentChatController.test.ts`, the
`aem_query_format_ask` executor/renderer suite and its `toolCallDetails` case;
see `docs/verification.md` "Tool-to-tool bridge and the `aem_query_format_ask`
composite (2026-10-09)"). Before that it was 2708 (net +2 against
the previous entry's 2706 — the transcript no longer lands on the *top* of the
newest entry: `transcriptFollower` now recognises its own programmatic scroll by
the `scrollTop` it left the viewport at, so a late-laying-out entry (an
`sp-table`) can no longer be misread as the reader scrolling away — see
`docs/verification.md` "The transcript landed on the *top* of the newest entry
... (2026-10-09)"; before that, 2706 was net −1 against the previous entry's 2707
— the "Settings changes apply on the next turn" work
removed 7 obsolete lock/refusal cases and added 7 (6 deferred-recycler cases plus
the `beforeSendMessage` case), with the 5-case lock predicate shrinking to a
4-case turn-in-flight predicate). Model, proxy,
token and active-provider changes are no longer disabled or refused mid-turn:
a model/effort change already applied at the next prompt, and a
proxy/token/active-provider recycle is now *deferred* to the next turn by the
deferred recycler (`createDeferredRuntimeRecycler`) that the settings handler
queues into and the gated controller's `beforeSendMessage` drains; removed
`changesLocked` from `modelCatalog.ts` and `turn_in_flight` from
`settings-ipc.ts`, renamed `isModelSelectionLocked` → `isAgentTurnInFlight`,
and added the recycler/`beforeSendMessage` tests — see `docs/verification.md`
"Settings changes apply on the next turn (2026-10-09)"; before that, the +3 since
2695 is the composer `/` autocomplete accepting the highlighted skill on Enter,
not only Tab — two `composer.test.ts` wiring cases plus a rewritten
`resolveSkillMenuKey` case, `docs/verification.md` "Composer `/` autocomplete:
Enter (and Tab) accept the highlighted skill (2026-10-09)"; before that, the +15
since 2680 is the interruption-notice Resume action — the "Session stopped" notice is now
a billet (`sp-icon-cancel` + tool-call typography) that, while live and newest,
offers a quiet "Resume" button sending `Resume` as a prompt, and is persisted as a
new `interruption` journal record replayed as historical/no-button: store flag,
four transcriptView cases plus the click, the chatPane round-trip, journalReplay,
two chatJournal writer cases and three controller cases, plus the reader
round-trip — see `docs/verification.md` "Chat: the interruption notice became a
billet with a Resume action ... (2026-10-09)"; the +10 since
2670 is the deterministic-search-tables work — the `format_table` tool, the
`ask_user` actions mode, composer helpers, adapter/fake `actions`, and transcript
run-grouping/prose-suppression cases, less the deleted
`queryResultViewModel.test.ts`; see `docs/verification.md` "Deterministic search
tables ... (2026-10-09)"; before that, the +1 since
2669 is the OpenRouter auth-read race fix — `getAuthStatus`/`getAuthPresence`
now await the in-flight install, so a Settings open that races startup no longer
leaves the Model picker disabled; see `docs/verification.md` "OpenRouter's auth
read raced its own startup (2026-10-08)"; the +5 since
2664 is the Home-as-a-veil work — Home over a loaded page now blanks the
address bar, disables Back/Forward, and shows a close control on the welcome
screen (2 toolbar cases, 2 pane cases, 1 home-screen case) — see
`docs/verification.md` "Home is a veil, not a page (2026-10-08)"; the +3 since
2661 is the typographic-hyphen fix — a U+2011 non-breaking hyphen (and the other
hyphen variants: U+2010, U+2012, U+FE63, U+FF0D) is now a path segment character
and folds to ASCII `-` in the resolved URL, so `custom‑skeleton` links over its
whole length instead of stopping at `custom`: one `classifyAemPath` case, one
bare-path case and one `renderMarkdown` case — see `docs/verification.md`
"Typographic hyphens in paths, and wide link tables (2026-10-08)"; the +3 since
2658 is the code-span linkification fix — a bare AEM path is now linkified
inside inline code and fenced code blocks too, not only in prose: one old
`renderMarkdown` case replaced by four — see `docs/verification.md` "AEM paths
inside inline/fenced code are links too (2026-10-08)"; the +2 since
2656 is the deferred-journal-header work — a bare chat no longer leaves a
journal file, and a dev-only `!!open <ChatId>` trigger was added; see
`docs/verification.md` "Bare chats leave no journal file, and a dev-only
`!!open <ChatId>` trigger (2026-10-08)"; the +1 since
2655 is the chat-link-dismisses-Settings fix — an externally-caused navigation
(chat link, typed address, Back/Forward, Refresh) now dismisses a whole-size
panel covering the page-view region, while in-page navigation leaves it alone:
one old `browserPane` case rewritten and two new unit cases (-1 +2) — see
`docs/verification.md` "A chat link now dismisses an open Settings panel
(2026-10-08)"; the +5 since
2650 is the bare-install auto-activation — a credential action activates the
provider it just made eligible while no provider is active, so setting up the
first agent no longer needs a separate "Set active" click; see
`docs/verification.md` "The first provider a credential action makes eligible
activates itself (2026-10-08)"; earlier, the +4 since
2628 is the agent-startup deferral — `runAfterFrameLoad` in
`agentComposition.ts` keeps the agent SDK's ~740 ms synchronous import off the
window's startup path; see `docs/verification.md` "The agent SDK is imported only
after the shell has painted (2026-10-08)"; the +3 since
2625 is the transcript stick-to-bottom intent fix — a layout change (a banner,
the composer growing, a late image) no longer counts as the reader scrolling
away, and a sent prompt always re-pins: the new `transcriptFollower.ts` with its
unit and built-app specs — see `docs/verification.md` "The chat transcript got
stuck when a layout change looked like scrolling away (2026-10-08)"; the +8 since
2609 is the address-bar host-chip stability fix — the chip now matches an
*inferred* host prefix, not only an exact origin, so it stops blinking while a
host address is edited: 7 `resolveAddressChipHost` cases and 1 toolbar case —
see `docs/verification.md` "The address-bar host chip flickered while a host
address was edited (2026-10-08)"; the +11 since
2598 is the address-bar type-ahead fix — the completion no longer re-runs after
Backspace/Delete/cut/drag/undo or during IME composition: 5 predicate cases and
6 listener cases — see `docs/verification.md` "The address bar re-applied its
completion after Backspace/Delete (2026-10-07)"; the +1 since
2597 is the renderer-reload "Restoring conversation…" banner regression test —
see `docs/verification.md` "A renderer reload could strand the 'Restoring
conversation…' banner (2026-10-07)"; the +23 since
2574 is the ask-user work — the `ask_user` tool, the
composer-view-model answer helpers, the transcript conversation presentation,
and the fake/controller interactive-question tests; the `!!ask` dev preview
itself is intentionally **untested** — see §5 — so no test was added or kept for
it — see `docs/verification.md`
"Ask-user: a choose-from-options tool for the chat composer (2026-10-07)"; the +3 since
2571 is the transcript-footer follow-on — the session id became a
`sp-icon-file-txt` icon and an agent/model/reasoning summary that opens Settings
— see `docs/verification.md` "Follow-on: the footer's session id became an icon,
with an agent/model/reasoning summary (2026-10-06)"; the +22 since
2549 is the transcript-cosmetics work — interruption notices, the session-id
footer, and the bold skill name — see `docs/verification.md` "Chat transcript:
interruption notices, a session-id footer, a bold skill name (2026-10-06)"; the +7 since
2542 is the aborted-traversal HTML classification fix — see
`docs/verification.md` "AEM's aborted-traversal HTML is not a sign-in page
(2026-10-06)"; 2542 is the single tool-details rendering shape; the +85 since
2451 is the environment-facts work — the host content/component roots fields,
the `aem_environment_facts` tool, `aem_query`'s `roots` fan-out, and the
read-only policy moving out of the deleted `aem-tool-selection` skill into the
always-injected instructions; see `docs/verification.md` "Environment facts,
host roots and aem_query root fan-out (2026-10-06)"; before that, a +2 since the
2449 baseline is the proxy-unification `tests/unit/main/agents/proxyFetch.test.ts`
— see `docs/verification.md` "Dependency review and proxy unification
(2026-10-05)"; the +34 before that is the OpenRouter agent suite:
`tests/unit/agents/openrouter/**`, the Copilot `authPresence` test, and the
updated settings tests — see
`docs/verification.md` "Agent plugins: OpenRouter as a second provider
(2026-10-05)"; a further +3 is the OpenRouter `state`-accessor fix — see
`docs/verification.md` "OpenRouter turn failure: `state` accessor misuse, error
recovery, immediate prompt (2026-10-05)"; `proxy-login.test.ts`
case 7 was fixed on 2026-09-30: the CLI validates the certificate chain after the
TLS handshake, so the test now asserts "no request over the untrusted tunnel"
instead of a proxy-side handshake error);
**Playwright → 146 tests** (`npx playwright test --list`; +1 against the previous
145). The latest +1 is a third `history.spec.ts` case, proving against the built
app that the panel's Reveal action hands main the id of the row it acts on and
main derives that chat's journal path and asks the OS file manager to reveal it
(`shell.showItemInFolder` stubbed with the shared `support/e2e/shellStubs`
recorder); the same spec's first case now also pins the built app's travelling
actions (one `data-testid="history-actions"` element for the whole list, hidden
by `visibility` until its row is hovered or focused, carried to the reached row)
- two mutations were caught against the built app (removing the row-focus step
before focusing the Resume, and making the actions always visible). A **full**
run was not re-measured for this change; the touched specs (`history`,
`home-screen`, `panel-closeability`, `chat-restore`, `chat-session-footer`,
`table-export`, `message-links`) were run and passed, except the load-correlated
`message-links` "moving the pointer swiftly" flake (green 3/3 in isolation). The
previously-listed `settings-context-help.spec.ts` case, proving against the built app that
every Settings field's `sp-contextual-help` badge is a genuinely registered
element with a shadow root, sits immediately after its label, is styled as an
understated marker (scale 0.8, opacity 0.7 rising to 1 on hover, no fill change),
and opens its popover on click (a mutation removing the registration import from
`main.ts` failed it at `customElements.get`; a mutation dropping the badge from
`labelledField` failed the unit suites too). Before that, the +1 since 137 is a
new case in `settings-panel-close.spec.ts`, proving against the
built app that an agent navigation (the `browser:agent-navigation` push sent from
main) dismisses an open Settings panel and restores the native view; a mutation
no-op'ing the pane's reveal failed it with the panel still open. It clicks the
chat toolbar's Settings button (`.chat-toolbar sp-action-button[title="Settings"]`)
rather than the literal `.first()` the two older cases in that spec use: those two
fail on a clean HEAD in this environment because the Home screen's own
`browser-home__action` Settings button is earlier in the DOM and hidden while a
page is loaded (reproduced with this work stashed) - pre-existing, not caused by
this change. Before that, the +1 since 136 is a fifth `search-tables.spec.ts` case,
proving against the built app
that a turn-completing search result (`turnComplete`) ends the turn: the model is
not resumed, so a scripted closing delta paints no bubble, no "Session stopped"
notice is raised and the composer is ready (a mutation disabling the fake's rule
failed it with the bubble present). Before that, the +1 since 135 is a fourth
`chat-session-footer.spec.ts` case, proving against the
built app that an empty conversation (the full-height composer, `.chat-pane--empty`)
still shows the footer's agent/model/reasoning summary while the reveal-log icon
is hidden - which failed on the missing `.chat-session-id[hidden] { display: none }`
rule (its class `display: inline-flex` outranked the UA `[hidden]`) before the fix.
Before that, the +1 since 134 is `history.spec.ts`, proving against the built app that the History
toolbar button opens the panel, that two sent conversations are listed newest
first with their titles, dates, and host chips (omitted for the chat that named
no host), that **Resume** reopens one
(its transcript returns), and that the two-step **Delete** removes the other (3/3
under `--repeat-each=3`; a mutation making the History button a no-op failed it
at `expect(.history-panel).toBeVisible()`). The five neighbouring specs named in
that entry were re-run green, and `agent-chat` shows only its documented
pre-existing case-637 failure. Before that, the +1 since 133 is the new
`host-switch-contextual.spec.ts`,
proving against the built app, with two request-recording servers, that picking a
host carries the open page to it (and its query), re-picking the open host and a
login URL fall back to the root, and a typed origin stays the escape hatch - 5/5
under `--repeat-each=5`, and a mutation on the built pane failed it. The +1 since
131 is the new `edit-mode-toggle.spec.ts`, proving against the built app
that the browser toolbar's edit-mode toggle exists (`sp-icon-edit` registered
with a real shadow root, immediately after the address bar), is hidden unless an
editable `/content` `.html` page is open, and flips the open page between
`/content/site/page.html` and `/editor.html/content/site/page.html` (asserting
the address bar follows and a non-`.html` URL hides it again). Before that, the
+4 since 127 is the new `table-export.spec.ts`, proving against the built app
that hovering a `format_table` message's header row opens the Copy/Export popover
right-aligned to the table (and hovering a data row does not), that Copy writes
tab-separated text *and* an HTML table to the real OS clipboard (read back in
main), and that Export writes the CSV to the path the save dialog (stubbed in
main) names and then shows an "Exported to <file>.csv" notice whose **Open in
folder** action reveals that path (recorder in main) and dismisses the notice.
Before that, the
+1 since 126 is the `message-links.spec.ts` case proving, against the built app,
that a page-relative table cell is a non-anchor hover target whose popover offers
only its node's CRX (and resolves it against the page above when the repeat was
blanked) - run `--repeat-each=4`, four green, and a selector mutation made it
fail. Before that, the +1 since 125 is the `message-links.spec.ts` case proving,
against the built app,
that an in-message table's path link computes to `text-decoration: none` (a
removal mutation rebuilt the app and failed with `underline`). Before
that, the +1 since 124 is
`chat-restored-scroll.spec.ts`: a restored conversation whose journal holds six
search tables must sit at the transcript's bottom, and a new turn's answer must
be followed - the first spec where a *restored* transcript's stick-to-bottom is
driven against the built app (every sibling case runs its turns live). It pins
Chromium's **scroll anchoring**: a restored `sp-table` measures many times its
final height before it upgrades, and with the pinned viewport at the bottom of
that unsettled layout the browser's anchoring moved `scrollTop` to keep the
content stable instead - which `transcriptFollower.ts` read as the reader
scrolling away, switching the follow intent off for good, since the
`ResizeObserver` re-pins only *while* following. The fix is `overflow-anchor: none`
on `.chat-transcript` (`chat.css`). Six turns is load-bearing: with fewer the
pre-layout content fits, the adjustment lands at the bottom anyway, and the
spec passes without the fix (verified both ways). See
`docs/verification.md` "The restored transcript was not scrolled to the bottom
(2026-10-13)". Before that, the 124 was the
`/semantic-search` case in `search-tables.spec.ts` rewritten (count
unchanged) to the `aem_semantic_search` flow: "Did not find any relevant results
so far" in the total slot, then an appended row with "Total: 1";
it now also asserts, against the built app, that the row's `Path` cell is the
concrete node path and its `Property` cell is the bare `jcr:description` wearing
the wrap-at-any-character class — see `docs/verification.md` "Semantic search: a
live progress line, concrete node paths, and a 20-hit page (2026-10-12)"). Before that, the
+1 since 123 is the `ask-user.spec.ts` case proving, against the built app, that
a >5-option dropdown wears the action strip (gray frame, transparent border) with
a white, dark-text free-answer control and Submit, and that a new question flashes
the frame once (a `MutationObserver` sees the class arrive and clear). See
`docs/verification.md` "The ask-user question flash and the dropdown strip styling
(2026-10-12)". Before that, the
+2 since 121 is `navigate.spec.ts`, proving the built renderer's
`browser_navigate` and `environment_facts` billets (summary + expanded rows); the
new user-invocable `navigate` skill also moved `skill-autocomplete.spec.ts`'s
expected list from 2 to 3 skills. See
`docs/verification.md` "Navigate to page: ... (2026-10-11)". Before that, the
+1 since 120 is the `chat-transcript-scroll.spec.ts` case proving a `/search`
table grown by **Load more** is revealed at its bottom even after a real wheel
scroll up (an 80-row table growing to 85, `bottomGap <= 4`); a mutation with the
pane's `reveal` disabled left `bottomGap 2622`. See
`docs/verification.md` "A message the application updates in place is revealed
... (2026-10-11)". Before that, the
+1 since 119 is the `search-tables.spec.ts` case proving an auto-inferred search
turn (a natural-language prompt, no `/name`) has its prose suppressed and its
internal `skill` call hidden, because the model chose the skill itself. See
`docs/verification.md` "Skills are auto-inferred from their descriptions ...
(2026-10-11)". Before that, the
+1 since 118 is the `chat-transcript-scroll.spec.ts` case proving the search
table is not rebuilt on later repaints (so the transcript stays at its bottom,
instead of jumping to the table's top). The
+2 since 116 is the `ask-user.spec.ts` work proving the composer's cancel on a
pending question dismisses it as a "no answer" without ending the turn (no
"Session stopped" notice) - one case on the first question, one after several
"Load more" clicks to rule out a state desync; the same change's
`search-tables.spec.ts` case gained an assertion that the total line sits below
the table. See
`docs/verification.md` "Chat panel: cancel means \"no answer\", the cross600
cancel icon, and the total line under the table (2026-10-11)". The
+1 since 115 is the `chat-transcript-scroll.spec.ts` case proving a tool-call
billet as the newest entry is followed to its bottom (and its expansion too):
the follow rule covers every transcript entry, not only an assistant message —
see `docs/verification.md` "The follow rule covers tool-call billets too
(2026-10-09)". The
deterministic-search-tables work added `tests/e2e/search-tables.spec.ts` (2
cases), one ask-user `actions` case, and rewrote `step08-query-results.spec.ts`
to the `aem_query` billet + `format_table` message flow (still 5 cases) — see
`docs/verification.md` "Deterministic search tables ... (2026-10-09)". The 6
failures are **pre-existing and environment-bound**: `settings-tabs.spec.ts:30`
and four `network-error.spec.ts` cases reproduce identically on a clean
HEAD (the browser-pane hosts panel / network banner), and
`chat-transcript-scroll.spec.ts` is the documented load-correlated flake (green
in isolation). The new specs and the ask-user case are green. (The previously
documented `settings-tabs.spec.ts:121` note below is stale.) The older baseline
narrative follows: the
+1 since 107 is `home-screen.spec.ts`, proving the welcome screen's close control
sits on the identical screen position a panel's close control does, so opening
and closing Settings over the home screen does not move it — see
`docs/verification.md` "Home is a veil, not a page (2026-10-08)"; the
+1 since 106 is the `message-links.spec.ts` case proving a link popover does not
retarget the link above when the pointer is carried up into it, plus an offset
assertion in `skill-autocomplete.spec.ts` — see `docs/verification.md` "Every app
popover now sits flush against its trigger (2026-10-08)"; the
+1 since 105 is the `message-links.spec.ts` case proving a markdown table of long
path links wraps instead of widening the transcript — see `docs/verification.md`
"Typographic hyphens in paths, and wide link tables (2026-10-08)"; the
+1 since 104 is the `message-links.spec.ts` case proving the link popover stays
open when the pointer moves swiftly from one link to another — see
`docs/verification.md` "The link popover stays open when the pointer moves to
another link (2026-10-08)"; the
+1 since 103 is the `message-links.spec.ts` case proving a bare AEM path inside
inline code or a fenced block becomes a link too — see `docs/verification.md`
"AEM paths inside inline/fenced code are links too (2026-10-08)"; the
+1 since 102 is the `message-links.spec.ts` case proving a chat link dismisses
an open Settings panel — see `docs/verification.md` "A chat link now dismisses
an open Settings panel (2026-10-08)"; the
+2 since 100 is `tests/e2e/chat-transcript-scroll.spec.ts`, the transcript
stick-to-bottom cases against the built app — see `docs/verification.md` "The
chat transcript got stuck when a layout change looked like scrolling away
(2026-10-08)"; the
+5 since 95 is `tests/e2e/ask-user.spec.ts`, the interactive-question UI — radio
group, checkbox list, free-input swap, and both >5 dropdowns — all 5 green
against the built app; the
one deterministic failure is the pre-existing `settings-tabs.spec.ts:121`,
which fails identically on HEAD — the settings "Takes effect after restarting
the app" helper carries no trailing period while the assertion expects one; the
load-correlated flakes — `settings-color-picker` (its 1–2 px geometry), the
hosts-typing case in `settings-hosts.spec.ts`, and the documented
`loading-indicator` — are green in isolation, so a full run can show 2;
includes `message-links.spec.ts`, the assistant
message-link case, now 11 tests covering the Edit/CRX hover popover, the
`jcr:content` resource case - link/Edit trimmed to the owning page but CRX kept
on the exact resource - percent-encoding of the path in content-view URLs, the
never-focused popover buttons, the external-browser path, a chat link
dismissing an open Settings panel, a bare path inside inline code or a
fenced block, the popover staying open across a swift link-to-link move, a
markdown table of long path links wrapping rather than widening the transcript,
the popover staying on its link when the pointer is carried up into it, and
`chat-thinking-indicator.spec.ts`, now 2 tests covering the transient reasoning
billet). (The Session "Authentication"/"Models"
→ "Agents" tab merge moved the unit baseline from 1658, and later work moved it
on — see `docs/verification.md`.) **`npm run verify`** typechecks cleanly (the old red WIP file is now the
registered-but-disabled `src/tools/aem-create-page/`); it is red only on
pre-existing lint errors in
`tests/unit/main/webview/session.test.ts:12` and `tests/e2e/view-session.spec.ts`
(prefer-const).
The repository now has **commits** (HEAD `eab74e6`), so `git status`/`git log`
work again; the older "zero commits" notes are stale. One **pre-existing,
non-flaky** E2E failure remains: `aem-bridge.spec.ts` test 2 asserts an
exact bridge-reply key list that commit `9a79dae`'s optional `headers` field
invalidated — see `docs/verification.md` "Assistant message links open the AEM
pane in edit mode (2026-09-22)".
`app.spec.ts` no longer collides with a running `npm run dev`: it now
provisions a scratch storage home like every sibling spec (see
`docs/verification.md` "Settings Servers renamed to Hosts", traps). Residual E2E
flakes, all load-correlated and green in isolation:
`address-deep-link.spec.ts` (see `docs/verification.md` Step 05
closeability section), `settings-color-picker.spec.ts` (its 1–2 px geometry
assertions), `agent-token-canary.spec.ts`, `loading-indicator.spec.ts`,
and `host-proxy-selection.spec.ts` (its Settings proxy-combobox persistence).
The two
previously-*consistent* failures — `settings-hosts.spec.ts` (an
orphaned banner collapse timer detached the OK button mid-click) and
`step08-query-results.spec.ts`'s markup case (a stale `onerror=` fixture) — were
fixed on 2026-09-22; see `docs/verification.md` "Fix the three knowingly-failing
E2E tests".

`webview-preload` has its **own** build config (`electron.vite.webview-preload.config.ts`)
because it is injected into remote content and cannot share the app preload's
privileges. `npm run build` runs both. TypeScript is a **project-references
build** — one tsconfig per process (`tsconfig.main/preload/renderer/shared/agent/test.json (`agent` covers `src/agents/**`)`).

---

## 7. Rules that are enforced, not merely preferred

1. **Adobe Spectrum Web Components for all UI.** Pin `1.12.2`.
2. **An agent SDK (the Copilot SDK/CLI, or `@openrouter/agent`/`@openrouter/sdk`) is importable only from its own `src/agents/<name>/` folder.** ESLint-enforced.
3. **Everything under `src/shared` imports no Electron, no Node built-ins and
   no browser globals.** ESLint-enforced, with deliberately-failing fixtures in
   `tests/fixtures/eslint-violations/` to prove the rule is switched on.
4. **No write path to AEM.** Not "blocked" — absent.
5. **Tool returns require `resultType`.** `skipPermission: true` is forbidden.
6. **Never `innerHTML` in the transcript.**
7. **Strict TypeScript**: `exactOptionalPropertyTypes`,
   `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. An optional property must
   be *omitted*, not set to `undefined`.
8. **No agent-controlled mock switch in production.**
   `shouldUseFakeAgentService` checks `isPackaged` first.
9. **TypeScript imports** (convention, not lint-enforced). Use IntelliJ MCP
   inspections to identify and shorten imports where possible (§9). Combine
   imports from the same module path into one declaration with inline `type`
   modifiers, e.g. `import { type A, b } from '../shared';` rather than separate
   `import type` and value declarations. <!-- refined: same-path imports must be merged, including type imports -->
   Within the braces, list type names first, alphabetically, then value names,
   alphabetically; if there are more than three names, put each on its own line.
   Do not put a blank line between type and value names (Prettier removes it).
   Sort declarations with external libraries first (alphabetically by library
   name), then internal imports (alphabetically by relative path). Preserve
   side-effect-only imports and existing behavior. Tool folders under
   `src/tools/**` import shared code through the `shared` barrel
   (`'../../shared'`), not deep paths.
10. **An add-on folder is a plugin, and an add-on's own dependencies are
    add-on-only.** ESLint-enforced from data, not from a list: `src/addons/<name>/`
    may import only its own files and `src/shared`, and Electron **types** only;
    nothing outside `src/addons` may import an add-on; and every dependency an
    add-on declares in its `package.json` may be imported only inside that add-on
    (the rule reads each add-on's manifest at config load). An add-on's `tests/`
    and `e2e/` may additionally reach `tests/support`. The TypeScript project
    references say the same (the main/renderer/preload programs do not reference
    `tsconfig.addons.json`). Proof fixtures:
    `tests/fixtures/eslint-violations/addon-boundary-violation.ts` and the
    run-time case in `tests/unit/main/eslintBoundaries.test.ts`.

---

## 8. Verified API facts — do not re-derive these

**`before-input-event`'s `input.code` can be empty for a real keystroke.** Measured
live on Electron 44.3.0 / Windows: the numpad's `+` and `-` arrive as
`{ key: '+', code: '' }` / `{ key: '-', code: '' }` (and `location: 0`), and
`SendKeys`-injected letters likewise carried `code: ''`. So a key map that matches
only `code` silently misses those keys — the letter shortcuts worked because a
real keyboard *does* populate `code` for them, but the numpad's did not. The app's
`resolveShortcut` (`src/main/shortcuts.ts`) therefore matches `code` **or** `key`
(the `key` fallback is what makes `Ctrl+NumpadAdd`/`Ctrl+NumpadSubtract` work);
`sendInputEvent` synthesizes a non-empty `code`, so an E2E built on it cannot
catch this — only real OS input can.

**Skills are loaded by the app, not the SDK (supersedes "skills are not
auto-injected").** Earlier the Copilot runtime loaded skill directories and
needed exactly one built-in tool named `skill`; that path is gone. The app's own
`load_skill`/`skill_resource`/`skill_script` tools serve both agents (see
`resources/skills/` above). Proven live 2026-10-17 (Copilot, `mai-code-1.1-flash`):
the app's `load_skill` tool (argument `name`) is the one the model calls - the SDK
built-in never runs, so `overridesBuiltInTool` replaces it - and a `skill-selftest`
turn loaded the skill, read its file and ran its script, in both an explicit
`/name` turn and an inferred one (`docs/verification/followons-2026-10.md`). The
description limit still applies to the **model-facing** catalogue: keep skill
descriptions short (`docs/compatibility.md` §4.5).

**Resource paths.** `resources/` (skills, rules, icons) ships **inside**
`app.asar` (`electron-builder.yml`'s `files`), so an in-app update delivers it with
the swap; nothing else but the unpacked agent runtime is left outside the archive.
The store reads it from `path.join(app.getAppPath(), "resources", "skills")` when
packaged and from `out/main/../../resources/skills` when not
(`resolveBundledResourcesDirectory`). Measured on Electron 44: `readdir` with
`withFileTypes`, `lstat` (with real sizes), `readFile`, `realpath` and
`nativeImage.createFromPath` all work against paths inside an asar, so the skill
store's real-path containment still fails closed for a missing file.

**`BrokerOutcome`** is `{ kind: "response", status, contentType, bodyText }` —
not `kind: "ok"`, and the body is **not** parsed for you.

**Envelope common fields**: `requestId, chatId, turnId, serverId,
serverRevision, navigationEpoch, deadlineMs` — `deadlineMs`, not
`issuedAt`/`deadlineAt`.

**QueryBuilder.** `aem_query` sends a numeric `p.guessTotal=TOTAL_GUESS_CAP`
(100), not `p.guessTotal=true`. With a numeric cap: below the cap QueryBuilder
enumerates everything and the reported `total` is **exact**; at or above it,
`total` is the cap and `more` is `true`. Crucially, with a numeric guess **`more`
means "there are more matches than `total`"**, not "there is a page after this
one" - so a 43-match result reports `total: 43, more: false` and still has further
pages. `readQueryEnvelope` (`src/shared/tools/core/queryBuilder.ts`) therefore
derives `hasMore` (`offset + returned < total` when `more` is `false`) and
classifies the total `exact` / `atLeast` / `unknown`. `p.properties` is
**space**-separated. `group.p.or`-style keys round-trip because the builder never
inspects key shape. **HTTP 200 + valid JSON + `success: false` means the query was
rejected, not that it matched nothing**; a *missing* `success` flag is treated as
rejection. *(Documented, not yet verified against a real AEM here - see
`docs/compatibility.md` §11.0.)*

**HTTP 414** maps to `url_too_long` — an explicit error, never a reason to
switch to POST.

**`URLSearchParams`** substitutes U+FFFD for a lone surrogate rather than
throwing.

**`app.evaluate()`** in Playwright runs inside the Electron main process; that
is how E2E drives the fake transport.

**`messageStream`** marks dirty only when the rendered text actually changes.

**A dispatcher's `connect.lookup` is what pins an address (by type and unit test 2026-10-25).**
`undici`'s `Agent({ connect: { lookup } })` passes `lookup` through to `net`/`tls`
`connect` (`BuildOptions` extends `TcpNetConnectOpts`), so the only DNS answer the socket
can see is the one that function returns; the URL's host still supplies the Host header
and TLS servername. `Node`'s global `fetch` accepts the dispatcher as an (undocumented in
DOM types) `RequestInit.dispatcher`. A proxy dispatcher, by contrast, resolves the name
itself - which is why the app's own address check cannot pin a proxied request. The
pinning is proved by unit test (`createPinnedLookup`'s answers, and the dispatcher
receiving the validated list); no socket was opened to measure the connect address end to
end.

### The one contract change since Step 03

`paginationMetadataSchema` in `toolResult.ts` (now `src/tools/aem-query/aemQuery.ts`) had no total
and no accuracy indicator, which Step 08 mandates. It gained:

```ts
totalMatchesSchema =
  | { accuracy: "exact";     value: number }
  | { accuracy: "estimated"; value: number }
  | { accuracy: "unknown" }
```

A discriminated union rather than `total: number` + `totalIsEstimate: boolean`,
because the two-field form permits impossible states.

---

## 9. How work is verified here

A green test suite is **not** evidence. Three habits found every real defect so
far; keep them.

### Writing tests: the rules

These came out of the 2026-10-16 test-suite review (`docs/verification/followons-2026-10.md`
"Test suite: no literal-certifying tests, test-id hooks, shared helpers"). They
bind every new or edited test.

**1. Do not certify production-owned literals.** A test must not assert that
"Lorem ipsum" renders as "Lorem ipsum". Help texts, labels, placeholders, banner
and error copy, tooltips, CSS class names, icon tags, default values, model-facing
prose and re-typed constants may be reworded or changed freely; a test that pins
their exact value fails for no reason and makes routine copy edits expensive.
Instead:

- assert **behaviour and state** (the banner appears, the button is disabled, the
  row is removed, the value was persisted), not the words;
- when the text itself must be referenced, **import the exported constant**
  (`STORAGE_KEY`, `ATTENTION_CLASS`, ...) rather than re-typing it - and if none
  is exported, export one from `src/` in the same change;
- a test that only restates a constant, a static map, a class list or a markup
  snapshot of the code under test is **deleted, not written**;
- keep exact values **only where they are a contract**: error codes, tool and IPC
  names, fixture echoes (what the test itself fed in), computed output, security
  checks (escaping, origin guards, no `innerHTML`), the "banner copy never ends
  with a period" invariant, and the exact enabled/disabled tool sets.

Before asserting a string, ask: *if the owner rewords this tomorrow, should this
test fail?* If not, do not assert it.

**2. Locate elements by test id, not by copy, title, aria-label or class.**
Production *controls* (buttons, toggles, inputs), whole-size *panels*, repeated
*rows* and *dynamic* elements (`settings-tab-<value>`, `host-color-swatch-<c>`)
carry `data-testid="<kebab-id>"`; Settings fields carry `data-field="<id>"`.
Tests use `byTestId` / `byField` from `tests/support/selectors.ts`.
`[title=]`, `[aria-label=]` and text locators are not allowed in new tests. A
hook is **not** added to a plain structural wrapper (a region, list, section or
slot root): such a root is found by its own structural class or element tag
(`.browser-view-host`, `.hosts-section`, `sp-split-view`), which the layout and
CSS already depend on. A control a test needs but lacks a hook for gets one **in
the same change** - an additive, behaviour-free attribute; say so in the
handoff. Playwright specs must not import from `src/renderer`.

**3. Look for an existing helper before writing one.** Search `tests/support/`
(and `tests/support/e2e/`) first - by name and by body - before adding any
setup, teardown, fixture builder, wait, fake or locator helper to a test file:

- unit: `jsdomGlobals`, `memoryStorage`, `scratchDirs`, `asyncWaits`,
  `configFixtures`, `aemQueryEnvelope`, `fakeBridgeTransport`, `fakeAemFixtures`,
  `fakeBrowserSide`, `fakeAgent`, `testClock`, `testIds`, `toolUnions`,
  `agentDefinitions`, `ruleResources`, `ipcHandlerHarness`;
- E2E: `env` (scratch environment), `profile` (settings/profile writing), `app`
  (launch/close), `composer` (wait-ready, send), `fakeAgent`.

If one nearly fits, **extend it** rather than writing a variant. When the same
block appears in a second test file, move it to `tests/support/` in that change
(a third copy is never acceptable). A helper stays local only when it is
genuinely specific to that spec - e.g. each `makeHost` builds a different
`ToolHost` - and says why in a short comment. A new support module gets a
single clear name for a single job; do not create a `utils.ts` catch-all.

**4. Specs are named for the feature, never for a plan step.** E2E files are
`<feature>.spec.ts` (`aem-bridge`, `agent-chat`, `network-error`), not
`stepNN-*`. When renaming a spec, `git mv` it and update live references
(AGENTS.md, current docs, comments); dated evidence in `docs/verification/` keeps
the name the spec had when it ran. Legacy `step04`/`step08`/`step09` names stay
until someone renames them deliberately.

**5. No arbitrary sleeps; wait on a condition.** Use `asyncWaits` / Playwright
`expect(...).toPass()` / `waitFor` on an observable state. `waitForTimeout` is
tolerated only as the back-off inside a polling loop. Do not assert on a "last"
element of a *shared* app (`.last()` after a send) without first capturing the
count before the action - a stale element passes or fails by accident.

**6. Make failures informative and tests independent.** Prefer a specific
matcher to a bare `toThrow()` / `toBeDefined()` / `toBeTruthy()`; assert the error
code or the one property that matters. Avoid `as unknown as` to force a fixture
through the type system - build a correctly-typed fixture through the shared
helpers instead. A test creates its own scratch directory/profile and cleans it
up; it never depends on another test's leftovers or on `npm run dev` being
absent. One test, one behaviour.

**7. Test files stay reviewable.** A test file approaching ~1400 lines is split
by behaviour (the backlog lists the current offenders: `browserToolbar`,
`agentChatController`, `transcriptView`, `sdkAgentService`, `settingsStore`,
`chatPane`, `browserController`, `ipc/settings`); do not push a file further past
that, and split a file you are already making substantially larger.

**8. Prove a new test discriminates.** After writing a test, break the production
behaviour it guards (a realistic mutation), see it fail for the right reason,
restore, and see it pass - and for a UI change, run the built-app Playwright case
(`npm run build` first; E2E runs against `out/`). A test that cannot fail is
removed.

**9. Report the cost of the change.** When a task adds a hook, exports a
constant, changes a contract, or deletes a test, say so in the handoff and in the
evidence log. Do not delete a test silently and do not weaken an assertion
without recording why. The baseline in §6 is updated only from a measured run.

**`get_file_problems` before the gate.** After editing any project file, run the
`get_file_problems` tool from the intellij MCP on that file and amend until it
reports zero problems — *before* Prettier/ESLint/`npm run verify`. Fix
pre-existing problems the tool flags on the same file too (boy-scout principle);
but if the flag seems wrong or contradicts the file's intent, **escalate to the
user** for a decision rather than change code to silence the analyzer. IntelliJ
analysis is near-instant and needs no toolchain startup, so it is the cheapest
first gate and catches type errors and inspections the CLI linters miss. Fix
them there; then format, then run the verify gate.

**This is mandatory before every handoff.** Before reporting work as done (and
before `task_complete`), run the IntelliJ check (`lint_files` /
`get_file_problems`) on **every file you created or modified** - source, tests
and support files - and fix **all** reported problems, including warnings such as
"import can be shortened" and deprecated-API notices. Do not skip a warning
because tsc/ESLint/`npm run verify` is green; they check different things. Pass
`projectPath` (the repo root) on every call, batch at most ~10 files, and
re-run after a few seconds if a fresh disk write may not be indexed yet. The
only acceptable leftovers are warnings that are intentional (e.g. deliberate
XSS payload fixtures) or that contradict the file's intent; list each one
explicitly in the handoff and escalate the doubtful ones to the user instead of
silently ignoring them.

**Mutation testing proves tests discriminate.** Inject a realistic defect into
shipped source, run the suite, record which test catches it, restore, re-run.
Step 08 ran 20 mutations across three batteries; all 20 were caught. Reusable
harnesses: `step08*-mutations.cjs` in the session artifacts directory.

**Launching the real built app proves the unit suite isn't lying.** The Step 08
E2E passed in 1.9 s — implausibly fast — so the `sp-table.js` import was removed
from `main.ts`, the app **rebuilt**, and the spec re-run: 4 of 5 failed. *That*
established the E2E was real. Relatedly: **jsdom cannot prove a custom element is
registered** — it renders an unknown tag as `HTMLUnknownElement`, so a unit test
passes against a missing import. Assert `customElements.get(...)` and a real
`shadowRoot` in an E2E instead.

**Live scenarios prove behaviour against the real world.** For anything fakes
cannot show (a real model choosing a skill, a real host), write a
`*.live.spec.ts` using `tests/support/live/` (`launchLiveApp`,
`startFreshConversation`/`sendAndWait`, `journal` queries, `liveAssertions`,
`attachEvidence`). Assert on the journal (tool calls, results, errors), never on
model prose. Evidence (redacted journal copy, `summary.json`, `transcript.md`)
lands in `test-results/live/`. Keep prompts tiny, never write real settings,
never delete chats you did not create (`LIVE_CLEANUP=1` removes only the run's
own). The pure parts (journal reader, redaction, transcript) are unit-tested in
`tests/unit/support/live/`. `tests/live/skills.live.spec.ts` is the worked
example (the `skill-selftest` user skill, explicit and inferred);
`tests/live/memos.live.spec.ts` certifies `/remember` writes a generic memo and
removes only the file it created.

**A live RPC read is the proof for anything the model could fake.** Ask the
model about a skill and it will invent the contents. `skills.list()` cannot.

**A local dev trigger can preview UI, but never replaces the round-trip test.**
Typing `!!ask ...` into the composer paints the ask-user UI locally - no model,
no AEM, no IPC - gated by `window.daisy.devTools` (set only in an unpackaged
build; see `src/main/windows.ts`). All of its logic lives in
`src/renderer/src/dev/` (see §5); the pane only wires its factory. It is for fast
look-and-feel iteration. It deliberately does **not** exercise the answer round
trip, so the fake-backed `tests/e2e/ask-user.spec.ts` is what proves the plumbing.
A preview that looks perfect while the answer goes nowhere is exactly the false
confidence this section exists to prevent.

Record every step's evidence in the current archive under `docs/verification/`
(indexed by `docs/verification.md`): what was executed, the actual numbers, and
what would have been missed without it.

---

## 10. Environment traps

- **IntelliJ flags ```` ```ts ```` fences in `.md` as JS.** AGENTS.md §8's
  `totalMatchesSchema` union snippet reports "expression/statement expected" at
  the `| { ... }` alternators. Known false positive — decided to leave as-is;
  do not "fix" the doc snippet.
- **PowerShell has no heredoc.** `Add-Content` / `Set-Content -Encoding UTF8`
  writes a BOM that Prettier then rewrites — run `npx prettier --write` on any
  file you append to.
- `Select-Object -First N` kills the upstream pipeline.
- **vitest 5 removed `--reporter=basic`.** Parse `Tests  N failed` and
  `FAIL  path > name` from default output. In a harness,
  `execFileSync("npx.cmd", …)` gave an unparseable baseline;
  `execSync("npx vitest run … 2>&1")` works.
- `vi.fn(() => …)` with no declared parameters makes `mock.lastCall` a `[]`
  tuple, so `lastCall?.[0]` is a TS2493 error. Declare the parameters.
- ESLint `@typescript-eslint/unbound-method` rejects passing `path.join` as a
  value; wrap it: `(...segments) => path.join(...segments)`.
- The Copilot client needs Electron's `app`, so a plain-node probe must stub
  `app.isPackaged` / `app.getPath`. Everything else in the client path is
  ordinary Node.
- Windows paths, backslashes.

Toolchain: Electron 44.9.3, TypeScript 6.0.3, vitest 5.0.5, Playwright 1.63.0,
zod 4.6.7, `@github/copilot-sdk` 1.0.13, `@github/copilot` 1.0.83. (Read from
`package.json`; the review of commit `3bd1ad8` noted the mixed dependency bump that
moved these.)

---

## 11. Known open items

Deferred, consciously-put-off work lives in `docs/backlog.md` (kept out of this
file).

| Item | State |
| --- | --- |
| Step 07 manual smoke checklist | **Written, never run by a human.** Needs real Copilot + real AEM. |
| Two Copilot clients | **Design fixed.** `src/agents/copilot/runtimeManager.ts` owns one `CopilotClient` for auth and chat (`replaceDelegate`), replacing `ipc/agent.ts`'s separate `cachedClient`; fake mode answers auth from the fake, so it spawns no runtime at all. The **real-path process count is still unmeasured** — measure before Step 10's shutdown work. Plan: `docs/backlog.md` "Real-path Copilot runtime process count and quit cleanup". |
| `before-quit` / `will-quit` cleanup | Not implemented; Step 10 scope. No leak measured either way — tracked in `docs/backlog.md` (same entry). |
| U10 residual gap | No preload fetch has been driven through a proxy or a certificate exception. Step 12 territory — see `docs/backlog.md` "Milestones B and C". |
| Host `proxyId` | **Applied (2026-09-21).** The active agent's proxy configures the Copilot runtime and sign-in; a host's three-way `proxyId` selection (Default/No proxy/entry) and the `browser.proxy` default are applied to the live browser session, reconciled per navigation origin (`src/main/browser/proxyReconciliation.ts` + `src/main/webview/proxyResolution.ts`). |
| `address-deep-link` E2E flake | Rare (≈1 of 6), load-correlated: post-fix run 5 failed the final "settings.json gains `unconfigured.example`" assertion; 5 full-suite greens since and isolated repeats never red. Root cause not split (OK-click vs `settings:add-server`); the assertion now dumps banner/open/address/on-disk context on failure so one recurrence pins it. See `docs/verification.md` Step 05 closeability section. |
| `settings-tabs.spec.ts:121` E2E failure | **Pre-existing, deterministic** (reproduced on HEAD with the work stashed, 2026-10-06): the spec locates `section[aria-label="Browser"]`, which is the browser *pane* (the settings Browser section is a `div`), and expects `Takes effect after restarting the app.` while the pane's helper text has no trailing period. Not caused by the environment-facts work; needs a spec/element fix in its own change. |
| Add-ons and the Copilot CLI | **Owner-pending.** The add-on download path is proven in the built app (`addon-download.spec.ts`, 9/9), and the Copilot resolver is unit-tested end to end (discovery, digest, extraction, cache, ladder); but no real Lighthouse audit has run from the installed add-on, and no interactive Copilot sign-in has run against a **resolved** CLI on a clean profile - the old `copilot-cli` add-on's copy-out was never exercised either. The publish workflow was never run. Mac payloads and Mac CLI resolution unrun. See `docs/addon-architecture.md`, `docs/backlog.md` "Add-ons". |
| Git | Has commits. The plugin refactors (tools, agents) were left uncommitted for the owner to review. |

---

## 12. Working agreement

- **Ambiguity goes back to the user.** The plan says it explicitly: a question
  these documents and the verified APIs cannot answer must not be resolved by a
  guess. Ask.
- **A new tool is not finished until its `getDetails()` is designed.** Every
  tool needs a deliberate transcript-details composition (`describeToolCall` in
  `src/renderer/src/chat/toolCallDetails.ts`), never the generic
  argument-dump fallback. **When an agent adds a tool, it must ask the user**
  which arguments to expose and how the collapsed summary and expanded rows
  should read, before writing the composition. See §5.
- **No handoff without a clean IntelliJ check.** Run it on every touched file
  and fix every problem first (§9); report any deliberately-left warning.
- **One step at a time.** Prove each step's success criteria by execution before
  starting the next. Do not mark several future steps complete on impression.
- **Keep the plan bookkeeping current as you go**, not at the end.
- **Report deviations loudly** — especially any change under
  `src/shared/contracts/`, any new dependency, and any place you had to
  implement something differently from the plan.
