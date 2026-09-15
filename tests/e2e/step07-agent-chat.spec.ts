import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { AEM_GET_JSON_TOOL_NAME } from '../../src/agent/aemTool';
import type { ScriptedTurn } from '../../src/agent/fakeAgentService';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';
import { newChatId, type AgentEvent, type ChatId, type DaisyAppApi } from '../../src/shared';

/**
 * Step 07 Milestone A, criteria #3/#4/#6/#7 (docs/implementation-plan.md
 * lines 347-400), proven against the REAL shipped `out/main/index.js` and
 * `out/preload/app-preload.js`, driven with the deterministic
 * `createFakeAgentService` fake (`src/agent/fakeAgentService.ts`) instead of
 * a real Copilot sign-in - criteria #1, #2 and #5 need that and are covered
 * by a separate manual checklist, not here.
 *
 * The fake is reached from the test the same way `step06-aem-bridge.spec.ts`
 * reaches main: `application.evaluate(...)`, running directly inside the
 * real Electron main process. For that to work at all, main must expose a
 * handle to the fake instance it already constructed - see
 * `agentComposition.ts`'s `TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY` and
 * `exposeFakeAgentServiceForTests`, called from exactly one place
 * (`index.ts`'s `createFakeService` factory), which only ever runs once
 * `shouldUseFakeAgentService(env, isPackaged)` has already returned `true`.
 * That is the one production change this task is authorised to make; this
 * file is the reason it exists and everything else here is test code.
 *
 * What each criterion needs and how it is proven:
 *
 * #3 (streaming correctness) - a scripted turn is delivered one event at a
 * time (`advance()`); the transcript must show the fully-streamed text
 * BEFORE `assistant.message.completed` ever arrives, and must show the exact
 * same text (not doubled) once it does. A second scripted turn whose
 * `finalContentOverride` deliberately disagrees with its folded deltas
 * proves the completed text - not the deltas - wins, and that this suite
 * would notice real drift instead of only ever agreeing with a fake that
 * always agrees with itself.
 *
 * #4 (tool lifecycle visibility) - four scripted turns cover every shape the
 * fake can produce: approved+success, approved+failure (must render as a
 * distinct FAILED card with the error message and the suggested action),
 * policy-rejected (must render as Rejected, and must never produce a
 * `tool.result` event at all - checked via a raw capture of the
 * `agent-chat:event` push channel, not merely "the DOM never shows a
 * result"), and a tool call with zero delta/text steps (the tool card must
 * still render fully, proving tool lifecycle is independent of the model
 * returning any text).
 *
 * #6 (cancellation without leakage) - two angles. First, the ordinary
 * user-visible one: clicking Stop cancels the in-flight turn, and the fake's
 * own `performAbort` (`fakeAgentService.ts`) discards every event still
 * queued for that turn, so pumping the fake afterwards delivers nothing and
 * the transcript never changes again. Second, the boundary
 * `agent-chat-ipc.ts`'s own module doc names explicitly: "a stale event from
 * an abandoned turn is dropped by `agentChatController.ts` before it ever
 * reaches the `agent-chat:event` channel". This build's shipped chat pane
 * cannot exercise that path itself - see the note below - so this test opens
 * a SECOND conversation directly over `window.daisy.agentChat`, mid-turn on
 * the first, and asserts none of the first conversation's teardown events
 * (`cancelling`/`idle`/`closed`, all still tagged with its `chatId`) ever
 * reach a raw listener on the push channel, then proves that same listener
 * is not simply silent by sending a message on the new conversation and
 * confirming ITS event is captured.
 *
 * NOTE ON WHAT #6 CANNOT PROVE HERE: this build's "New chat" toolbar button
 * is inert (no click handler is wired to it - `chatToolbar.ts`), and
 * `chatPane.ts` itself only ever adopts one `ChatId`, once, for its entire
 * lifetime (`refreshStatus`'s `if (chatId === undefined)` guard). There is
 * therefore no way, anywhere in the shipped UI, to ever display a second
 * conversation - so criterion #6 cannot be proven by pointing at a second
 * visible transcript, only at the `window.daisy.agentChat` push-channel
 * boundary directly, which is what the second test below does. This is a
 * property of the current build, not a shortcut taken by this test.
 *
 * A second, related, honest limitation: `fakeAgentService.ts`'s
 * `performAbort`/`teardown` unconditionally discard a turn's still-queued
 * events - there is no way, through the fake's public API, to later
 * "pump the remaining events of the abandoned turn" once it has been torn
 * down, because there is nothing left in the queue to pump. What this test
 * pumps instead is exactly the maximal real leak surface the shipped fake
 * can produce: the teardown itself synchronously emits three
 * `session.state.changed` events (`cancelling`, `idle`, `closed`) tagged
 * with the abandoned chat's id, and those are what a broken
 * `isOwnedEvent` would let leak into the new conversation's listener.
 *
 * #7 (rendered table and XSS) - a scripted GFM table must produce a real
 * `<table>`/`<th>`/`<td>` DOM structure (not a string of pipes and dashes),
 * and a scripted `<script>`/`onerror`/`javascript:` payload must not
 * execute: asserted on actual effect (a marker flag that would have been
 * set by any of the three payloads, no `<script>` element, no surviving
 * `javascript:` href, no attacker-origin network request), never merely on
 * sanitized markup text.
 *
 * Run against the BUILT app (this file never builds it itself):
 *   npm run build
 *   npx playwright test tests/e2e/step07-agent-chat.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step07-agent-chat-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface ScratchProfile {
  readonly home: string;
  readonly appData: string;
  readonly localAppData: string;
}

/**
 * Overriding USERPROFILE/HOME alone crashes Electron on this machine
 * (0x80000003) - APPDATA/LOCALAPPDATA must agree. Established in
 * `step04-storage.spec.ts`, copied here verbatim per this suite's existing
 * per-file convention (see `step06-aem-bridge.spec.ts`'s identical helper).
 */
function makeScratchProfile(): ScratchProfile {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return { home, appData, localAppData };
}

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

function launch(profile: ScratchProfile): Promise<ElectronApp> {
  return electron.launch({
    args: [mainEntry],
    env: {
      ...definedEnv(process.env),
      USERPROFILE: profile.home,
      HOME: profile.home,
      APPDATA: profile.appData,
      LOCALAPPDATA: profile.localAppData,
      // Selects the deterministic fake (`shouldUseFakeAgentService`,
      // `agentComposition.ts`) instead of the real Copilot SDK adapter.
      [FAKE_AGENT_SERVICE_ENV_VAR]: '1',
    },
  });
}

// ---------------------------------------------------------------------------
// Driving `createFakeAgentService` from the test, via `application.evaluate`
// reaching the `globalThis` handle `exposeFakeAgentServiceForTests` stashed
// (see this file's own doc comment above).
// ---------------------------------------------------------------------------

interface FakeHandleArg {
  readonly globalKey: string;
}

function scriptTurn(app: ElectronApp, turn: ScriptedTurn): Promise<void> {
  // `turn` is JSON-stringified before crossing the `app.evaluate` boundary,
  // rather than embedded directly in the `Arg` type parameter: Playwright's
  // `PageFunctionOn` overload resolution combined with `ScriptedTurn`'s
  // recursive `JsonValue` fields otherwise triggers TS2589 ("Type
  // instantiation is excessively deep"). The `turn: ScriptedTurn` parameter
  // above still gives every call site full structural checking.
  const payload = JSON.stringify({ globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY, turn });
  return app.evaluate((_electronNamespace, json: string) => {
    const arg = JSON.parse(json) as FakeHandleArg & { readonly turn: unknown };
    const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
      readonly scriptNextResponse: (t: unknown) => void;
    };
    fake.scriptNextResponse(arg.turn);
  }, payload);
}

/** Delivers exactly the next queued event, if any - see `FakeAgentService.advance`. */
function advanceFake(app: ElectronApp): Promise<boolean> {
  return app.evaluate(
    (_electronNamespace, arg: FakeHandleArg) => {
      const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
        readonly advance: () => boolean;
      };
      return fake.advance();
    },
    { globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY },
  );
}

/** Drains every event still queued for the in-flight turn. Returns how many were delivered. */
function flushFake(app: ElectronApp): Promise<number> {
  return app.evaluate(
    (_electronNamespace, arg: FakeHandleArg) => {
      const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
        readonly flush: () => number;
      };
      return fake.flush();
    },
    { globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY },
  );
}

/**
 * Calls `advanceFake` exactly `times` times, throwing if any call finds
 * nothing queued - a test asking for a specific mid-stream point must know
 * precisely how many events it consumed, not guess and hope.
 */
async function advanceFakeTimes(app: ElectronApp, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const delivered = await advanceFake(app);
    if (!delivered) {
      throw new Error(
        `advanceFake: expected a pending event on call ${String(i + 1)} of ${String(times)}, but none was queued.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Renderer-side helpers. `tsconfig.test.json` has no "dom" lib (this suite's
// other files only ever drive the main process, never the renderer's own
// `window`), so this file declares the minimal, file-local shape of
// `window` its own `page.evaluate` callbacks need - real at runtime (that
// callback body is re-executed inside the actual renderer, where `window`
// is the real browser global), just not ambiently declared for this
// project's Node-side type-checking.
// ---------------------------------------------------------------------------

interface TestWindow {
  daisy: DaisyAppApi;
  __xssMarker?: boolean;
  __capturedEvents?: AgentEvent[];
  __daisyRepaintWatch?: Promise<void>;
}
declare const window: TestWindow;

/**
 * Minimal, file-local shape of the couple of real DOM globals one helper
 * below needs (`waitForNextRepaint` - see its doc comment for why a
 * MutationObserver, not a timing assumption, is what makes that wait
 * legitimate). Real at runtime for the same reason `window` above is; not
 * ambiently declared for this project's Node-side type-checking.
 */
interface MinimalDomNode {
  readonly nodeType?: number;
}
interface MinimalMutationObserver {
  observe(
    target: MinimalDomNode,
    options: { childList?: boolean; subtree?: boolean; characterData?: boolean },
  ): void;
  disconnect(): void;
}
declare const document: {
  querySelectorAll(selector: string): ArrayLike<MinimalDomNode>;
};
declare const MutationObserver: new (callback: () => void) => MinimalMutationObserver;

const COMPOSER_BUTTON = '.chat-composer sp-button';
const COMPOSER_NOTICE = '.chat-composer__notice';
const COMPOSER_FIELD = '.chat-composer textarea';
const ASSISTANT_MESSAGE = '.chat-message--assistant';
const TOOL_CALL = '.chat-tool-call';

/** Waits until the composer reaches "send-enabled" - `serviceState: "ready"`, no turn in flight. */
async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(shell.locator(COMPOSER_NOTICE)).toHaveText('', { timeout: 60_000 });
  await expect(shell.locator(COMPOSER_BUTTON)).toHaveText('Send');
}

/**
 * Arms a one-shot repaint watch on the LAST element matching `selector`,
 * then returns a function that resolves once that element's subtree has
 * mutated at least once since arming.
 *
 * Why this exists, and why it is NOT simply "wait for the completion event's
 * own repaint": `chatPane.ts`'s transcript view repaints on a 100ms timer,
 * but only when `transcriptStore.takeDirty()` is true; `messageStream.ts`'s
 * `setState` only marks a message dirty when its rendered text actually
 * changes. For a turn without a `finalContentOverride`, the folded deltas
 * and the completed text are byte-identical by construction (the fake
 * always delivers every delta before `completed`), so THAT turn's own
 * completion event, correctly, never sets dirty and never repaints anything
 * - by design, not a bug. A plain `expect(locator).toHaveText(sameValue)`
 * would then either hang forever waiting on a repaint that will never come,
 * or - worse - pass on its very first poll using the PRE-completion DOM,
 * having observed nothing about completion at all (this is exactly how an
 * append-instead-of-replace mutation was first caught only by mutation
 * testing, not by this assertion). The caller is expected to arm this watch
 * on the turn's own message, then force a SEPARATE, unconditionally-dirty
 * event (a brand-new message id via `ensureMessageItem` is always dirty)
 * and wait on this watch instead: `transcriptView.ts`'s `repaint()`
 * refreshes every cached item on every call it makes, so that unrelated,
 * guaranteed repaint necessarily also re-touches the first message's node
 * with whatever the store currently holds for it - a real DOM mutation on
 * that node is therefore a faithful, race-free signal that the first
 * message has been repainted since arming; waiting for it is "waiting on
 * actual state", not a disguised sleep.
 */
async function armNextRepaintWatch(shell: Page, selector: string): Promise<() => Promise<void>> {
  await shell.evaluate((sel: string) => {
    const matches = document.querySelectorAll(sel);
    const target = matches[matches.length - 1];
    if (target === undefined) {
      throw new Error(`armNextRepaintWatch: no element matched selector: ${sel}`);
    }
    window.__daisyRepaintWatch = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(target, { childList: true, subtree: true, characterData: true });
    });
  }, selector);
  return () => shell.evaluate(() => window.__daisyRepaintWatch);
}

/** Sends `prompt` through the real composer UI - fill, then click the real Send button. */
async function sendViaComposer(shell: Page, prompt: string): Promise<void> {
  const button = shell.locator(COMPOSER_BUTTON);
  await expect(button).toHaveText('Send');
  await expect(button).not.toHaveAttribute('disabled', '');
  await shell.locator(COMPOSER_FIELD).fill(prompt);
  await button.click();
}

/** Clicks the composer's Stop button - only valid while a turn is in flight. */
async function clickStop(shell: Page): Promise<void> {
  const button = shell.locator(COMPOSER_BUTTON);
  await expect(button).toHaveText('Stop');
  await expect(button).not.toHaveAttribute('disabled', '');
  await button.click();
}

/** Registers a raw `window.daisy.agentChat.onEvent` listener independent of the shipped chat pane's own. */
function registerRawEventCapture(shell: Page): Promise<void> {
  return shell.evaluate(() => {
    window.__capturedEvents = [];
    window.daisy.agentChat.onEvent((event) => {
      (window.__capturedEvents ??= []).push(event);
    });
  });
}

function getCapturedEvents(shell: Page): Promise<readonly AgentEvent[]> {
  return shell.evaluate(() => window.__capturedEvents ?? []);
}

// ---------------------------------------------------------------------------
// Criterion #3: streaming correctness
// ---------------------------------------------------------------------------

test.describe('Milestone A #3: streaming correctness', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    app = await launch(makeScratchProfile());
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('the fully-streamed text is visible before completion, and completion replaces it rather than duplicating it', async () => {
    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'Hello' },
        { kind: 'delta', text: ', world' },
        { kind: 'delta', text: '!' },
      ],
    });
    await sendViaComposer(shell, 'say hello');

    // Deliver message-started + all three deltas, but NOT the completion:
    // the queue is [started, delta, delta, delta, completed, idle].
    await advanceFakeTimes(app, 4);
    const assistantMessage = shell.locator(ASSISTANT_MESSAGE).first();
    await expect(assistantMessage).toHaveText('Hello, world!');
    // Still mid-turn - proves the text above arrived strictly BEFORE completion.
    await expect(shell.locator(COMPOSER_BUTTON)).toHaveText('Stop');

    // Arm a repaint watch on message 1's node BEFORE delivering completion.
    const repainted = await armNextRepaintWatch(shell, ASSISTANT_MESSAGE);
    // Deliver `assistant.message.completed` + the terminal `idle` state.
    // This turn's `finalContentOverride` is absent, so under CORRECT
    // behaviour its completed content is byte-identical to what the deltas
    // already folded - `messageStream.ts`'s `setState` only marks the
    // message dirty when its rendered text actually changes, so THIS
    // completion, by itself and by design, need not repaint anything at
    // all. That means `repainted()` above must not be awaited yet: doing
    // so here would hang forever under perfectly correct code, not reveal
    // a bug.
    await advanceFakeTimes(app, 2);
    await expect(shell.locator(COMPOSER_BUTTON)).toHaveText('Send');

    // Force a SECOND, unrelated, and unconditionally dirty-marking event -
    // a brand-new message id is always dirty regardless of its content
    // (`transcriptStore.ts`'s `ensureMessageItem`) - and wait for the
    // repaint that guarantees. `transcriptView.ts`'s `repaint()` refreshes
    // EVERY cached item on every call it makes, not only the one that
    // caused it to run, so this guaranteed second repaint necessarily also
    // re-touches message 1's node with whatever the store currently holds
    // for it. That is what `repainted()` is really waiting for, and it is
    // what turns the assertion below into a genuine check of "completion
    // replaces rather than duplicates" instead of an assertion that can
    // only ever observe a state that predates completion entirely.
    await scriptTurn(app, { steps: [] });
    await sendViaComposer(shell, 'second message');
    await flushFake(app);
    await repainted();

    // Unchanged: an append-instead-of-replace bug would double this to
    // "Hello, world!Hello, world!".
    await expect(assistantMessage).toHaveText('Hello, world!');
  });

  test('a finalContentOverride that disagrees with the folded deltas wins once the turn completes', async () => {
    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'draft one' },
        { kind: 'delta', text: ' draft two' },
      ],
      finalContentOverride: 'the actual final answer',
    });
    await sendViaComposer(shell, 'say something else');

    const delivered = await flushFake(app);
    expect(delivered).toBeGreaterThan(0);

    const assistantMessage = shell.locator(ASSISTANT_MESSAGE).last();
    await expect(assistantMessage).toHaveText('the actual final answer');
  });
});

// ---------------------------------------------------------------------------
// Criterion #4: tool lifecycle visibility
// ---------------------------------------------------------------------------

test.describe('Milestone A #4: tool lifecycle visibility', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    app = await launch(makeScratchProfile());
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
    await registerRawEventCapture(shell);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('an approved, successful tool call renders as Completed', async () => {
    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'Let me check that.' },
        {
          kind: 'toolCall',
          call: {
            toolName: AEM_GET_JSON_TOOL_NAME,
            arguments: { path: '/content/we-retail/us/en.json' },
            decision: { kind: 'approved', outcome: { ok: true, data: { title: 'Home' } } },
          },
        },
      ],
    });
    await sendViaComposer(shell, "what's on the home page?");
    await flushFake(app);

    const toolCall = shell.locator(TOOL_CALL).last();
    await expect(toolCall).toHaveClass(/chat-tool-call--succeeded/);
    await expect(toolCall.locator('.chat-tool-call__header')).toHaveText(
      `${AEM_GET_JSON_TOOL_NAME} \u2014 Completed`,
    );
  });

  test('an approved but failed tool call renders as FAILED with the error message and the suggested action', async () => {
    const beforeCount = (await getCapturedEvents(shell)).length;

    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'Checking the protected page.' },
        {
          kind: 'toolCall',
          call: {
            toolName: AEM_GET_JSON_TOOL_NAME,
            arguments: { path: '/content/protected.json' },
            decision: {
              kind: 'approved',
              outcome: {
                ok: false,
                code: 'AUTH_REQUIRED',
                message: 'AEM returned 401 Unauthorized.',
              },
            },
          },
        },
      ],
    });
    await sendViaComposer(shell, 'check the protected page');
    await flushFake(app);

    const toolCall = shell.locator(TOOL_CALL).last();
    await expect(toolCall).toHaveClass(/chat-tool-call--failed/);
    await expect(toolCall.locator('.chat-tool-call__header')).toHaveText(
      `${AEM_GET_JSON_TOOL_NAME} \u2014 FAILED`,
    );
    await expect(toolCall.locator('.chat-tool-call__detail')).toHaveText(
      'AEM returned 401 Unauthorized.',
    );
    await expect(toolCall.locator('.chat-tool-call__action')).toHaveText(
      'Sign in to AEM in the browser pane, then try again.',
    );

    // A failed tool call still produces a `tool.result` event (`ok: false`)
    // - only a policy REJECTION produces none at all (see the next test).
    const newEvents = (await getCapturedEvents(shell)).slice(beforeCount);
    expect(newEvents.some((event) => event.type === 'tool.result')).toBe(true);
  });

  test('a policy-rejected tool call renders as Rejected and never produces a tool.result event', async () => {
    const beforeCount = (await getCapturedEvents(shell)).length;

    await scriptTurn(app, {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: AEM_GET_JSON_TOOL_NAME,
            arguments: { path: '/content/dam/secret.json' },
            decision: { kind: 'rejected', reason: 'This path is outside the allowed AEM server.' },
          },
        },
      ],
    });
    await sendViaComposer(shell, 'read the secret path');
    await flushFake(app);

    const toolCall = shell.locator(TOOL_CALL).last();
    await expect(toolCall).toHaveClass(/chat-tool-call--rejected/);
    await expect(toolCall.locator('.chat-tool-call__header')).toHaveText(
      `${AEM_GET_JSON_TOOL_NAME} \u2014 Rejected`,
    );
    await expect(toolCall.locator('.chat-tool-call__detail')).toHaveText(
      'This path is outside the allowed AEM server.',
    );

    const newEvents = (await getCapturedEvents(shell)).slice(beforeCount);
    expect(newEvents.some((event) => event.type === 'tool.call.rejected')).toBe(true);
    expect(newEvents.some((event) => event.type === 'tool.result')).toBe(false);
  });

  test('a tool call renders fully even when the turn returns no assistant text at all', async () => {
    await scriptTurn(app, {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: AEM_GET_JSON_TOOL_NAME,
            arguments: { path: '/content/we-retail/us/en/products.json' },
            decision: { kind: 'approved', outcome: { ok: true, data: { count: 3 } } },
          },
        },
      ],
    });
    await sendViaComposer(shell, 'list products');
    await flushFake(app);

    const toolCall = shell.locator(TOOL_CALL).last();
    await expect(toolCall).toHaveClass(/chat-tool-call--succeeded/);
    await expect(toolCall.locator('.chat-tool-call__header')).toHaveText(
      `${AEM_GET_JSON_TOOL_NAME} \u2014 Completed`,
    );
    // The turn's assistant message has no delta steps at all - tool
    // lifecycle display must not depend on the model returning any text.
    await expect(shell.locator(ASSISTANT_MESSAGE).last()).toHaveText('');
  });
});

// ---------------------------------------------------------------------------
// Criterion #6: cancellation without leakage
// ---------------------------------------------------------------------------

test.describe('Milestone A #6: cancellation without leakage', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    app = await launch(makeScratchProfile());
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('Stop cancels the in-flight turn; the fake discards the rest of the queue and nothing further changes', async () => {
    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'Working on it' },
        { kind: 'delta', text: '...' },
      ],
    });
    await sendViaComposer(shell, 'do a long task');

    // started + first delta only.
    await advanceFakeTimes(app, 2);
    const assistantMessage = shell.locator(ASSISTANT_MESSAGE).last();
    await expect(assistantMessage).toHaveText('Working on it');

    await clickStop(shell);
    await expect(shell.locator(COMPOSER_BUTTON)).toHaveText('Send');

    // `performAbort` (fakeAgentService.ts) discards the rest of this turn's
    // queue unconditionally - nothing is left to ever deliver.
    const delivered = await advanceFake(app);
    expect(delivered).toBe(false);
    await expect(assistantMessage).toHaveText('Working on it');
  });

  test("switching to a new conversation mid-turn tears the old one down, and none of its abandoned events reach the new conversation's listener", async () => {
    const statusBefore = await shell.evaluate(() => window.daisy.agentChat.getStatus());
    expect(statusBefore.activeChatId).not.toBeNull();
    const chatA = statusBefore.activeChatId as ChatId;
    const chatB = newChatId(() => randomUUID());

    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'Still working' },
        { kind: 'delta', text: ' on chat A' },
      ],
    });
    await sendViaComposer(shell, 'another long task');
    // started + first delta: a turn is genuinely in flight on chatA.
    await advanceFakeTimes(app, 2);
    await expect(shell.locator(ASSISTANT_MESSAGE).last()).toHaveText('Still working');

    // A fresh, dedicated raw listener for this test - only events captured
    // from this point on are relevant to what follows.
    await registerRawEventCapture(shell);

    // Real, shipped IPC call (not a new surface): opens a second
    // conversation directly, bypassing the inert "New chat" UI button. This
    // synchronously tears down chatA inside the fake (still mid-turn),
    // which emits exactly three `session.state.changed` events tagged
    // chatA - `cancelling`, `idle`, `closed` - before this call's promise
    // even resolves.
    const openResult = await shell.evaluate(
      (id: ChatId) => window.daisy.agentChat.openConversation({ chatId: id }),
      chatB,
    );
    expect(openResult.ok).toBe(true);

    // Nothing is left queued for the abandoned chatA turn - the fake's own
    // teardown already discarded it as part of the switch above. This is
    // the strongest available proof that nothing more could ever leak
    // later, not merely that nothing has leaked yet.
    const deliveredAfterSwitch = await advanceFake(app);
    expect(deliveredAfterSwitch).toBe(false);

    const capturedAfterSwitch = await getCapturedEvents(shell);
    expect(capturedAfterSwitch.some((event) => event.chatId === chatA)).toBe(false);

    // Non-vacuousness: the very same listener must still work. A message
    // sent on the new conversation must be captured, proving the assertion
    // above is not merely "the listener never sees anything at all".
    const sendResult = await shell.evaluate(
      (request) => window.daisy.agentChat.sendMessage(request),
      { chatId: chatB, prompt: 'hello on chat B' },
    );
    expect(sendResult.ok).toBe(true);
    await flushFake(app);

    const capturedAfterSend = await getCapturedEvents(shell);
    expect(capturedAfterSend.some((event) => event.chatId === chatB)).toBe(true);
    expect(capturedAfterSend.some((event) => event.chatId === chatA)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterion #7: rendered table and XSS safety
// ---------------------------------------------------------------------------

test.describe('Milestone A #7: rendered table and XSS safety', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    app = await launch(makeScratchProfile());
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('a GFM table renders as a real <table> element with the expected cells, not raw markdown text', async () => {
    const tableMarkdown = [
      '| Name | Value |',
      '| --- | --- |',
      '| alpha | 1 |',
      '| beta | 2 |',
    ].join('\n');
    await scriptTurn(app, { steps: [{ kind: 'delta', text: tableMarkdown }] });
    await sendViaComposer(shell, 'show me a table');
    await flushFake(app);

    const assistantMessage = shell.locator(ASSISTANT_MESSAGE).last();
    const table = assistantMessage.locator('table');
    await expect(table).toHaveCount(1);
    await expect(table.locator('th')).toHaveText(['Name', 'Value']);
    await expect(table.locator('tbody tr').nth(0).locator('td')).toHaveText(['alpha', '1']);
    await expect(table.locator('tbody tr').nth(1).locator('td')).toHaveText(['beta', '2']);

    // Not merely markdown-looking text: the raw pipe/dash source must not
    // appear literally anywhere in the rendered message.
    await expect(assistantMessage).not.toContainText('---');
  });

  test('script, onerror, and javascript: payloads in assistant content do not execute', async () => {
    await shell.evaluate(() => {
      window.__xssMarker = false;
    });
    const beaconRequests: string[] = [];
    shell.on('request', (request) => beaconRequests.push(request.url()));

    const xssMarkdown = [
      '<script>window.__xssMarker = true;</script>',
      '<img src="https://attacker.example/beacon.png" onerror="window.__xssMarker = true">',
      '[click me](javascript:window.__xssMarker=true)',
    ].join('\n\n');
    await scriptTurn(app, { steps: [{ kind: 'delta', text: xssMarkdown }] });
    await sendViaComposer(shell, 'render this');
    await flushFake(app);

    const assistantMessage = shell.locator(ASSISTANT_MESSAGE).last();
    // The message must actually have rendered (proves the assertions below
    // are checking a populated message, not an empty/failed one).
    await expect(assistantMessage.locator('a')).toHaveText('click me');

    await expect(assistantMessage.locator('script')).toHaveCount(0);
    await expect(assistantMessage.locator('svg')).toHaveCount(0);
    // `img` itself may survive (renderMarkdown.ts keeps it, deliberately
    // inert), but it must never carry a `src` or an `onerror`.
    await expect(assistantMessage.locator('img[src]')).toHaveCount(0);
    await expect(assistantMessage.locator('img[onerror]')).toHaveCount(0);

    const hrefCount = await assistantMessage.locator('a[href]').count();
    for (let i = 0; i < hrefCount; i += 1) {
      const href = await assistantMessage.locator('a[href]').nth(i).getAttribute('href');
      expect(href?.toLowerCase().startsWith('javascript:')).not.toBe(true);
    }

    const marker = await shell.evaluate(() => window.__xssMarker);
    expect(marker).toBe(false);
    expect(beaconRequests.some((url) => url.includes('attacker.example'))).toBe(false);
  });
});
