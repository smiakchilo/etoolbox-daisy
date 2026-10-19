import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { findHostViewId, waitForViewIdle } from '../support/e2e/hostView';
import {
  closeFixtureServer,
  seedHostAndLaunch,
  startFixtureServer,
} from '../support/e2e/hostFixture';
import { COMPOSER_FIELD, COMPOSER_SEND, waitForComposerReady } from '../support/e2e/composer';
import { flushFake, scriptTurn } from '../support/e2e/fakeAgent';
import { clickPopoverAction } from '../support/e2e/hoverPopover';
import { byTestId } from '../support/selectors';

/**
 * An asset link previews the file, and every asset path offers CRX.
 *
 * Two defects this proves fixed against the BUILT app:
 *
 *  1. AEM serves a DAM asset's own URL with `Content-Disposition: attachment`,
 *     so Chromium turned the navigation into a download, the view session
 *     cancelled it (the pane never saves files) and the link appeared dead.
 *     The session now drops that one header for a response it can render, so
 *     the fixture's `attachment` image really displays in the pane.
 *  2. The asset branch of `classifyAemPath` offered Edit only (DAM) or nothing
 *     (any other asset); it now offers CRX on the asset's own node as well.
 *
 * A real loopback server is required - a reserved, never-resolving origin
 * (as `message-links.spec.ts` uses) cannot prove a download header was
 * rewritten, because no response exists to rewrite.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/asset-preview.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'asset-preview-scratch');
const ASSET_PATH = '/content/dam/fixture/pixel.gif';
const ASSISTANT = '.chat-message--assistant';

/** A 1x1 transparent GIF - enough for Chromium to build an image document. */
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Waits for the chat link, then sends a scripted assistant message containing it. */
async function sendAssetMessage(app: Parameters<typeof flushFake>[0], shell: Page, url: string) {
  await scriptTurn(app, { steps: [{ kind: 'delta', text: `Asset: [pixel.gif](${url})` }] });
  await shell.locator(COMPOSER_FIELD).fill('show me the asset');
  await shell.locator(COMPOSER_SEND).click();
  await flushFake(app);
}

/** The AEM view's document MIME, read from its own WebContents in main. */
function viewContentType(app: Parameters<typeof findHostViewId>[0], hostViewId: number) {
  return app.evaluate(
    async ({ webContents }, id: number) =>
      (await webContents.fromId(id)?.executeJavaScript('document.contentType')) as
        string | undefined,
    hostViewId,
  );
}

test('an asset link previews the attachment image and offers Edit plus CRX', async () => {
  test.setTimeout(180_000);

  const { server, origin } = await startFixtureServer(
    () => '<!doctype html><html lang="en"><head><title>Home</title></head><body>home</body></html>',
    {
      respond: (url) =>
        url === ASSET_PATH
          ? {
              contentType: 'image/gif',
              body: PIXEL_GIF,
              // AEM's own behaviour for an asset URL, and the reason the link
              // used to be cancelled as a download.
              headers: { 'content-disposition': 'attachment; filename="pixel.gif"' },
            }
          : undefined,
    },
  );
  const { app, page } = await seedHostAndLaunch(scratchBase, origin, 'Asset fixture');

  try {
    await waitForComposerReady(page, { expectSendVisible: false });
    const hostViewId = await findHostViewId(app, origin);
    await waitForViewIdle(app, hostViewId);

    await sendAssetMessage(app, page, `${origin}${ASSET_PATH}`);

    const link = page.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(link).toHaveCount(1, { timeout: 30_000 });
    await expect(link).toHaveAttribute('href', `${origin}${ASSET_PATH}`);

    // ── The popover offers Edit AND CRX for a DAM asset ─────────────────────
    await link.hover();
    const overlay = page.locator(byTestId('hover-popover'));
    await expect(page.locator(byTestId('popover-edit'))).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(byTestId('popover-crx'))).toBeVisible();
    await expect
      .poll(() => overlay.evaluate((element) => (element as unknown as { open: boolean }).open))
      .toBe(true);

    // ── A click displays the attachment image instead of downloading it ─────
    await link.click();
    await expect
      .poll(async () => await page.locator(`${byTestId('browser-address')} input`).inputValue(), {
        timeout: 30_000,
      })
      .toBe(`${origin}${ASSET_PATH}`);
    await expect
      .poll(() => viewContentType(app, hostViewId), { timeout: 30_000 })
      .toBe('image/gif');
    // The pane's own message row stays closed: nothing failed.
    await expect(page.locator('.browser-toolbar-message')).not.toHaveAttribute('open', '');

    // ── CRX opens the asset's own repository node ───────────────────────────
    // The click above closed the popover; move the pointer off the link first,
    // so hovering it again really fires a new `pointerover` (an unmoved pointer
    // over the same element fires nothing, and the popover would stay closed).
    await page.mouse.move(0, 0);
    await link.hover();
    await expect(page.locator(byTestId('popover-crx'))).toBeVisible({ timeout: 30_000 });
    await clickPopoverAction(page, 'popover-crx');
    await expect
      .poll(async () => await page.locator(`${byTestId('browser-address')} input`).inputValue(), {
        timeout: 30_000,
      })
      .toBe(`${origin}/crx/de/index.jsp#${ASSET_PATH}`);
    await waitForViewIdle(app, hostViewId);
  } finally {
    await app.close();
    await closeFixtureServer(server);
  }
});

test('an asset outside DAM offers CRX only', async () => {
  test.setTimeout(120_000);

  const { server, origin } = await startFixtureServer(
    () => '<!doctype html><html lang="en"><head><title>Home</title></head><body>home</body></html>',
  );
  const { app, page } = await seedHostAndLaunch(scratchBase, origin, 'Asset fixture');

  try {
    await waitForComposerReady(page, { expectSendVisible: false });

    const assetPath = '/apps/fixture/component.json';
    await sendAssetMessage(app, page, `${origin}${assetPath}`);

    const link = page.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(link).toHaveCount(1, { timeout: 30_000 });
    await link.hover();
    await expect(page.locator(byTestId('popover-crx'))).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(byTestId('popover-edit'))).toHaveCount(0);
  } finally {
    await app.close();
    await closeFixtureServer(server);
  }
});
