import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { mainEntry } from '../support/e2e/app';
import { waitForComposerReady } from '../support/e2e/composer';
import { createLaunchProfile } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * A large History opens calmly. Every append to the list resizes the scrollbar
 * thumb, so appending each page as it arrived made the thumb shrink once per
 * page within a fraction of a second. The panel now paints its first batch
 * immediately and appends the rest together, so the scrollable height may take
 * only two values once rows exist: the first batch and the whole list.
 *
 * Layout is not provable in jsdom, so this samples the built app's list on
 * every animation frame while it opens over 60 seeded journals (three pages).
 *
 *   npm run build
 *   npx playwright test tests/e2e/history-scroll-stability.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'history-stability-scratch');
const SEEDED_JOURNALS = 60;

test('a large history resizes its scrollable area once after the first batch', async () => {
  test.setTimeout(120_000);
  const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
  const home = env['USERPROFILE'] ?? '';
  const chatsDir = path.join(home, 'etoolbox-daisy', 'chats');
  mkdirSync(chatsDir, { recursive: true });
  for (let index = 0; index < SEEDED_JOURNALS; index += 1) {
    const chatId = `seed-${String(index).padStart(3, '0')}`;
    const records = [
      {
        recordType: 'header',
        schemaVersion: 1,
        chatId,
        sdkSessionId: `sdk-${chatId}`,
        startedAt: 1000 + index,
      },
      {
        recordType: 'user.prompt',
        at: 2000 + index,
        chatId,
        turnId: `turn-${chatId}`,
        prompt: `seeded question ${String(index)}`,
      },
    ];
    writeFileSync(
      path.join(chatsDir, `${chatId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
  }

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    await waitForComposerReady(page, { expectSendVisible: false });
    await page.evaluate(() => {
      const scope = window as unknown as { __listHeights: number[] };
      scope.__listHeights = [];
      const sample = (): void => {
        const list = document.querySelector('.history-panel__list');
        if (list !== null && list.querySelector('.history-item') !== null) {
          scope.__listHeights.push(list.scrollHeight);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    await page.locator(byTestId('chat-history')).click();
    await expect(page.locator(byTestId('history-item'))).toHaveCount(SEEDED_JOURNALS, {
      timeout: 30_000,
    });
    // Let any late append show up in the samples.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __listHeights: number[] }).__listHeights.length,
        ),
      )
      .toBeGreaterThan(30);

    const heights = await page.evaluate(
      () => (window as unknown as { __listHeights: number[] }).__listHeights,
    );
    const distinct = [...new Set(heights.filter((height) => height > 0))];
    expect(distinct.length, `scrollable heights seen: ${distinct.join(', ')}`).toBeLessThanOrEqual(
      2,
    );

    // Reopening shows the previous list until its replacement is ready: the
    // height must neither collapse to the first batch nor flash anything else.
    const settledHeight = distinct[distinct.length - 1];
    const sampledHeights = (): Promise<number[]> =>
      page.evaluate(() =>
        (window as unknown as { __listHeights: number[] }).__listHeights.filter(
          (height) => height > 0,
        ),
      );
    await page.evaluate(() => {
      (window as unknown as { __listHeights: number[] }).__listHeights.length = 0;
    });
    await page.locator(byTestId('history-panel-close')).click();
    await page.locator(byTestId('chat-history')).click();
    await expect.poll(async () => (await sampledHeights()).length).toBeGreaterThan(45);
    const reopened = [...new Set(await sampledHeights())];
    expect(reopened, `heights seen while reopening: ${reopened.join(', ')}`).toEqual([
      settledHeight,
    ]);
  } finally {
    await app.close();
  }
});
