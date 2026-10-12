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

| File | What it is | How to treat it |
| --- | --- | --- |
| `docs/implementation-plan.md` | The **contract**. 12 numbered steps, each with explicit success criteria. | **Read-only.** Never edit. Never mark several steps done on a general impression. |
| `docs/requirements-decisions.md` | The reasoning and agreed decisions behind the plan. | Read when a plan bullet seems arbitrary — the justification is here. |
| `docs/compatibility.md` | Verified-API fact table (**U1–U12**, ~lines 801–810) plus SDK behaviour notes. | **Authoritative.** If it says an API behaves a certain way, that was proven by running it. Don't re-test; don't contradict it from intuition. |
| `docs/verification.md` | The **evidence log**, one section per completed step. | Append a section per step. Record what was *executed*, not what was written. |
| `docs/agent-plugin-architecture.md` | Why agents are plugins (`src/agents/<name>/`), the contract, isolation table, add/disable/remove recipes, known limits. | Read before adding, removing or restructuring an agent/SDK. |
| `docs/tool-plugin-architecture.md` | Same for tools (`src/tools/<name>/`). | Read before adding or removing a tool. |
| `docs/backlog.md` | Deferred, deliberately-put-off work — features and fixes recorded as *not yet done*, each self-contained. | Read before starting anything that sounds like a "later" idea; append an entry when you consciously defer one. |

---

## 3. Where the project stands

**Steps 00–08 complete and verified. Steps 09–12 remain.**

- 09 — genuine history, models, origin changes
- 10 — UX, deletion, failure handling
- 11 — NSIS installer, mock-AEM acceptance (**Milestone B**)
- 12 — real AEM verification (**Milestone C**, needs an authorized environment)

Milestone A (steps 00–07) is functionally complete, **except that the 15-row
manual smoke checklist at the end of `docs/verification.md` has never been run
by a human.** It needs a real Copilot sign-in and a real AEM instance.

**The repository has commits** (`git log`/`git diff` work), but the agent- and
tool-plugin refactors may still be uncommitted in the working tree. **Do not
commit unless the user asks.**

---

## 4. Architecture and process boundaries

```
┌─────────────────────────── Electron main ────────────────────────────┐
│  src/main/                                                           │
│    index.ts ............ composition root (wires everything)         │
│    browser/ ............ the AEM pane, navigation, origin switching  │
│    aem/ ................ URL building, response validation, broker   │
│    ipc/ ................ typed IPC handlers, sender guards           │
│    settingsStore / secretStore / logger / appPaths                   │
│                                                                      │
│  src/agents/<name>/  ← agent plugins; the ONLY place an SDK is imported│
│    copilot/: meta · agent · runtime · sdkAgentService · toolPolicy … │
│  (discovered by src/main/agents/registry.ts, run by agents/hub.ts)   │
└──────────┬───────────────────────────────────┬───────────────────────┘
           │ typed IPC                         │ stdio
┌──────────┴───────────┐            ┌──────────┴─────────────────────┐
│ src/preload/         │            │  copilot-runtime.exe (bundled) │
│  app-preload ........ chat + settings bridge                        │
│  aem-preload ........ runs INSIDE the AEM page; the private fetch   │
│  bridgeFetch ........ the actual authenticated read                 │
└──────────┬───────────┘            └────────────────────────────────┘
           │
┌──────────┴──────────────────────────────────────────────────────────┐
│ src/renderer/  — Adobe Spectrum Web Components only                  │
│    shell/ ........ two-pane layout, toolbars, panes                  │
│    chat/ ......... transcript, composer, markdown, query table       │
│    settings/ ..... settings panel sections (servers, proxy, models)  │
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
  → src/main/aem/bridgeBroker.ts  policy, deadlines, navigation-epoch checks
  → src/main/aem/bridgeTransport.ts  IPC to the AEM pane
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
| `contracts/serverConfig.ts` | An AEM server entry (id, label, colour, address, revision) |
| `contracts/appSettings.ts` | The persisted settings document — **no `schemaVersion`** (see §7) |
| `contracts/settingsSnapshot.ts` | The redacted snapshot the renderer is allowed to see |
| `contracts/chatMetadata.ts` | Chat list entries (title, date, server, selection) |
| *(moved)* | Tool argument/result schemas, `paginationMetadataSchema`, `totalMatchesSchema`, `renderTotal()` now live with their tool: `src/tools/<name>/<name>.ts`; the plugin contract is `src/shared/tools/core/` |
| `contracts/agentEvents.ts` | The normalized event stream the renderer consumes |
| `contracts/sessionState.ts` | Session/turn state machines |
| `contracts/aemBridge.ts` | The preload↔main bridge envelope |

Non-contract shared files: `result.ts` (the `Result` type), `ipc-channels.ts`,
and the per-surface IPC type files (`agent-chat-ipc.ts`, `browser-ipc.ts`,
`settings-ipc.ts`, `app-api.ts`, `agent-auth.ts`).

> **Treat Step 03 contracts as frozen.** A few have been changed since —
> `toolResult.ts` (§8), `sessionState.ts` (the `sending -> runningTool`
> transition, because the SDK can make a tool call a turn's first event), the
> settings contracts `appSettings.ts` /
> `settingsSnapshot.ts` (the latter gained the `browser` object with
> `disableNativeWebAuthn`, the Settings "Browser" tab's WebAuthn-suppression
> flag), and `settings-ipc.ts`. `userInput.ts` gained an optional
> `actions` list (1–4 one-click labels) and made `question` optional — the
> `ask_user` actions mode (see §5 tools). Most recently `contracts/agentEvents.ts`
> gained a sixteenth variant, `tool.call.progress` (a transient, never-journaled
> progress note for one in-flight tool call), with the optional
> `ToolHost.reportToolProgress` capability that emits it — the spinner + live
> "Reading n of m" on a long semantic search — see `docs/verification.md`
> "Semantic search: a live progress line, concrete node paths, and a 20-hit page
> (2026-10-12)". Before that `contracts/modelCatalog.ts`
> lost `changesLocked` and `settings-ipc.ts` lost `turn_in_flight`, when Step
> 09's "disable changes during an active turn" lock was replaced by "apply the
> change on the next turn" — see `docs/verification.md` "Settings changes apply
> on the next turn (2026-10-09)". **There is deliberately no `schemaVersion` field and no
> migration code anywhere**: the project has no deployed users and no
> backward-compatibility obligation, so the persisted shape may change freely.
> Do not add a version field or a migration. Loading a hand-edited
> `settings.json` stays forgiving — missing fields default, unknown keys are
> stripped, unusable entries are dropped — but that lives only in
> `normalizeSettingsDocument` in `src/main/settingsStore.ts`; the contract
> schemas themselves stay `.strict()`. If you must change another contract, say
> so explicitly and search for the blast radius **outside `tests/unit`** too.

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
  integration tests `proxy-login`, `agent-runtime`, `packaged-skill`,
  `proxy-runtime`, `live-github-auth`, `support/syntheticLogin.ts`.
- Not lint-enforced but load-bearing: the eager `meta.ts` glob (main + renderer)
  and the lazy `agent.ts` glob (main) both need the folder to match
  `src/agents/*/`; `agent.id` must equal an enabled `meta.id` (otherwise the
  registry reports it and skips the agent; duplicates likewise). The persisted settings shape per agent is the shared
  `agentSettingsSchema` (`active`, `proxy`, `model`, `reasoningEffort`,
  `token`); an agent that needs other settings would have to extend that shared
  contract - **say so and ask**.
- **Diagnostics contract (every agent, incl. a future Claude).** Journal-only
  `model.changed` / `model.usage` / `model.call.failed` events. An adapter
  reports its model through `createModelObserver`
  (`src/shared/agents/modelObserver.ts`) in `sendPrompt` and must pass
  `describeAgentDiagnosticsConformance`
  (`tests/support/agentDiagnosticsConformance.ts`) via its own harness. Semantics
  are documented in `src/shared/contracts/agentEvents.ts`.
- Copilot's files: `copilotClient.ts` (`createHardenedCopilotClient`),
  `runtimePaths.ts` (+ `findProjectRoot`), `copilotHome.ts`, `toolPolicy.ts`
  (**the hardening core**), `aemToolPolicy.ts`, `sdkAgentService.ts`, `auth.ts`,
  `authPresence.ts` (cheap non-starting `getAuthPresence` from `config.json`),
  `modelCatalog.ts`, `runtimeManager.ts`, `runtime.ts`.
- OpenRouter's files: `client.ts` (the only place the SDK is constructed; pins
  `serverURL` and injects a proxy `fetcher`), `toolMapping.ts` (toolkit JSON
  Schema → SDK tools), `agentService.ts` (event mapping, SDK-free),
  `skill.ts` (the app-owned `skill` tool), `modelCatalog.ts`, `auth.ts`,
  `runtime.ts`, `types.ts`. It is token-only: `meta.supportsInteractiveLogin`
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
   starting an inactive provider's runtime). Get proxy/token from
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
   `instructions`, `bundledSkillDirectories`) onto the SDK. `allowlistEntries`
   are in Copilot's `custom:<name>` form; translate if the SDK differs. **Do not
   import `src/tools` or `src/main`** — everything arrives through the host.
6. **Hardening is per-agent.** Copilot's `toolPolicy.ts` denies every built-in
   tool except the AEM tools and `skill`; a new SDK must get an equivalent
   deny-by-default policy (and equivalent verification, cf. AGENTS.md §8 skill
   facts) *before* it may see a tool. Read-only against AEM stays absolute (§7.4).
7. Keep all SDK-specific paths robust to **code-splitting**: agent code lives in
   `out/main/chunks/`, so never derive a root from `__dirname` depth (use
   `findProjectRoot` from `src/agents/copilot/runtimePaths.ts` as the pattern —
   copy, don't import).
8. Dependencies: add the SDK to `package.json`; if it ships a native runtime, add
   its `electron-builder.yml` filters/`asarUnpack` (see Copilot's).
9. Tests in `tests/unit/agents/<name>/`. The fake E2E path needs **nothing**: with
   the fake enabled the hub gives *every* discovered definition a fake runtime.
   Do check that `tests/unit/main/agents/registry.test.ts` / `hub.test.ts` still
   pass, run `npm run typecheck`, `npm run build`, launch the built app, and run
   the Playwright suite. If SDK is Node-heavy, verify the packaged/`out/`
   layout in real (non-fake) mode — unit tests cannot see chunk-path bugs.
10. Record evidence in `docs/verification.md`; update this section and
    `docs/agent-plugin-architecture.md`.

**Disable temporarily:** `disabled: true` in `meta.ts` (agent.ts is never
loaded). **Remove:** see "Removing an agent" above. With one agent left the
active agent falls back to the first definition; with none the chat pane says
"No agent available".

### `src/main/`

`index.ts` is the composition root — read it first to see how the pieces meet.
`agentComposition.ts` holds the wiring helpers (`createBrokeredExecute`,
`createBrokeredQueryExecute`, `resolveBundledSkillsDirectory`,
`startAppRuntime`, `exposeFakeAgentServiceForTests`).

`main/aem/` splits deliberately: `resourceUrl.ts` and `queryUrl.ts` build URLs,
`responseValidation.ts` classifies HTTP responses, `queryResponse.ts` reads
QueryBuilder semantics, `getJsonProjection.ts` / `queryProjection.ts` shrink
results, `aemGetJson.ts` / `aemQuery.ts` orchestrate, `bridgeBroker.ts` +
`bridgeTransport.ts` carry it across the boundary. `proxyPolicy.ts`,
`proxyAuth.ts`, `certificateExceptions.ts` and `session.ts` handle network
scoping.

`main/browser/` owns the AEM pane: `browserController.ts` (the state machine),
`navigationEpoch.ts` (**how a late result from a previous page is rejected** —
central to correctness), `serverSwitch.ts`, `certificatePrompt.ts`,
`urlPolicy.ts` + `windowOpenPolicy.ts` + `windowOpenRouter.ts` (http(s)-only URL
policy; new-window requests classified as popups - `window.open` with window
features, left as real windows for SSO - vs tabs, loaded in the same view),
`viewBounds.ts`.

### `src/renderer/`

**Adobe Spectrum Web Components for all UI** —
<https://opensource.adobe.com/spectrum-web-components/>. Twenty packages, all
pinned to `1.12.2` (including `alert-banner`, which renders the browser pane's
status/message row); add new ones at that same version. Elements are registered
by side-effect import in `src/renderer/src/main.ts`.

`chat/` separates view-model from view on purpose: `transcriptViewModel.ts`,
`composerViewModel.ts` and the query tool's `queryResultViewModel.ts` (now in
`src/tools/aem-query/renderer/`) are pure and heavily tested; `transcriptView.ts` and `composer.ts` only render. `renderMarkdown.ts`
goes through `marked` + `DOMPurify`. **Never set a cell or message with
`innerHTML`** — the transcript uses `textContent`, and there are mutation tests
guarding that.

**At most one "unfinished process" indicator is on screen.** A running tool-call
billet supersedes the transient "Thinking" item (`transcriptStore.ts`'s
`thinkingVisible` requires no running tool call), and while the turn is blocked
on an `ask_user` question the *running billet* is hidden too — `transcriptView.ts`'s
`hiddenWhileAwaitingInput`, which reads `TranscriptStore.isAwaitingUserInput()` and
skips only ordinary billets, so a question
(`presentation: 'conversation'`) and a `format_table` result (`'message'`) stay
visible. A running billet's progress line is written in place (the billet is
rebuilt only when its non-progress content changes), so a spinner never restarts
on a tick. A transcript rebuilt from the journal settles every still-running call
(`TranscriptStore.abandonRunningToolCalls`, called by `journalReplay.ts`), so a
call the journal never resolved — the app closed mid-turn — shows `Interrupted`
with the static icon, never a spinner that can never stop.

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
can never select. Keep new dev-only modules here rather than mixing them into
`chat/`/`shell/`. These modules are intentionally **untested** — they exist to
exercise other code, and testing the test tooling is redundant (their behaviour
is covered end-to-end by the real features' specs).

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
  `createToolExecutor` (that builder requires a live AEM server), and it renders
  as a conversation rather than a billet: its renderer sets
  `presentation: 'conversation'` and supplies `readConversation`, so the
  transcript paints the question as an assistant message and the answer as a
  user message. It also has an **actions** mode (`actions`: 1–4 button labels,
  mutually exclusive with `options`/`freeInput`): the composer shows one button
  per action (no text field, no Send) and a single click answers immediately -
  the search skills use one, `["Load more"]`, with the composer's Stop as the
  cancel. An actions-only call has no `question`, so the transcript paints
  nothing for it. The SDK has a built-in `ask_user`; this app leaves it
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
- `format_table` is the **only** table renderer, and it is **internal**
  (`InternalToolModule`: `internal: true`, no descriptor/allowlist/instructions):
  the registry keeps it out of the
  model's handlers, descriptors, allowlist and instructions (it is listed in
  `ToolRegistry.internalNames`), but the composites still reach it through
  `invokeTool`. It takes `data` (an array of rows, or an object with a `rows`
  array - typically the whole `aem_query` result), `mode: 'new' | 'append'` and
  an optional `totalLine` that replaces the derived total text. Its
  renderer sets `presentation: 'message'` + `readTableMessage`, so the transcript
  paints an assistant message - a `#`-prefixed Spectrum table with the total
  line beneath it (only the total line when the run has no rows), the Path cell clickable, every cell via
  `textContent` - instead of a billet. `transcriptView.ts` groups
  `format_table` calls into **runs** (new starts one, append adds to it), unions
  the columns, and paints one table at the run's last call; the call lines are
  hidden. `getDetails()` is the safety net only: `N rows` / `Rows: N`.
- `environment_facts` reports **every configured host** as a label, an origin and
  its effective content/component roots, flagging the one the browser pane is
  currently on. It takes no arguments: the application resolves the facts from
  the settings document and the live pane URL, through
  `ToolHost.configuredHosts` / `ToolHost.environmentFacts` — never from model
  input. Its success payload is structured, so its renderer can read it:
  `describeCall` receives the succeeded result as a second argument, letting this
  zero-argument tool summarise the call with the current host's URL and show the
  hosts as collapsible rows. It deliberately carries no `aem_` prefix: "environment
  facts" is a question any environment could answer (see the naming rule below). A
  host's roots live on `ServerConfig` as optional free text (`contentRoots`/
  `componentRoots`); `src/shared/tools/core/environment.ts` owns the one
  interpretation of that text (comma-or-semicolon split, comma wins, trimming, the
  `/content`/`/apps` defaults) and the nesting-aware `effectiveRoots`, shared
  by the tool, the per-turn context block and `aem_query`'s `roots` fan-out.
- `browser_navigate` opens a page in the browser pane. It takes a host **label**
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
  It is hand-rolled (like `ask_user`), so it works with no active server when the
  host is named explicitly. No `aem_` prefix: navigating a browser pane is not
  AEM-specific.
- **Tool names: `aem_` only for AEM-specific actions.** A tool takes the `aem_`
  prefix only when the action itself has no equivalent outside AEM — `aem_query`
  (AEM's QueryBuilder), `aem_get_json` (AEM's Sling/JSON rendering),
  `aem_create_page` (`cq:Page`). A generic action takes no prefix —
  `environment_facts`, `browser_navigate`, `ask_user`, `format_table`.
- **The search page size is one constant**: `SEARCH_PAGE_SIZE` (20) in
  `src/shared/tools/core/search.ts` is the default `limit` of both search
  composites; change it there.
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
  host content roots, skipped when the predicates carry their own `path` —
  `properties`, and `limit`, default `SEARCH_PAGE_SIZE`) it runs `aem_query`, shows the page with `format_table` (`new`, then
  `append`), and while `hasMore` is not `false` offers `ask_user`
  `{ actions: ["Load more"] }`, looping on each click. The model gets only a
  short summary (`textResultForLlm`), never the rows to relay — the point is
  that weak models no longer have to copy JSON between tools. Its billet reads
  `Search: <terms or predicates>` with rows Terms or Predicates, Roots, Page size,
  then Pages, Rows, Total.
- `aem_semantic_search` is the second composite, and the first **stateful**
  one: the model must judge, so the tool runs in two kinds of call keyed by a
  `searchId` (state held in the executor's closure, at most 8 searches).
  Call A `{ terms, context, roots?, limit? }` runs `aem_query` (via `invokeTool`)
  for one page (default `SEARCH_PAGE_SIZE`), reads **every** hit in code (QueryBuilder
  `path.self` + `fulltext` + `p.hits=full` through `host.bridge`, a pool of 4,
  falling back to the hit itself), and returns a numbered candidate list in
  `textResultForLlm`. Reading every hit is the slow part and has no transcript
  entry of its own, so while it reads the executor reports a `Reading n of m`
  note through `ToolHost.reportToolProgress` (keyed to its own
  `context.toolCallId`); the running billet shows it beside a spinner, written
  in place (the billet is rebuilt only when its non-progress content changes, so
  the spinner's animation never restarts on a tick). Call B
  `{ searchId, matches }` shows the judged matches
  with `format_table` (`new`, then `append`), always passing a `totalLine`
  that counts the **relevant** matches (`describeRelevantTotal`: "Total: N
  relevant results so far", or "Did not find any relevant results so far"; no
  "so far" once AEM is exhausted), so an empty run still shows a message, then, unless `hasMore === false`, offers
  `ask_user` `["Load more"]`: a click returns the next page's candidates, a
  cancel ends the search. The model never decides how many hits to read or when
  to stop. Each matched row's `Path` is the **concrete node** the excerpt's
  property lives on (`jcr:path` = the excerpt's `nodePath`), and `Property` is
  that property's own bare name — not the page the query matched, and not a
  relative label (the model-facing candidate list still shows the hit-relative
  label, e.g. `jcr:content/text/text`). Billet: a **start** call
  (`{ terms, context }`) is summarised by its terms alone, and its `AEM hits` row
  is the raw query total; a **continue** call (`{ searchId, matches }`) carries no
  terms of its own and, while it runs (which includes the read after Load more) or
  if it was abandoned, none to borrow from its result either - so it reads
  `judging N match(es)` with Search ID/Matched rows. Neither summary repeats the
  tool's own name: the header already reads `aem_semantic_search`, so a
  `Semantic search:` prefix printed the words twice on one line (as `aem_query`
  shows `fulltext=...`, never "Query: ..."). `describeCall` keys on the call's own
  `terms`, never its result's (a continue call's result echoes them).

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
   AEM pane). **No write path exists** (§7.4); a POST-capable tool needs an
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
    evidence in `docs/verification.md`.

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

### `resources/skills/`

Five bundled skills, each a `SKILL.md`: `search`, `semantic-search` and
`navigate` (all user-invocable — they appear in the composer's `/`
autocomplete), plus `daisy-conventions` and `query-results` (auxiliary —
`user-invocable: false`, so the runtime still loads them for the model but the
`/` menu does not list them; see `src/main/skills/skillCatalog.ts`).
Application-owned only — never loaded from the user's home, a project
directory, or an AEM response.

Every **new** bundled skill must carry a user-facing summary in its front
matter: a `metadata.user-description` (one friendly phrase, no technical
detail) alongside the model-facing `description`. `readSkillCatalog`
(`src/main/skills/skillCatalog.ts`) scans `metadata.user-description` and falls
back to `description` when it is absent, so the home screen and the composer's
`/` list render the friendly text (`search` and `semantic-search` already carry
one). This is a contract, not a preference: a skill without it ships its
technical `description` to the user.

**Skills are auto-inferred from their descriptions, not only invoked by name.**
The composition root composes the model-facing catalogue — every bundled skill
with its technical `description` — onto the session instructions
(`renderSkillCatalogue` in `src/shared/skillInvocation.ts`, appended to
`toolkit.instructions` in `src/main/index.ts` after `skillCatalog.load()`), so
the model can choose a skill from its description the way other harnesses do;
`user-invocable: false` skills are in that catalogue too (they are the
agent-only ones). A model-chosen skill load is represented as the internal
`skill` tool call (`SKILL_TOOL_NAME`): Copilot's runtime `skill.invoked` event
is mapped onto it by `sdkAgentService.ts`, OpenRouter's own `skill` tool already
emits it, and `transcriptStore.ts` renders it as nothing while using it to
suppress a search skill's prose (below).

`/search <terms>` and `/semantic-search <text>` accept their argument as one
plain string — no separate "comment" is required. The `/skillname` rewrite in
`src/shared/skillInvocation.ts` frames the trailing text as the skill's input
and forbids asking the user to restate it; the skill bodies then say that input
is the search string. Both halves are load-bearing: without the framing the
model loads the skill and asks what to search for (observed live). The bodies
are written for **both** paths: an explicit `/name` turn and a turn where the
model loaded the skill on its own.

Both search skills now answer with **exactly one application-rendered table**:
`/search` makes a single `aem_query_format_ask` call (`{ "terms": ... }`), which
runs `aem_query`, `format_table` and the `ask_user` `["Load more"]` loop itself
through the tool-to-tool bridge (a hand-built predicate query is the same single
call with `predicates` instead of `terms`); `/semantic-search` calls
`aem_semantic_search` `{ terms, context }`, judges every candidate it returns by
meaning, and calls it back `{ searchId, matches }`, which tables the passing
`{ jcr:path, property, citation }` rows and runs the Load-more loop. The application suppresses the model's
own prose for a search turn two ways: at send for a turn whose prompt invokes
either skill (`isDeterministicTablePrompt` in
`src/renderer/src/chat/transcriptViewModel.ts`), and mid-turn when the model
loads `search`/`semantic-search` on its own (`transcriptStore.ts`'s `skill`
handling), so the table is the whole answer either way. See the `format_table`
bullet in the tools section above and `docs/verification.md` "Skills are
auto-inferred from their descriptions ... (2026-10-11)".

The read-only / no-side-channel policy that used to live in the on-demand
`aem-tool-selection` skill (deleted) now lives in the **always-injected**
session instructions (`AEM_ASSISTANT_INSTRUCTIONS_POLICY`, composed by
`composeAssistantInstructions` in `src/shared/tools/core/toolModule.ts`): a
skill is only read when the model chooses to load it, so it can never
*guarantee* an invariant. Per-tool "when to use me" guidance stays in each
tool's own `instructions` and descriptor — never a central, tool-enumerating
skill — which is what scales as the public-AEM-REST-API tool count grows.

### `tests/`

- `tests/unit/**` — mirrors `src/` one-for-one (`tests/unit/agents/<name>/` for
  an agent folder, `tests/unit/tools/` for tools, `tests/unit/main/agents/` for
  registry/hub). jsdom for renderer tests.
- `tests/integration/**` — real sockets, real proxies, real CA, real runtime
  (`proxy-runtime.test.ts`, `agent-runtime.test.ts`, `packaged-skill.test.ts`).
- `tests/e2e/**` — Playwright driving the **built** Electron app, one spec per
  step.
- `tests/support/**` — shared fakes (`fakeAgent`, `fakeBrowserSide`,
  `fakeAemTransport`, `testClock`, `testIds`, `agentDefinitions` — the agent
  definitions used where a real `meta.ts` glob is not wanted, `toolUnions`).
- `tests/fixtures/eslint-violations/**` — files that **must** fail lint; they
  prove the architectural boundary rules are actually switched on.

### Empty placeholders

`src/aem/`, `src/storage/` and `tests/fixtures/` contain only `.gitkeep`. They
are reserved by the plan; nothing lives there yet.

---

## 6. Commands

```bash
npm run verify       # typecheck + lint + format:check + vitest   ← the gate
npm run build        # electron-vite build + the separate aem-preload build
npm run test         # vitest only
npm run test:e2e     # Playwright, against the BUILT app — build first
npm run package:win  # NSIS x64 per-user installer
npm run dev          # electron-vite dev
```

Current baseline: **`npm run test` → 2922 passed / 14 skipped** (+3 against the
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
**Playwright → 124 tests; a full run is typically 118 passed / 6 failed.** The
`/semantic-search` case in `search-tables.spec.ts` was rewritten (count
unchanged) to the `aem_semantic_search` flow: "Did not find any relevant results
so far" in the total slot, then an appended row with "Total: 1 relevant result";
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
and four `step05-network-error.spec.ts` cases reproduce identically on a clean
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
hosts-typing case in `step05-settings-servers.spec.ts`, and the documented
`step05-loading-indicator` — are green in isolation, so a full run can show 2;
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
`tests/unit/main/aem/session.test.ts:12` and `tests/e2e/step05-aem-session.spec.ts`
(prefer-const).
The repository now has **commits** (HEAD `eab74e6`), so `git status`/`git log`
work again; the older "zero commits" notes are stale. One **pre-existing,
non-flaky** E2E failure remains: `step06-aem-bridge.spec.ts` test 2 asserts an
exact bridge-reply key list that commit `9a79dae`'s optional `headers` field
invalidated — see `docs/verification.md` "Assistant message links open the AEM
pane in edit mode (2026-09-22)".
`app.spec.ts` no longer collides with a running `npm run dev`: it now
provisions a scratch storage home like every sibling spec (see
`docs/verification.md` "Settings Servers renamed to Hosts", traps). Residual E2E
flakes, all load-correlated and green in isolation:
`step05-address-deep-link.spec.ts` (see `docs/verification.md` Step 05
closeability section), `settings-color-picker.spec.ts` (its 1–2 px geometry
assertions), `agent-token-canary.spec.ts`, `step05-loading-indicator.spec.ts`,
and `host-proxy-selection.spec.ts` (its Settings proxy-combobox persistence).
The two
previously-*consistent* failures — `step05-settings-servers.spec.ts` (an
orphaned banner collapse timer detached the OK button mid-click) and
`step08-query-results.spec.ts`'s markup case (a stale `onerror=` fixture) — were
fixed on 2026-09-22; see `docs/verification.md` "Fix the three knowingly-failing
E2E tests".

`aem-preload` has its **own** build config (`electron.vite.aem-preload.config.ts`)
because it is injected into a remote AEM page and cannot share the app preload's
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

---

## 8. Verified API facts — do not re-derive these

**Skills are not auto-injected (the bodies).** Activation needs bundled
directories *and* exactly one built-in tool whose model-facing name is `skill`
(`execute_skill` is **not** a valid allowlist entry). With skills enabled but the
tool withheld, **the model hallucinates plausible skill content instead of
failing.** Verify only via `session.rpc.skills.list()` and
`session.rpc.tools.getCurrentMetadata()` — never by reading a model answer.
Proven live: no directory ⇒ `skills: []`, tools `[]`; directory supplied ⇒ 4
skills (`source: "custom"`, `enabled: true`), tools exactly `["skill"]`;
unchanged after resume. (The app now *does* inject the skill **catalogue** —
names + descriptions — through its own session instructions so the model can
pick a skill without a `/name`; that is the app's text, not the runtime's, and
does not contradict this fact about the bodies.)

**Skills path resolution.** `electron-builder.yml` sets
`extraResources: { from: resources, to: resources }`. Packaged →
`path.join(process.resourcesPath, "resources", "skills")`. Unpackaged runs from
`out/main` → `path.join(currentDir, "..", "..", "resources", "skills")`.

**`BrokerOutcome`** is `{ kind: "response", status, contentType, bodyText }` —
not `kind: "ok"`, and the body is **not** parsed for you.

**Envelope common fields**: `requestId, chatId, turnId, serverId,
serverRevision, navigationEpoch, deadlineMs` — `deadlineMs`, not
`issuedAt`/`deadlineAt`.

**QueryBuilder.** `p.guessTotal=true` returns no "this is a guess" field, so
totals are `estimated` by default; the only provable exact case is
`more === false && offset + returned === total`. `p.properties` is
**space**-separated. `group.p.or`-style keys round-trip because `queryUrl.ts`
never inspects key shape. **HTTP 200 + valid JSON + `success: false` means the
query was rejected, not that it matched nothing**; a *missing* `success` flag is
treated as rejection.

**HTTP 414** maps to `url_too_long` — an explicit error, never a reason to
switch to POST.

**`URLSearchParams`** substitutes U+FFFD for a lone surrogate rather than
throwing.

**`app.evaluate()`** in Playwright runs inside the Electron main process; that
is how E2E drives the fake transport.

**`messageStream`** marks dirty only when the rendered text actually changes.

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

Record every step's evidence in `docs/verification.md`: what was executed, the
actual numbers, and what would have been missed without it.

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

Toolchain: Electron 44.3.0, TypeScript 6.0.3, vitest 5.0.0, Playwright 1.63.0,
zod 4.6.4, `@github/copilot-sdk` 1.0.13, `@github/copilot` 1.0.83.

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
| Host `proxyId` | **Applied (2026-09-21).** The active agent's proxy configures the Copilot runtime and sign-in; a host's three-way `proxyId` selection (Default/No proxy/entry) and the `browser.proxy` default are applied to the live AEM session, reconciled per navigation origin (`src/main/browser/proxyReconciliation.ts` + `src/main/aem/proxyResolution.ts`). |
| `step05-address-deep-link` E2E flake | Rare (≈1 of 6), load-correlated: post-fix run 5 failed the final "settings.json gains `unconfigured.example`" assertion; 5 full-suite greens since and isolated repeats never red. Root cause not split (OK-click vs `settings:add-server`); the assertion now dumps banner/open/address/on-disk context on failure so one recurrence pins it. See `docs/verification.md` Step 05 closeability section. |
| `settings-tabs.spec.ts:121` E2E failure | **Pre-existing, deterministic** (reproduced on HEAD with the work stashed, 2026-10-06): the spec locates `section[aria-label="Browser"]`, which is the browser *pane* (the settings Browser section is a `div`), and expects `Takes effect after restarting the app.` while the pane's helper text has no trailing period. Not caused by the environment-facts work; needs a spec/element fix in its own change. |
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
