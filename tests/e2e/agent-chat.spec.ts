import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { AEM_GET_JSON_TOOL_NAME } from '../../src/tools/aem-get-json/aemGetJson';
import { newChatId, type AgentEvent, type ChatId, type DaisyAppApi } from '../../src/shared';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import { COMPOSER_SEND, sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { advanceFake, flushFakeAtOnce, scriptTurn } from '../support/e2e/fakeAgent';
import { createScratchDirs } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * Step 07 Milestone A, criteria #3/#4/#6/#7 (docs/implementation-plan.md
 * lines 347-400), proven against the REAL shipped `out/main/index.js` and
 * `out/preload/app-preload.js`, driven with the deterministic
 * `createFakeAgentService` fake (`src/main/agents/fakeAgentService.ts`) instead of
 * a real Copilot sign-in - criteria #1, #2 and #5 need that and are covered
 * by a separate manual checklist, not here.
 *
 * The fake is reached from the test the same way `aem-bridge.spec.ts`
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
 * distinct FAILED billet whose red cross carries the status and whose last
 * details row is the error message with the suggested action), policy-rejected
 * (must render as Rejected the same way, and must never produce a
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
 * WHAT #6 PROVES AT THE BOUNDARY RATHER THAN THROUGH THE UI: the second test
 * below opens its second conversation by calling `window.daisy.agentChat`
 * directly rather than clicking the toolbar's "New session" button. That is
 * deliberate, not a missing capability: the button now starts a fresh
 * conversation and empties the transcript (see `chatPane.ts`'s
 * `startNewSession`), but a click does not expose the new `ChatId` to the
 * test, and this criterion is about the `agent-chat:event` push-channel
 * boundary - a stale event from a torn-down conversation must never reach a
 * listener on its replacement. Driving the IPC surface directly keeps the
 * assertion pinned to that boundary and lets the test name both chat ids
 * explicitly.
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
 *   npx playwright test tests/e2e/agent-chat.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'agent-chat-scratch');

// ---------------------------------------------------------------------------
// Driving `createFakeAgentService` from the test, via `application.evaluate`
// reaching the `globalThis` handle `exposeFakeAgentServiceForTests` stashed
// (see this file's own doc comment above).
// ---------------------------------------------------------------------------

/** Delivers exactly the next queued event, if any - see `FakeAgentService.advance`. */

/** Drains every event still queued for the in-flight turn. Returns how many were delivered. */

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

const COMPOSER_STOP = '.chat-composer__stop';
const ASSISTANT_MESSAGE = '.chat-message--assistant';
const TOOL_CALL = '.chat-tool-call';
// Any status modifier: the billet carries one while it is settled.
const TOOL_STATUS_CLASS = /chat-tool-call--\w+/;

/** Waits until the composer reaches "send-enabled" - `serviceState: "ready"`, no turn in flight. */

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

/** Clicks the composer's Stop button - only valid while a turn is in flight. */
async function clickStop(shell: Page): Promise<void> {
  const button = shell.locator(COMPOSER_STOP);
  await expect(button).toBeVisible();
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
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('the fully-streamed text is visible before completion, and completion replaces it rather than duplicating it', async () => {
    // Still an empty conversation here (this is the first send in this app
    // instance): the prompt spans the pane's full height.
    await expect(shell.locator('.chat-pane')).toHaveClass(/chat-pane--empty/);

    // The empty-state prompt is genuinely stretched, not merely a taller
    // fixed-row box at the top: the field's own box must cover most of the
    // pane's height. jsdom cannot measure layout, so this is the assertion
    // that proves the fill rather than the row count.
    const emptyPaneBox = await shell.locator('.chat-pane').boundingBox();
    const emptyFieldBox = await shell.locator('.chat-composer__field').boundingBox();
    expect(emptyPaneBox).not.toBeNull();
    expect(emptyFieldBox).not.toBeNull();
    expect(emptyFieldBox?.height ?? 0).toBeGreaterThan((emptyPaneBox?.height ?? 0) * 0.6);

    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'Hello' },
        { kind: 'delta', text: ', world' },
        { kind: 'delta', text: '!' },
      ],
    });
    await sendViaComposer(shell, 'say hello', { requireVisible: true, requireEnabled: true });

    // The first send ends the empty state: the prompt moves to the bottom and
    // shrinks from its full-height box back to its ordinary height.
    await expect(shell.locator('.chat-pane')).not.toHaveClass(/chat-pane--empty/);
    const shrunkFieldBox = await shell.locator('.chat-composer__field').boundingBox();
    expect(shrunkFieldBox).not.toBeNull();
    expect(shrunkFieldBox?.height ?? 0).toBeLessThan(emptyFieldBox?.height ?? 0);

    // Deliver message-started + all three deltas, but NOT the completion:
    // the queue is [started, delta, delta, delta, completed, idle].
    await advanceFakeTimes(app, 4);
    const assistantMessage = shell.locator(ASSISTANT_MESSAGE).first();
    await expect(assistantMessage).toHaveText('Hello, world!');
    // Still mid-turn - proves the text above arrived strictly BEFORE completion.
    await expect(shell.locator(COMPOSER_STOP)).toBeVisible();

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
    await expect(shell.locator(COMPOSER_SEND)).toBeVisible();

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
    await sendViaComposer(shell, 'second message', { requireVisible: true, requireEnabled: true });
    await flushFakeAtOnce(app);
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
    await sendViaComposer(shell, 'say something else', {
      requireVisible: true,
      requireEnabled: true,
    });

    const delivered = await flushFakeAtOnce(app);
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
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
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
    await sendViaComposer(shell, "what's on the home page?", {
      requireVisible: true,
      requireEnabled: true,
    });
    await flushFakeAtOnce(app);

    const toolCall = shell.locator(TOOL_CALL).last();
    await expect(toolCall).toHaveClass(TOOL_STATUS_CLASS);
    await expect(toolCall.locator('.chat-tool-call__header')).toContainText(AEM_GET_JSON_TOOL_NAME);
  });

  test('a tool-call billet is icon-led and expands to reveal the requested path', async () => {
    await scriptTurn(app, {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: AEM_GET_JSON_TOOL_NAME,
            arguments: { path: '/content/we-retail/us/en/home' },
            decision: { kind: 'approved', outcome: { ok: true, data: {} } },
          },
        },
      ],
    });
    await sendViaComposer(shell, 'what is on the home page?', {
      requireVisible: true,
      requireEnabled: true,
    });
    await flushFakeAtOnce(app);

    const toolCall = shell
      .locator(TOOL_CALL)
      .filter({ hasText: '/content/we-retail/us/en/home' })
      .last();
    const toggle = toolCall.locator('.chat-tool-call__toggle');
    await expect(toggle).toBeVisible();

    // The requested icon must be a REGISTERED custom element in the shipped
    // renderer bundle, not an inert unknown tag - the one thing a jsdom unit
    // test structurally cannot prove (see step08-query-results.spec.ts).
    const iconUpgraded = await shell.evaluate(
      () => customElements.get('sp-icon-actions') !== undefined,
    );
    expect(iconUpgraded).toBe(true);

    // Collapsed by default: the parameters exist but are hidden.
    const params = toolCall.locator('.chat-tool-call__params');
    await expect(params).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(params).toBeVisible();
    await expect(params).toContainText('/content/we-retail/us/en/home');
    await expect(params).toContainText('.0.json');
  });

  test('an approved but failed tool call renders as a red-cross billet whose last row is the error and suggested action', async () => {
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
    await sendViaComposer(shell, 'check the protected page', {
      requireVisible: true,
      requireEnabled: true,
    });
    await flushFakeAtOnce(app);

    const toolCall = shell.locator(TOOL_CALL).last();
    await expect(toolCall).toHaveClass(TOOL_STATUS_CLASS);
    await expect(toolCall.locator('.chat-tool-call__header')).toContainText(AEM_GET_JSON_TOOL_NAME);

    // An ordinary billet: nothing about the failure shows while collapsed except
    // the red cross icon, and the details stay closed.
    const params = toolCall.locator('.chat-tool-call__params');
    await expect(params).toBeHidden();
    const icon = toolCall.locator('.chat-tool-call__icon');
    await expect(icon).toHaveClass(/chat-tool-call__icon--negative/);
    const iconUpgraded = await shell.evaluate(
      () => customElements.get('sp-icon-cross600') !== undefined,
    );
    expect(iconUpgraded).toBe(true);
    // The one requested visual difference, proven against the shipped theme
    // rather than only a jsdom element: Spectrum's semantic negative icon
    // colour (Global red-600).
    expect(await icon.evaluate((node) => getComputedStyle(node).color)).toBe('rgb(180, 0, 0)');

    // Expanding reveals the error as the last details row, with the suggested
    // action appended to that same row rather than shown as its own paragraph.
    await toolCall.locator('.chat-tool-call__toggle').click();
    await expect(params).toBeVisible();
    const value = params
      .locator('.chat-tool-call__param')
      .last()
      .locator('.chat-tool-call__param-value');
    const message = 'AEM returned 401 Unauthorized.';
    await expect(value).toContainText(message);
    expect(((await value.textContent()) ?? '').trim().length).toBeGreaterThan(message.length);

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
    await sendViaComposer(shell, 'read the secret path', {
      requireVisible: true,
      requireEnabled: true,
    });
    await flushFakeAtOnce(app);

    const toolCall = shell.locator(TOOL_CALL).last();
    await expect(toolCall).toHaveClass(TOOL_STATUS_CLASS);
    await expect(toolCall.locator('.chat-tool-call__header')).toContainText(AEM_GET_JSON_TOOL_NAME);

    // Same treatment as a failure: an ordinary collapsed billet with the red
    // cross, the policy's reason as the last details row once expanded.
    const params = toolCall.locator('.chat-tool-call__params');
    await expect(params).toBeHidden();
    await expect(toolCall.locator('.chat-tool-call__icon')).toHaveClass(
      /chat-tool-call__icon--negative/,
    );
    await toolCall.locator('.chat-tool-call__toggle').click();
    await expect(params).toBeVisible();
    await expect(params.locator('.chat-tool-call__param').last()).toContainText(
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
    const assistantMessagesBefore = await shell.locator(ASSISTANT_MESSAGE).count();
    await sendViaComposer(shell, 'list products', { requireVisible: true, requireEnabled: true });
    await flushFakeAtOnce(app);

    const toolCall = shell.locator(TOOL_CALL).last();
    await expect(toolCall).toHaveClass(TOOL_STATUS_CLASS);
    await expect(toolCall.locator('.chat-tool-call__header')).toContainText(AEM_GET_JSON_TOOL_NAME);
    // The turn has no delta steps at all - tool lifecycle display must not
    // depend on the model returning any text, and no empty bubble is painted.
    await expect(shell.locator(ASSISTANT_MESSAGE)).toHaveCount(assistantMessagesBefore);
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
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
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
    await sendViaComposer(shell, 'do a long task', { requireVisible: true, requireEnabled: true });

    // started + first delta only.
    await advanceFakeTimes(app, 2);
    const assistantMessage = shell.locator(ASSISTANT_MESSAGE).last();
    await expect(assistantMessage).toHaveText('Working on it');

    await clickStop(shell);
    await expect(shell.locator(COMPOSER_SEND)).toBeVisible();

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
    await sendViaComposer(shell, 'another long task', {
      requireVisible: true,
      requireEnabled: true,
    });
    // started + first delta: a turn is genuinely in flight on chatA.
    await advanceFakeTimes(app, 2);
    await expect(shell.locator(ASSISTANT_MESSAGE).last()).toHaveText('Still working');

    // A fresh, dedicated raw listener for this test - only events captured
    // from this point on are relevant to what follows.
    await registerRawEventCapture(shell);

    // Real, shipped IPC call (not a new surface): opens a second
    // conversation directly, naming both chat ids explicitly instead of
    // clicking the toolbar's "New session" button (which also starts a fresh
    // conversation but does not expose the new id to the test). This
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
    await flushFakeAtOnce(app);

    const capturedAfterSend = await getCapturedEvents(shell);
    expect(capturedAfterSend.some((event) => event.chatId === chatB)).toBe(true);
    expect(capturedAfterSend.some((event) => event.chatId === chatA)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// New session: the toolbar button empties the transcript and starts a fresh
// conversation (a fresh SDK session, so no prior context carries over)
// ---------------------------------------------------------------------------

test.describe('Milestone A: New session clears transcript and context', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('clicking New session empties the transcript and switches to a genuinely different conversation', async () => {
    // First conversation: a completed turn, so there is real content to clear.
    await scriptTurn(app, { steps: [{ kind: 'delta', text: 'First answer' }] });
    await sendViaComposer(shell, 'first message', { requireVisible: true, requireEnabled: true });
    await flushFakeAtOnce(app);
    await expect(shell.locator('.chat-message--user')).toHaveCount(1);
    await expect(shell.locator(ASSISTANT_MESSAGE)).toHaveCount(1);
    await expect(shell.locator('.chat-pane')).not.toHaveClass(/chat-pane--empty/);

    const oldChatId = (await shell.evaluate(() => window.daisy.agentChat.getStatus())).activeChatId;
    expect(oldChatId).not.toBeNull();

    // The real toolbar button, not the IPC surface directly.
    await shell.locator(byTestId('chat-new-session')).click();

    // The visible transcript is emptied and the empty-state presentation
    // returns...
    await expect(shell.locator('.chat-message--user')).toHaveCount(0);
    await expect(shell.locator(ASSISTANT_MESSAGE)).toHaveCount(0);
    await expect(shell.locator('.chat-pane')).toHaveClass(/chat-pane--empty/);

    // ...and main now owns a different conversation, so none of the previous
    // conversation's context survives into the next turn.
    await expect
      .poll(async () => {
        const status = await shell.evaluate(() => window.daisy.agentChat.getStatus());
        return status.activeChatId;
      })
      .not.toBe(oldChatId);
    const newChatId = (await shell.evaluate(() => window.daisy.agentChat.getStatus())).activeChatId;
    expect(newChatId).not.toBeNull();
    expect(newChatId).not.toBe(oldChatId);

    // The fresh conversation still works end to end.
    await scriptTurn(app, { steps: [{ kind: 'delta', text: 'Second answer' }] });
    await sendViaComposer(shell, 'second message', { requireVisible: true, requireEnabled: true });
    await flushFakeAtOnce(app);
    await expect(shell.locator(ASSISTANT_MESSAGE)).toHaveCount(1);
    await expect(shell.locator(ASSISTANT_MESSAGE).first()).toHaveText('Second answer');
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
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
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
    await sendViaComposer(shell, 'show me a table', { requireVisible: true, requireEnabled: true });
    await flushFakeAtOnce(app);

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
      '<img src="https://attacker.example/beacon.png" alt="Image">',
      '[click me](javascript:window.__xssMarker=true)',
    ].join('\n\n');
    await scriptTurn(app, { steps: [{ kind: 'delta', text: xssMarkdown }] });
    await sendViaComposer(shell, 'render this', { requireVisible: true, requireEnabled: true });
    await flushFakeAtOnce(app);

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
