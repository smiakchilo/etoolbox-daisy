import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mainEntry } from '../support/e2e/app';
import { waitForComposerReady } from '../support/e2e/composer';
import {
  blueOverRed,
  inset,
  isNeutral,
  samplePixels,
  type SampleRect,
} from '../support/e2e/pixels';
import { createLaunchProfile } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * A confirmation in a message row is modal, proven against the real built app.
 *
 * The row keeps its status-strip shape (one sentence and one `sp-action-button`),
 * but while it asks a yes-or-no question the region it was raised over - here the
 * History panel - is taken out of reach (`inert`) and veiled in white, so its
 * text and icons fade to the weight of disabled content while the surface stays
 * light and the dark strip below stands out. The row itself runs the one-time
 * accent wash a new `ask_user` question runs.
 *
 * None of that is provable in jsdom: `inert` blocking real input, a veil painting
 * above a whole-size panel and fading its text, and a `::after` wash landing
 * above a web component's shadow content are all facts about the composited
 * window. So this drives the real app, clicks with the real mouse, and reads the
 * window's own pixels through `webContents.capturePage`
 * (`tests/support/e2e/pixels.ts`).
 *
 * The deliberate defects these cases catch, in order:
 *  - the panel stays fully interactive behind the question (clicking its close
 *    cross while the prompt is up must do nothing);
 *  - the veil is painted in the dark underlay colour (the surface would darken
 *    into the strip's own value) or its text is left at full contrast;
 *  - the wash is declared but painted *under* the banner's own fill (the sample
 *    would read neutral throughout);
 *  - Escape closes the panel instead of answering the question.
 *
 *   npm run build
 *   npx playwright test tests/e2e/blocking-confirmation.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'blocking-confirmation-scratch');

const banner = '.surface-status-banner';
const confirmButton = `${banner} ${byTestId('banner-confirm')}`;

/** Sends one prompt on the deterministic fake agent, so History has a conversation. */
async function storeOneConversation(page: Page): Promise<void> {
  await page.locator('.chat-composer textarea').fill('a chat that will be deleted');
  await page.locator('.chat-composer__send').click();
  await expect(page.locator('.chat-message--user')).toContainText('a chat that will be deleted', {
    timeout: 30_000,
  });
}

/** Opens History and waits for its (single) row. */
async function openHistory(page: Page): Promise<void> {
  await page.locator(byTestId('chat-history')).click();
  await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(byTestId('history-item'))).toHaveCount(1, { timeout: 30_000 });
}

/** Reaches the row's Delete, exactly as a user does: hover, then press it. */
async function askToDelete(page: Page): Promise<void> {
  const item = page.locator(byTestId('history-item'));
  await item.hover();
  await item.locator(byTestId('history-delete')).click();
  await expect(page.locator(confirmButton)).toBeVisible({ timeout: 10_000 });
}

/**
 * A patch of the History panel's own background: with a single conversation the
 * lower part of the list is empty, so the sample is the surface itself rather
 * than a row's title or a control.
 */
async function emptyPanelArea(page: Page): Promise<SampleRect> {
  const box = await page.locator(byTestId('history-panel')).boundingBox();
  if (box === null) throw new Error('the History panel has no box');
  return {
    x: Math.round(box.x + 16),
    y: Math.round(box.y + box.height - 28),
    width: 60,
    height: 12,
  };
}

/**
 * A line of the stored conversation's title. Its box sits high in the list, so
 * it does not move when the prompt row takes 48px off the slot's bottom - the
 * sample before and after is the same glyphs.
 */
async function titleArea(page: Page): Promise<SampleRect> {
  const box = await page.locator('.history-item__title').boundingBox();
  if (box === null) throw new Error('the History row title has no box');
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

test.describe('a blocking confirmation', () => {
  test('veils and blocks the panel behind it, flashes once, and stays answerable', async () => {
    test.setTimeout(180_000);
    const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
    const app = await electron.launch({ args: [mainEntry], env });
    try {
      const page = await app.firstWindow();
      await waitForComposerReady(page, { expectSendVisible: false });

      const panel = page.locator(byTestId('history-panel'));
      const row = page.locator(banner);
      const viewSlot = page.locator('.browser-view-slot');

      await storeOneConversation(page);
      await openHistory(page);

      // The panel's own surface and a line of its text, sampled before anything
      // covers them.
      const surfaceBefore = await samplePixels(app, await emptyPanelArea(page));
      const titleBefore = await samplePixels(app, await titleArea(page));
      expect(isNeutral(surfaceBefore)).toBe(true);
      // The sample really does contain glyphs, so the "text faded" comparison
      // below has something to lose.
      expect(titleBefore.lumaMin).toBeLessThan(120);

      await askToDelete(page);

      // The row wears the ask_user wash the instant the question appears.
      expect(await row.evaluate((el) => el.classList.contains('banner-row--attention'))).toBe(true);
      const rowBox = await row.boundingBox();
      if (rowBox === null) throw new Error('the confirmation row has no box');
      // Capture a few times inside the fade: the wash must be visible on the
      // row's real pixels, which it cannot be if it paints beneath the banner's
      // own opaque fill. At least one sample lands while it is still strong.
      const wash: number[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        wash.push(blueOverRed(await samplePixels(app, inset(rowBox, 4))));
      }
      expect(Math.max(...wash)).toBeGreaterThan(60);

      // The panel behind the question is unreachable...
      await expect(viewSlot).toHaveAttribute('inert', '');
      await expect(viewSlot).toHaveClass(/banner-blocked-scope/);
      // ...and veiled in *white*, not painted over with the dark underlay a
      // dialog would use: the strip below must stay the dark thing on screen.
      const veil = await viewSlot.evaluate((el) => getComputedStyle(el, '::after').backgroundColor);
      const [vr, vg, vb, va] = (/rgba?\(([^)]*)\)/.exec(veil)?.[1] ?? '')
        .split(',')
        .map((part) => Number(part.trim()));
      expect(Math.min(vr ?? 0, vg ?? 0, vb ?? 0)).toBeGreaterThan(200);
      expect(va ?? 0).toBeGreaterThan(0);
      expect(va ?? 1).toBeLessThan(1);

      // The surface itself stays light - nothing was greyed out...
      const surfaceAfter = await samplePixels(app, await emptyPanelArea(page));
      expect(surfaceAfter.lumaMin).toBeGreaterThan(200);
      // ...while the text under the veil loses its contrast: the darkest pixel
      // of the very same line of copy is far lighter than it was.
      const titleAfter = await samplePixels(app, await titleArea(page));
      expect(titleAfter.lumaMin - titleBefore.lumaMin).toBeGreaterThan(60);

      // The panel's own close cross is under the scrim: a real click on it must
      // do nothing at all - the question is still there and so is the panel.
      const closeBox = await page.locator(byTestId('history-panel-close')).boundingBox();
      if (closeBox === null) throw new Error('the panel close control has no box');
      await page.mouse.click(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
      await expect(panel).toBeVisible();
      await expect(page.locator(confirmButton)).toBeVisible();
      await expect(viewSlot).toHaveAttribute('inert', '');

      // The wash is one-time: it ends by itself and leaves the row at rest.
      await expect(row).not.toHaveClass(/banner-row--attention/, { timeout: 5_000 });
      expect(isNeutral(await samplePixels(app, inset(rowBox, 4)))).toBe(true);

      // Answering releases the panel: the conversation goes and the close
      // control works again.
      await page.locator(confirmButton).click();
      await expect(page.locator(byTestId('history-item'))).toHaveCount(0, { timeout: 30_000 });
      await expect(viewSlot).not.toHaveAttribute('inert', '');
      await expect(viewSlot).not.toHaveClass(/banner-blocked-scope/);
      await page.locator(byTestId('history-panel-close')).click();
      await expect(panel).not.toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('Escape answers the question and leaves the panel where it was', async () => {
    test.setTimeout(180_000);
    const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
    const app = await electron.launch({ args: [mainEntry], env });
    try {
      const page = await app.firstWindow();
      await waitForComposerReady(page, { expectSendVisible: false });
      await storeOneConversation(page);
      await openHistory(page);
      await askToDelete(page);

      const panel = page.locator(byTestId('history-panel'));
      const viewSlot = page.locator('.browser-view-slot');
      await expect(viewSlot).toHaveAttribute('inert', '');

      await page.keyboard.press('Escape');

      // "No", not "close the panel": the prompt went, the panel did not, and the
      // conversation is still listed (nothing was deleted).
      await expect(page.locator(confirmButton)).toHaveCount(0);
      await expect(panel).toBeVisible();
      await expect(page.locator(byTestId('history-item'))).toHaveCount(1);
      await expect(viewSlot).not.toHaveAttribute('inert', '');

      // The panel's own Escape is untouched once the question is gone.
      await page.keyboard.press('Escape');
      await expect(panel).not.toBeVisible();
    } finally {
      await app.close();
    }
  });
});
