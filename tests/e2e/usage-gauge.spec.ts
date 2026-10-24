import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import { sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { flushFake, scriptTurn } from '../support/e2e/fakeAgent';
import { createScratchDirs } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * The chat footer's token gauge and the usage panel it opens, against the BUILT
 * app and the deterministic fake agent. The fake scripts `model.usage` and
 * `context.usage` events, which cross the real controller, IPC and preload
 * schema - the one path a unit test cannot vouch for.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/usage-gauge.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'usage-gauge-scratch');

const GAUGE = byTestId('chat-usage-gauge');
const REVEAL_LOG = byTestId('chat-reveal-log');
const USAGE_PANEL = byTestId('usage-panel');

test.describe('Chat footer: token gauge and usage panel', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
    shell = await app.firstWindow();
    await waitForComposerReady(shell, { expectSendVisible: false });
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('a new conversation has nothing to show, so the gauge is hidden', async () => {
    await expect(shell.locator(GAUGE)).toBeHidden();
  });

  test('totals a turn, sits right before the reveal-log control, and opens the usage panel', async () => {
    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'Answer' },
        {
          kind: 'usage',
          usage: {
            model: 'fake-usage-model',
            inputTokens: 10000,
            outputTokens: 1500,
            cacheReadTokens: 4000,
          },
        },
        {
          kind: 'usage',
          usage: { inputTokens: 2345, outputTokens: 300, cacheReadTokens: 345 },
        },
        { kind: 'context', currentTokens: 1200, tokenLimit: 10000 },
      ],
    });
    await sendViaComposer(shell, 'how much did that cost', {
      requireVisible: true,
      requireEnabled: true,
    });
    await flushFake(app);

    await expect(shell.locator(GAUGE)).toContainText('12.3k');
    await expect(shell.locator(GAUGE)).toContainText('1.8k');

    // The gauge is the control immediately before the reveal-log button.
    const gaugeBox = await shell.locator(GAUGE).boundingBox();
    const revealBox = await shell.locator(REVEAL_LOG).boundingBox();
    expect(gaugeBox).not.toBeNull();
    expect(revealBox).not.toBeNull();
    expect(gaugeBox!.x + gaugeBox!.width).toBeLessThanOrEqual(revealBox!.x + 1);

    await shell.locator(GAUGE).click();
    await expect(shell.locator(USAGE_PANEL)).toBeVisible();
    await expect(shell.locator(byTestId('usage-row-model'))).toContainText('fake-usage-model');
    await expect(shell.locator(byTestId('usage-row-output'))).toContainText('1,800');
    await expect(shell.locator(byTestId('usage-row-input-cached'))).toContainText('4,345');
    // 12,345 gross - 4,345 cached.
    await expect(shell.locator(byTestId('usage-row-input-uncached'))).toContainText('8,000');
    await expect(shell.locator(byTestId('usage-row-context'))).toContainText('1,200');
    // The fake reports no cost, so no cost row is offered.
    await expect(shell.locator(byTestId('usage-row-cost-usd'))).toHaveCount(0);
    await expect(shell.locator(byTestId('usage-row-cost-ai-credits'))).toHaveCount(0);

    await shell.locator(byTestId('usage-panel-close')).click();
    await expect(shell.locator(USAGE_PANEL)).toBeHidden();
  });

  test('shows a reported cost with its unit, and starts over on a new session', async () => {
    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'More' },
        {
          kind: 'usage',
          usage: { inputTokens: 100, outputTokens: 10, aiCredits: 1.25 },
        },
      ],
    });
    await sendViaComposer(shell, 'again', { requireVisible: true, requireEnabled: true });
    await flushFake(app);

    await shell.locator(GAUGE).click();
    await expect(shell.locator(byTestId('usage-row-cost-ai-credits'))).toContainText('1.25');
    await shell.locator(byTestId('usage-panel-close')).click();

    await shell.locator(byTestId('chat-new-session')).click();
    await expect(shell.locator('.chat-pane--empty')).toBeVisible();
    await expect(shell.locator(GAUGE)).toBeHidden();
  });
});
