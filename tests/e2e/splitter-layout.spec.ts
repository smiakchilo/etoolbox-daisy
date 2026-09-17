import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

/**
 * The draggable pane boundary, exercised against the real built app.
 *
 * A unit test cannot prove any of the three things that actually matter here,
 * so all three are asserted against a launched Electron build:
 *
 *  - a genuine mouse drag moves the boundary (jsdom has no layout, so a unit
 *    test can only prove the *handlers* run, never that the CSS grid track
 *    the handler writes has any effect);
 *  - the native AEM `WebContentsView` ends up over the pane's *new* reserved
 *    region - the view is deliberately left fully visible during the drag
 *    (no collapse, no input pass-through), and this is the assertion that it
 *    still lands on the new size afterwards. It also refutes the long-held
 *    assumption that a leftward drag would stall under the composited view:
 *    `sp-split-view`'s pointer capture spans the whole window at the OS
 *    level, so the view cannot swallow the drag even while it tracks the
 *    pane live;
 *  - the position is still there after a full quit and relaunch, which is
 *    only observable across two real app processes sharing one profile.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'splitter-layout-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A profile directory both launches share - localStorage lives under it. */
function createProfile(): Record<string, string> {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    ...definedEnv(process.env),
    USERPROFILE: home,
    HOME: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
}

function readNativeBounds(
  app: ElectronApplication,
): Promise<{ x: number; y: number; width: number; height: number }[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) return [];
    return window.contentView.children.map((child) => child.getBounds());
  });
}

test('the pane boundary is draggable, moves the native view with it, and is remembered across runs', async () => {
  test.setTimeout(180_000);

  const env = createProfile();

  const first = await electron.launch({ args: [mainEntry], env });
  const page = await first.firstWindow();

  const splitterHost = page.locator('[data-testid="pane-splitter"]');
  // The draggable bar itself lives inside `sp-split-view`'s own (open) shadow
  // root; Playwright's CSS engine pierces shadow boundaries by default, so a
  // plain descendant selector reaches it without any special syntax.
  const splitter = splitterHost.locator('#splitter');
  const host = page.locator('[data-testid="browser-view-host"]');
  await splitterHost.waitFor({ state: 'visible', timeout: 30_000 });
  await host.waitFor({ state: 'visible', timeout: 30_000 });

  const before = await host.boundingBox();
  expect(before).not.toBeNull();
  const initialWidth = (before as { width: number }).width;
  // A collapsed placeholder would make every later comparison pass vacuously.
  expect(initialWidth).toBeGreaterThan(50);

  const grip = await splitter.boundingBox();
  expect(grip).not.toBeNull();
  const bar = grip as { x: number; y: number; width: number; height: number };

  const startX = bar.x + bar.width / 2;
  const startY = bar.y + bar.height / 2;
  const dragByPx = -180;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Several intermediate moves, as a real drag produces: a single jump would
  // not exercise the mid-drag path where the cursor runs LEFT over the fully
  // visible (never-hidden) native view - the exact gesture the old collapse
  // was built to survive.
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(startX + dragByPx * step, startY);
  }
  await page.mouse.up();

  const after = await host.boundingBox();
  expect(after).not.toBeNull();
  const draggedWidth = (after as { width: number }).width;

  expect(draggedWidth).toBeLessThan(initialWidth);
  // `sp-split-view` re-anchors the splitter's LEFT edge to the pointer's
  // host-relative column on drag, so grabbing the bar's bounding-box *center*
  // (as a real user grabs a handle) lands the boundary at
  // `initialWidth + dragByPx + bar.width / 2`, not at `initialWidth +
  // dragByPx`. The app's 8px-wide bar makes that half-width 4px; the
  // expectation derives from the measured bar rather than hardcoding it, so
  // a future width change cannot silently break this.
  expect(Math.abs(draggedWidth - (initialWidth + dragByPx + bar.width / 2))).toBeLessThanOrEqual(3);

  // The native view is never collapsed by a drag (only by the hosts panel),
  // so this asserts it followed the pane live and ended exactly where the
  // drag took it.
  let matched: { x: number; y: number; width: number; height: number } | undefined;
  for (let attempt = 0; attempt < 40 && matched === undefined; attempt += 1) {
    const nativeBounds = await readNativeBounds(first);
    matched = nativeBounds.find(
      (bounds) =>
        Math.abs(bounds.width - draggedWidth) <= 1 &&
        Math.abs(bounds.height - (after as { height: number }).height) <= 1,
    );
    if (matched === undefined) await page.waitForTimeout(250);
  }
  expect(
    matched,
    `no native child view matched the dragged region (width ${draggedWidth})`,
  ).toBeDefined();

  await first.close();

  // --- second run, same profile -------------------------------------------
  const second = await electron.launch({ args: [mainEntry], env });
  const restoredPage = await second.firstWindow();
  const restoredHost = restoredPage.locator('[data-testid="browser-view-host"]');
  await restoredHost.waitFor({ state: 'visible', timeout: 30_000 });

  const restored = await restoredHost.boundingBox();
  expect(restored).not.toBeNull();
  const restoredWidth = (restored as { width: number }).width;

  console.error(`initial=${initialWidth} dragged=${draggedWidth} restored=${restoredWidth}`);

  // Restored from a persisted *fraction* of an identically sized window, so
  // this should land on the same pixel column, give or take rounding.
  expect(Math.abs(restoredWidth - draggedWidth)).toBeLessThanOrEqual(2);
  expect(Math.abs(restoredWidth - initialWidth)).toBeGreaterThan(50);

  await second.close();
});
