import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

/**
 * Regression test for a defect that every unit test and a clean build missed:
 * the AEM `WebContentsView` was composited at 0 x 0, so the browser pane was
 * invisible even though the renderer rendered a correct two-pane layout and
 * the main process held a perfectly good view.
 *
 * Nothing short of measuring the real native view catches that, so this spec
 * compares two independently-obtained rectangles:
 *
 *  - what the RENDERER reserved - `.browser-view-host`'s client rect, read
 *    through Playwright's page API;
 *  - what MAIN actually gave the native view - `View.getBounds()` on the
 *    window's real child views.
 *
 * Asserting only "width > 0" would pass if the view were merely *somewhere*;
 * asserting equality with the reserved region is what proves the pane is
 * where the layout says it should be.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-view-bounds-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test("the AEM view is composited over the renderer's reserved region, not at 0 x 0", async () => {
  test.setTimeout(90_000);

  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...definedEnv(process.env),
      USERPROFILE: home,
      HOME: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    },
  });

  const page = await app.firstWindow();
  const hostLocator = page.locator('[data-testid="browser-view-host"]');
  await hostLocator.waitFor({ state: 'visible', timeout: 30_000 });

  const readNativeBounds = (): Promise<{ x: number; y: number; width: number; height: number }[]> =>
    app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      if (window === undefined) return [];
      return window.contentView.children.map((child) => child.getBounds());
    });

  // The renderer reports bounds over IPC, so main's copy can legitimately lag
  // the DOM by a frame plus a round trip. Poll rather than sleep a fixed
  // amount, so the test is neither flaky nor artificially slow.
  let reserved = await hostLocator.boundingBox();
  let nativeBounds = await readNativeBounds();
  let matched: { x: number; y: number; width: number; height: number } | undefined;

  for (let attempt = 0; attempt < 40 && matched === undefined; attempt += 1) {
    reserved = await hostLocator.boundingBox();
    nativeBounds = await readNativeBounds();
    if (reserved !== null) {
      const want = reserved;
      matched = nativeBounds.find(
        (bounds) =>
          Math.abs(bounds.width - want.width) <= 1 && Math.abs(bounds.height - want.height) <= 1,
      );
    }
    if (matched === undefined) await page.waitForTimeout(250);
  }

  console.error('reserved:', JSON.stringify(reserved), 'native:', JSON.stringify(nativeBounds));

  expect(reserved).not.toBeNull();
  const region = reserved as { x: number; y: number; width: number; height: number };

  // The reserved region must itself be real; a collapsed placeholder would
  // make the comparison below pass vacuously at 0 x 0.
  expect(region.width).toBeGreaterThan(50);
  expect(region.height).toBeGreaterThan(50);

  expect(
    matched,
    `no native child view matched the reserved region ${JSON.stringify(region)}; ` +
      `native children were ${JSON.stringify(nativeBounds)}`,
  ).toBeDefined();

  const view = matched as { x: number; y: number; width: number; height: number };
  expect(Math.abs(view.x - region.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(view.y - region.y)).toBeLessThanOrEqual(1);

  await app.close();
});
