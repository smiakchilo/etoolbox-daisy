import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import { sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { advanceFake, flushFakeAtOnce, scriptTurn } from '../support/e2e/fakeAgent';
import { createScratchDirs } from '../support/e2e/profile';

/**
 * The transcript's trailing "Thinking" indicator (spinner + label) shown while
 * a turn is in flight, alongside the composer's Stop button.
 *
 * Why this is an E2E and not a unit test: the indicator is the first UI use of
 * `@spectrum-web-components/progress-circle`, and AGENTS.md §9 is explicit
 * that jsdom cannot prove a custom element is registered - it renders an
 * unknown tag as `HTMLUnknownElement`, so a unit test passes even if the
 * `sp-progress-circle.js` side-effect import is missing from `main.ts`. This
 * spec asserts a real `customElements.get(...)` registration and a real
 * `shadowRoot` against the BUILT app, which is the only way to catch that.
 *
 * The deterministic `createFakeAgentService` fake is driven from
 * `application.evaluate` the same way `agent-chat.spec.ts` does (see
 * that file's doc comment for the full rationale).
 *
 * Run against the BUILT app (this file never builds it itself):
 *   npm run build
 *   npx playwright test tests/e2e/chat-thinking-indicator.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'chat-thinking-scratch');

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

// File-local minimal DOM shape (tsconfig.test.json has no "dom" lib) - real at
// runtime inside the renderer, same convention as agent-chat.spec.ts.
declare const document: {
  querySelector(selector: string): { readonly shadowRoot: unknown } | null;
};
declare const customElements: { get(name: string): unknown };

const COMPOSER_STOP = '.chat-composer__stop';
const ASSISTANT_MESSAGE = '.chat-message--assistant';
const THINKING = '.chat-message--thinking';
const THINKING_TOGGLE = '.chat-message__thinking-toggle';
const THINKING_LINE = '.chat-message__thinking-line';
const THINKING_BODY = '.chat-message__thinking-body';

/**
 * Whether the thinking node contains a genuinely upgraded `<sp-progress-circle>`
 * - registered AND with a real shadow root. `false` for an inert unknown tag,
 * which is exactly what a missing `main.ts` side-effect import produces.
 */
function progressCircleUpgraded(shell: Page): Promise<boolean> {
  return shell.evaluate(() => {
    const node = document.querySelector('.chat-message--thinking sp-progress-circle');
    return (
      node !== null &&
      customElements.get('sp-progress-circle') !== undefined &&
      node.shadowRoot !== null
    );
  });
}

test.describe('transcript thinking indicator', () => {
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

  test('shows a registered sp-progress-circle "Thinking" indicator while in flight, and removes it once text streams', async () => {
    await scriptTurn(app, { steps: [{ kind: 'delta', text: 'Hello' }] });
    await sendViaComposer(shell, 'say hello', { requireVisible: true, requireEnabled: true });

    const thinking = shell.locator(THINKING);
    // Visible the moment a turn is in flight, before any text has arrived.
    await expect(thinking).toBeVisible();
    await expect(thinking).toHaveText(/\S/);
    // The composer's Stop button is visible at the same time (same predicate).
    await expect(shell.locator(COMPOSER_STOP)).toBeVisible();

    // The real registration proof: not an inert `HTMLUnknownElement`.
    await expect.poll(() => progressCircleUpgraded(shell)).toBe(true);

    // Deliver `assistant.message.started` only - still no text, indicator stays.
    await advanceFakeTimes(app, 1);
    await expect(thinking).toBeVisible();

    // Deliver the first text delta - the indicator must disappear.
    await advanceFakeTimes(app, 1);
    await expect(thinking).toHaveCount(0);
    await expect(shell.locator(ASSISTANT_MESSAGE).last()).toHaveText('Hello');

    // Still gone after the turn completes.
    await flushFakeAtOnce(app);
    await expect(thinking).toHaveCount(0);
  });

  test('shows streamed reasoning in an expandable billet, then erases it when the block ends', async () => {
    await scriptTurn(app, {
      steps: [{ kind: 'reasoning', text: 'first thought\nsecond thought' }],
    });
    await sendViaComposer(shell, 'reason about it', { requireVisible: true, requireEnabled: true });

    const thinking = shell.locator(THINKING);
    await expect(thinking).toBeVisible();
    // Nothing to expand yet: the toggle is inert until reasoning arrives.
    await expect(shell.locator(THINKING_TOGGLE)).toBeDisabled();

    // `assistant.message.started` - still no reasoning.
    await advanceFakeTimes(app, 1);
    await expect(shell.locator(THINKING_TOGGLE)).toBeDisabled();

    // The reasoning delta: the rolling line shows the LAST line, and the
    // billet becomes expandable.
    await advanceFakeTimes(app, 1);
    await expect(shell.locator(THINKING_LINE)).toHaveText('second thought');
    await expect(shell.locator(THINKING_TOGGLE)).toBeEnabled();

    // Expanding reveals the whole block, preserving the model's line breaks.
    await shell.locator(THINKING_TOGGLE).click();
    await expect(shell.locator(THINKING_BODY)).toBeVisible();
    await expect(shell.locator(THINKING_BODY)).toHaveText('first thought\nsecond thought');

    // `assistant.reasoning.completed`: the transient text is erased while the
    // plain indicator remains until the turn produces its final message.
    await advanceFakeTimes(app, 1);
    await expect(shell.locator(THINKING_LINE)).toHaveText('');
    await expect(shell.locator(THINKING_BODY)).toBeHidden();
    await expect(shell.locator(THINKING_TOGGLE)).toBeDisabled();

    await flushFakeAtOnce(app);
    await expect(thinking).toHaveCount(0);
  });
});
