# AGENTS.md — EToolbox Daisy

**Read this file first, then `docs/handoff-steps-09-12.md`.** Together they are
enough to start work without re-deriving anything.

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
| `docs/handoff-steps-09-12.md` | Current state, open items, traps, and the next permitted step. | Your starting point for new work. |

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

**The repository has zero commits.** Nothing has ever been committed, so
`git diff` tells you nothing — if you need to confirm you restored a file,
**re-run the tests**. Do not commit unless the user asks.

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
│  src/agent/  ← the ONLY place allowed to import the Copilot SDK      │
│    copilotClient · toolPolicy · sdkAgentService · aemTool            │
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
  → src/agent/aemTool.ts        executor: validates args, builds an envelope
  → src/main/agentComposition.ts  createBrokeredExecute / createBrokeredQueryExecute
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
| `contracts/toolContracts.ts` | Tool **argument** schemas (`aemGetJsonArgsSchema`, `aemQueryArgsSchema`) and descriptors |
| `contracts/toolResult.ts` | Tool **result** schemas, `paginationMetadataSchema`, `totalMatchesSchema`, `renderTotal()` |
| `contracts/agentEvents.ts` | The normalized event stream the renderer consumes |
| `contracts/sessionState.ts` | Session/turn state machines |
| `contracts/aemBridge.ts` | The preload↔main bridge envelope |

Non-contract shared files: `result.ts` (the `Result` type), `ipc-channels.ts`,
and the per-surface IPC type files (`agent-chat-ipc.ts`, `browser-ipc.ts`,
`settings-ipc.ts`, `app-api.ts`, `agent-auth.ts`).

> **Treat Step 03 contracts as frozen.** A few have been changed since —
> `toolResult.ts` (§8), the settings contracts `appSettings.ts` /
> `settingsSnapshot.ts` (the latter gained the `browser` object with
> `disableNativeWebAuthn`, the Settings "Browser" tab's WebAuthn-suppression
> flag), and `settings-ipc.ts`. **There is deliberately no `schemaVersion` field and no
> migration code anywhere**: the project has no deployed users and no
> backward-compatibility obligation, so the persisted shape may change freely.
> Do not add a version field or a migration. Loading a hand-edited
> `settings.json` stays forgiving — missing fields default, unknown keys are
> stripped, unusable entries are dropped — but that lives only in
> `normalizeSettingsDocument` in `src/main/settingsStore.ts`; the contract
> schemas themselves stay `.strict()`. If you must change another contract, say
> so explicitly and search for the blast radius **outside `tests/unit`** too.

### `src/agent/` — the only SDK boundary

ESLint forbids importing `@github/copilot-sdk` or `@github/copilot` anywhere
except here. Keep it that way; it is what makes the tool policy auditable.

| File | Owns |
| --- | --- |
| `copilotClient.ts` | `createHardenedCopilotClient`; needs Electron `app.isPackaged` |
| `runtimePaths.ts` | Locating the bundled runtime, packaged vs dev. Electron-free and unit-testable |
| `copilotHome.ts` | The app-specific `copilot` home directory |
| `toolPolicy.ts` | **The hardening core** — `HardenedToolPolicy`, `createHardenedSession`, `resumeHardenedSession`, `SKILL_INVOCATION_TOOL` |
| `aemTool.ts` | `createAemGetJsonExecutor`, `createAemQueryExecutor`, `AEM_ASSISTANT_INSTRUCTIONS`, `buildAemToolPolicy()` |
| `agentService.ts` | The `AgentService` interface the rest of the app codes against |
| `sdkAgentService.ts` | The real implementation |
| `fakeAgentService.ts` | The deterministic fake used by E2E |
| `auth.ts` | Sign-in status |

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
`auxiliaryWindowPolicy.ts` (popup/SSO handling), `viewBounds.ts`.

### `src/renderer/`

**Adobe Spectrum Web Components for all UI** —
<https://opensource.adobe.com/spectrum-web-components/>. Nineteen packages, all
pinned to `1.12.2` (including `alert-banner`, which renders the browser pane's
status/message row); add new ones at that same version. Elements are registered
by side-effect import in `src/renderer/src/main.ts`.

`chat/` separates view-model from view on purpose: `transcriptViewModel.ts`,
`composerViewModel.ts` and `queryResultViewModel.ts` are pure and heavily
tested; `transcriptView.ts` and `composer.ts` only render. `renderMarkdown.ts`
goes through `marked` + `DOMPurify`. **Never set a cell or message with
`innerHTML`** — the transcript uses `textContent`, and there are mutation tests
guarding that.

### `resources/skills/`

Four bundled skills, each a `SKILL.md`: `aem-daisy-conventions`,
`aem-tool-selection`, `aem-querybuilder-queries`, `aem-query-results`.
Application-owned only — never loaded from the user's home, a project
directory, or an AEM response.

### `tests/`

- `tests/unit/**` — mirrors `src/` one-for-one. jsdom for renderer tests.
- `tests/integration/**` — real sockets, real proxies, real CA, real runtime
  (`proxy-runtime.test.ts`, `agent-runtime.test.ts`, `packaged-skill.test.ts`).
- `tests/e2e/**` — Playwright driving the **built** Electron app, one spec per
  step.
- `tests/support/**` — shared fakes (`fakeAgent`, `fakeBrowserSide`,
  `fakeAemTransport`, `testClock`, `testIds`).
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

Current baseline: **`npm run verify` → 1889 passed / 14 skipped**;
**Playwright → 66 tests**. (The Session "Authentication"/"Models" → "Agents"
tab merge moved the unit baseline from 1658, and later work moved it on — see
`docs/verification.md`, whose latest section records 1889/66.)
`app.spec.ts` no longer collides with a running `npm run dev`: it now
provisions a scratch storage home like every sibling spec (see
`docs/verification.md` "Settings Servers renamed to Hosts", traps). Residual E2E
flakes, all load-correlated and green in isolation:
`step05-address-deep-link.spec.ts` (see `docs/verification.md` Step 05
closeability section), `settings-color-picker.spec.ts` (its 1–2 px geometry
assertions), and `agent-token-canary.spec.ts`. One **pre-existing, consistent**
failure is *not* a flake: `step05-settings-servers.spec.ts` (the banner OK
button detaches mid-click); it reproduces on the clean baseline and is recorded
in `docs/handoff-steps-09-12.md` as an open item.

`aem-preload` has its **own** build config (`electron.vite.aem-preload.config.ts`)
because it is injected into a remote AEM page and cannot share the app preload's
privileges. `npm run build` runs both. TypeScript is a **project-references
build** — one tsconfig per process (`tsconfig.main/preload/renderer/shared/agent/test.json`).

---

## 7. Rules that are enforced, not merely preferred

1. **Adobe Spectrum Web Components for all UI.** Pin `1.12.2`.
2. **The Copilot SDK is importable only from `src/agent/`.** ESLint-enforced.
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

---

## 8. Verified API facts — do not re-derive these

**Skills are not auto-injected.** Activation needs bundled directories *and*
exactly one built-in tool whose model-facing name is `skill` (`execute_skill` is
**not** a valid allowlist entry). With skills enabled but the tool withheld,
**the model hallucinates plausible skill content instead of failing.** Verify
only via `session.rpc.skills.list()` and `session.rpc.tools.getCurrentMetadata()`
— never by reading a model answer. Proven live: no directory ⇒ `skills: []`,
tools `[]`; directory supplied ⇒ 4 skills (`source: "custom"`, `enabled: true`),
tools exactly `["skill"]`; unchanged after resume.

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

`paginationMetadataSchema` in `src/shared/contracts/toolResult.ts` had no total
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

| Item | State |
| --- | --- |
| Step 07 manual smoke checklist | **Written, never run by a human.** Needs real Copilot + real AEM. |
| Two Copilot clients | **Design fixed.** `src/main/copilotRuntimeManager.ts` owns one `CopilotClient` for auth and chat (`replaceDelegate`), replacing `ipc/agent.ts`'s separate `cachedClient`; fake mode answers auth from the fake, so it spawns no runtime at all. The **real-path process count is still unmeasured** — measure before Step 10's shutdown work. Plan: `docs/handoff-two-copilot-clients.md`. |
| `before-quit` / `will-quit` cleanup | Not implemented; Step 10 scope. No leak measured either way — covered by the same handoff. |
| U10 residual gap | No preload fetch has been driven through a proxy or a certificate exception. Step 12 territory. |
| Host `proxyId` | Persisted, integrity-checked and projected, but **not applied** to the live AEM session/bridge fetch. (The *active agent's* proxy is applied to the Copilot runtime and sign-in.) |
| `step05-address-deep-link` E2E flake | Rare (≈1 of 6), load-correlated: post-fix run 5 failed the final "settings.json gains `unconfigured.example`" assertion; 5 full-suite greens since and isolated repeats never red. Root cause not split (OK-click vs `settings:add-server`); the assertion now dumps banner/open/address/on-disk context on failure so one recurrence pins it. See `docs/verification.md` Step 05 closeability section. |
| Git | Zero commits. `.idea/` is staged. |

---

## 12. Working agreement

- **Ambiguity goes back to the user.** The plan says it explicitly: a question
  these documents and the verified APIs cannot answer must not be resolved by a
  guess. Ask.
- **One step at a time.** Prove each step's success criteria by execution before
  starting the next. Do not mark several future steps complete on impression.
- **Keep the plan bookkeeping current as you go**, not at the end.
- **Report deviations loudly** — especially any change under
  `src/shared/contracts/`, any new dependency, and any place you had to
  implement something differently from the plan.
