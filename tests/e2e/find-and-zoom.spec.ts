import path from 'node:path';
import { expect, test } from '@playwright/test';
import { findHostViewId, pressOn, waitForViewIdle } from '../support/e2e/hostView';
import {
  closeFixtureServer,
  seedHostAndLaunch,
  startFixtureServer,
} from '../support/e2e/hostFixture';
import { sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { flushFake, scriptTurn } from '../support/e2e/fakeAgent';
import { byTestId } from '../support/selectors';

/**
 * Find-in-page and zoom, against the built app.
 *
 * Both are matched in main (`src/main/shortcuts.ts` + `zoom.ts`) and driven by
 * keystrokes that must reach a `before-input-event` listener, so the input is
 * injected from main (`WebContents.sendInputEvent`) - a Playwright
 * `page.keyboard` event never does (see `devtools.spec.ts`). The find bar itself
 * is ordinary renderer UI, so once it is open it is driven with Playwright
 * input like any other control.
 *
 * The AEM pane is a second `WebContents`, so this spec also proves the two
 * documents are searched and zoomed independently: the browser bar searches the
 * loaded AEM page, the chat bar searches the shell's transcript, and a zoom key
 * lands on whichever pane has focus.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/find-and-zoom.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'find-and-zoom-scratch');

const PAGE_HTML =
  '<!doctype html><html lang="en"><head><title>Find fixture</title></head>' +
  '<body><p>cinnamon</p><p>cinnamon roll</p></body></html>';

/** The AEM view's current Electron zoom level, read from main. */
function zoomLevelOf(
  app: Parameters<typeof findHostViewId>[0],
  hostViewId: number,
): Promise<number> {
  return app.evaluate(
    ({ webContents }, id: number) => webContents.fromId(id)?.getZoomLevel() ?? Number.NaN,
    hostViewId,
  );
}

test('find-in-page and zoom work from both panes', async () => {
  test.setTimeout(180_000);

  const { server, origin } = await startFixtureServer(() => PAGE_HTML);
  const { app, page } = await seedHostAndLaunch(scratchBase, origin, 'Find fixture');

  try {
    const hostViewId = await findHostViewId(app, origin);
    await expect
      .poll(async () => await page.locator(`${byTestId('browser-address')} input`).inputValue(), {
        timeout: 30_000,
      })
      .toBe(`${origin}/`);
    await waitForViewIdle(app, hostViewId);

    // ── Ctrl+F on the AEM pane opens the browser find bar and finds matches ──
    // The press's return value is deliberately not asserted: the find action
    // moves keyboard focus to the shell (the bar's field lives there), so the
    // AEM view is no longer focused by the time it returns.
    await pressOn(app, 'host', hostViewId, 'F', ['control']);
    const browserBar = page.locator(byTestId('browser-find'));
    await expect(browserBar).toBeVisible();
    const browserField = page.locator(`${byTestId('browser-find-field')} input`);
    await expect(browserField).toBeFocused();

    await browserField.fill('cinnamon');
    await expect(page.locator(byTestId('browser-find-count'))).toHaveText('1/2');

    // Escape closes the bar (and clears the highlight).
    await browserField.press('Escape');
    await expect(browserBar).toBeHidden();

    // ── Ctrl+numpad + / - / 0 zoom the AEM page ─────────────────────────────
    expect(await pressOn(app, 'host', hostViewId, 'numadd', ['control'])).toBe(true);
    await expect.poll(() => zoomLevelOf(app, hostViewId)).toBe(1);

    await pressOn(app, 'host', hostViewId, 'numsub', ['control']);
    await expect.poll(() => zoomLevelOf(app, hostViewId)).toBe(0);

    await pressOn(app, 'host', hostViewId, 'numadd', ['control']);
    await pressOn(app, 'host', hostViewId, 'numadd', ['control']);
    await expect.poll(() => zoomLevelOf(app, hostViewId)).toBe(2);

    await pressOn(app, 'host', hostViewId, '0', ['control']);
    await expect.poll(() => zoomLevelOf(app, hostViewId)).toBe(0);

    // ── Ctrl+F on the shell (chat focused) opens the chat find bar ───────────
    await waitForComposerReady(page);
    await scriptTurn(app, { steps: [{ kind: 'delta', text: 'cinnamon' }] });
    await sendViaComposer(page, 'hello', { requireVisible: true, requireEnabled: true });
    await flushFake(app);
    await expect(page.locator('.chat-message--assistant').last()).toHaveText('cinnamon');
    // Put focus inside the chat pane, so the shell-sourced Ctrl+F routes there.
    await page.locator(byTestId('chat-composer-field')).click();

    expect(await pressOn(app, 'shell', hostViewId, 'F', ['control'])).toBe(true);
    const chatBar = page.locator(byTestId('chat-find'));
    await expect(chatBar).toBeVisible();
    const chatField = page.locator(`${byTestId('chat-find-field')} input`);
    await expect(chatField).toBeFocused();
    await chatField.fill('cinnamon');
    // Exactly the transcript's one occurrence: the chat find is scoped to the
    // transcript, so the query in the field itself (and the composer) never
    // match - the whole-document find this replaced reported one extra.
    await expect(page.locator(byTestId('chat-find-count'))).toHaveText('1/1');

    // The composer's placeholder ("Type your message or command here") is
    // outside the transcript, so a query for a word it contains matches nothing.
    await chatField.fill('message');
    await expect(page.locator(byTestId('chat-find-count'))).toHaveText('0/0');
    await chatField.fill('cinnamon');
    await expect(page.locator(byTestId('chat-find-count'))).toHaveText('1/1');

    await chatField.press('Escape');
    await expect(chatBar).toBeHidden();
  } finally {
    await app.close();
    await closeFixtureServer(server);
  }
});

test('typing a query with many matches keeps focus in the chat find field', async () => {
  test.setTimeout(120_000);

  const { server, origin } = await startFixtureServer(() => PAGE_HTML);
  const { app, page } = await seedHostAndLaunch(scratchBase, origin, 'Find fixture');

  try {
    await waitForComposerReady(page);
    // A long answer with the search term repeated hundreds of times: a find for
    // it is expensive, and Chromium's find-in-page used to move focus out of the
    // field (to the document body) once the match count grew, breaking typing.
    const text = Array.from({ length: 300 }, () => 'cinnamon').join(' ');
    await scriptTurn(app, { steps: [{ kind: 'delta', text }] });
    await sendViaComposer(page, 'hello', { requireVisible: true, requireEnabled: true });
    await flushFake(app);
    await expect(page.locator('.chat-message--assistant').last()).toContainText('cinnamon');

    await page.locator(byTestId('chat-composer-field')).click();
    await pressOn(app, 'shell', 0, 'F', ['control']);
    const field = page.locator(`${byTestId('chat-find-field')} input`);
    await expect(field).toBeFocused();

    // A fast burst, then let the debounced search run against the hundreds of
    // matches. The field keeps focus and the typed text is intact.
    await page.keyboard.type('cinnamon', { delay: 30 });
    await expect(field).toHaveValue('cinnamon');
    // Hundreds of transcript matches, counted exactly - and the query in the
    // field's own text is not among them.
    await expect(page.locator(byTestId('chat-find-count'))).toHaveText('1/300');
    await expect(field).toBeFocused();
    // Stepping travels through the transcript's matches, not out of it.
    await page.locator(byTestId('chat-find-next')).click();
    await expect(page.locator(byTestId('chat-find-count'))).toHaveText('2/300');
    await page.locator(byTestId('chat-find-next')).click();
    await expect(page.locator(byTestId('chat-find-count'))).toHaveText('3/300');
    await page.locator(byTestId('chat-find-prev')).click();
    await expect(page.locator(byTestId('chat-find-count'))).toHaveText('2/300');
  } finally {
    await app.close();
    await closeFixtureServer(server);
  }
});
