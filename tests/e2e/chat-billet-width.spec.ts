import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ScriptedStep } from '../../src/main/agents/fakeAgentService';
import { launchApp, type ElectronApp } from '../support/e2e/app';
import { sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { advanceFake, flushFake, scriptTurn } from '../support/e2e/fakeAgent';
import { createScratchDirs } from '../support/e2e/profile';

/**
 * A tool-call billet must never widen the transcript. Before the fix its
 * header (the tool name plus its status word) and its live progress line were
 * both unshrinkable one-line flex items: a long name - "aem_query_format_ask -
 * Completed" is already wide in a narrow chat pane - or a long progress note
 * ("Reading 12 of 20 · Page 3 · 40/20 collected ...", up to 120 characters)
 * pushed the billet past the pane, and because `.chat-transcript` is
 * `overflow-y: auto` its `overflow-x` computes to `auto` and it grew a
 * horizontal scrollbar. The summary already ellipsised; the header and the
 * progress line did not.
 *
 * jsdom has no layout engine, so only the real shipped bundle can prove the
 * row stays inside its container. The scripted call is delivered one event at
 * a time, so the in-flight billet (label + progress) and the settled one
 * (label + summary) are both measured.
 *
 *   npm run build
 *   npx playwright test tests/e2e/chat-billet-width.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'chat-billet-width-scratch');

const TRANSCRIPT = '.chat-transcript';
const TOOL_CALL = '.chat-tool-call';
const TOGGLE = `${TOOL_CALL} .chat-tool-call__toggle`;
const PROGRESS = `${TOOL_CALL} .chat-tool-call__progress`;

/** A fixture-fed long tool label: the billet's header shows the name and status. */
const LONG_TOOL_LABEL = 'aem_query_format_ask_with_a_long_qualifier_for_the_row';

/** A progress note long enough to outgrow any chat pane on its own (92 characters). */
const LONG_PROGRESS =
  'Reading 12 of 20 · Page 3 · 40/20 collected while checking every candidate page in the index';

/** The scripted call: a long label, a long progress note, then a result. */
const LONG_BILLET: ScriptedStep = {
  kind: 'toolCall',
  call: {
    toolName: LONG_TOOL_LABEL,
    arguments: { terms: 'anything' },
    progress: [LONG_PROGRESS],
    decision: { kind: 'approved', outcome: { ok: true, data: { matches: [] } } },
  },
};

/** Scroll and content widths of one element - `scrollWidth > clientWidth` is a scroller. */
function widths(
  shell: Page,
  selector: string,
): Promise<{ readonly scrollWidth: number; readonly clientWidth: number }> {
  return shell
    .locator(selector)
    .first()
    .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
}

test.describe('Chat tool-call billet: never a horizontal scroller', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
    shell = await app.firstWindow();
    await waitForComposerReady(shell, { awaitBannerClosed: false, expectSendVisible: false });
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('a long label and progress line shrink inside the transcript', async () => {
    test.setTimeout(120_000);
    await scriptTurn(app, { steps: [LONG_BILLET] });
    await sendViaComposer(shell, 'search the site', {
      requireVisible: true,
      requireEnabled: true,
    });

    // The scripted turn's plan is deterministic: the assistant message starts,
    // the call is requested and approved, then the progress note. Deliver
    // exactly those, so the call is still in flight (its result has not settled
    // the progress line) while it is measured.
    for (let i = 0; i < 4; i += 1) expect(await advanceFake(app)).toBe(true);
    const progress = shell.locator(PROGRESS);
    // `toHaveText` (not visibility) so the assertion is about the note reaching
    // the billet, not about how much room the row gave it.
    await expect(progress).toHaveText(LONG_PROGRESS, { timeout: 30_000 });

    // The whole label is in the DOM (it is clipped visually, not truncated in
    // the data), and the in-flight billet fits the transcript.
    await expect(shell.locator(`${TOOL_CALL} .chat-tool-call__header`)).toContainText(
      LONG_TOOL_LABEL,
    );
    const runningToggle = await widths(shell, TOGGLE);
    expect(runningToggle.scrollWidth).toBeLessThanOrEqual(runningToggle.clientWidth + 1);
    const runningTranscript = await widths(shell, TRANSCRIPT);
    expect(runningTranscript.scrollWidth).toBeLessThanOrEqual(runningTranscript.clientWidth + 1);

    // Settling the call swaps the progress line for the summary; the long label
    // is still there, and the row still fits.
    await flushFake(app);
    await expect(progress).toBeHidden({ timeout: 30_000 });
    const settledToggle = await widths(shell, TOGGLE);
    expect(settledToggle.scrollWidth).toBeLessThanOrEqual(settledToggle.clientWidth + 1);
    const settledTranscript = await widths(shell, TRANSCRIPT);
    expect(settledTranscript.scrollWidth).toBeLessThanOrEqual(settledTranscript.clientWidth + 1);
  });
});
