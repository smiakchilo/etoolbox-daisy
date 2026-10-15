import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

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

const scratchBase = path.resolve(__dirname, '../../test-results', 'splitter-layout-scratch');

/** A profile directory both launches share - localStorage lives under it. */

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

  const env = createLaunchProfile(scratchBase).env;

  // Seed one real host. A fresh profile opens (and then keeps) the Settings
  // panel at startup - a panel is not user-dismissible until a page sits under
  // it, so the splitter/native-view measurements need a host picked from the
  // startup hosts picker instead, which loads the page and closes the panel
  // in one step.
  const state = { hits: 0 };
  const server: Server = createServer((_req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>echo</title><p>ok</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const base = defaultAppSettings();
  writeSettings(
    env.USERPROFILE as string,
    appSettingsSchema.parse({
      ...base,
      hosts: [
        ...base.hosts,
        {
          id: randomUUID(),
          label: 'Echo',
          origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  const first = await electron.launch({ args: [mainEntry], env });
  const page = await first.firstWindow();

  // A seeded profile means the hosts panel is already open at startup. With
  // nothing loaded into the native view yet it is not dismissible, so pick
  // the seeded host: it closes the panel AND loads a page, and the
  // splitter/native-view measurements below land on the idle two-pane shell.
  await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
  await expect.poll(() => state.hits > 0, { timeout: 30_000 }).toBe(true);

  const splitterHost = page.locator('sp-split-view');
  // The draggable bar itself lives inside `sp-split-view`'s own (open) shadow
  // root; Playwright's CSS engine pierces shadow boundaries by default, so a
  // plain descendant selector reaches it without any special syntax.
  const splitter = splitterHost.locator('#splitter');
  const host = page.locator('.browser-view-host');
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
  // The first run left the echo page as the last opened page, so this run
  // restores it automatically and never opens the hosts picker (see
  // `lastPageStore.ts`): the idle shell is reached with no click.
  const restoredHost = restoredPage.locator('.browser-view-host');
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
  server.close();
});
