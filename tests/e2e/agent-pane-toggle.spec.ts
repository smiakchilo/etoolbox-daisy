import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
} from '@playwright/test';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * The browser toolbar's agent-pane toggle, against the real built app.
 *
 * A unit test can prove the split view's handlers write the right inline
 * styles, but only a launched Electron build can prove the things that
 * actually matter here: that the chat pane really disappears, that the native
 * AEM `WebContentsView` really widens to the window edge (no right blank
 * margin - the view is positioned by main from the renderer's measured
 * rectangle, so a DOM-only assertion would be lying), and that the former
 * split really comes back.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'agent-pane-toggle-scratch');

function readNativeBounds(
  app: ElectronApplication,
): Promise<{ x: number; y: number; width: number; height: number }[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) return [];
    return window.contentView.children.map((child) => child.getBounds());
  });
}

/**
 * The opaque background colour actually painted for an `sp-action-button`,
 * read from whichever element in its shadow root carries it. Returns `null`
 * when nothing paints an opaque fill (a quiet, unselected button).
 */
function paintedBackground(locator: Locator): Promise<{ r: number; g: number; b: number } | null> {
  return locator.evaluate((host) => {
    const root = host.shadowRoot;
    const nodes: Element[] = [host, ...(root === null ? [] : [...root.querySelectorAll('*')])];
    for (const node of nodes) {
      const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(
        getComputedStyle(node).backgroundColor,
      );
      if (match === null) continue;
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if (alpha === 0) continue;
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
    }
    return null;
  });
}

test('the agent pane collapses to give the page the full width, and restores its former split', async () => {
  test.setTimeout(180_000);

  const env = createLaunchProfile(scratchBase).env;

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

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();

    // A seeded profile opens the hosts picker at startup; pick the host so a
    // page loads and the idle two-pane shell is reached.
    await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
    await expect.poll(() => state.hits > 0, { timeout: 30_000 }).toBe(true);

    const host = page.locator('.browser-view-host');
    const chatPane = page.locator('.chat-pane');
    await host.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(chatPane).toBeVisible();

    const windowWidth = await page.evaluate(() => window.innerWidth);
    const before = await host.boundingBox();
    expect(before).not.toBeNull();
    const beforeWidth = (before as { width: number }).width;
    // The chat pane must genuinely occupy space before we collapse it, or the
    // "full width" comparison below would pass vacuously.
    expect(beforeWidth).toBeLessThan(windowWidth - 50);

    // ── Collapse ────────────────────────────────────────────────────────────
    const closeToggle = page.locator(byTestId('agent-pane-toggle'));
    // Open pane = toggle selected, tinted light gray (Spectrum's default
    // selected fill is dark gray with white content; this app re-tints it).
    await expect(closeToggle).toHaveAttribute('selected', '');
    const selectedFill = await paintedBackground(closeToggle);
    expect(selectedFill).not.toBeNull();
    expect(
      Math.min(selectedFill?.r ?? 0, selectedFill?.g ?? 0, selectedFill?.b ?? 0),
    ).toBeGreaterThan(200);

    await closeToggle.click();

    await expect(chatPane).toBeHidden();
    const openToggle = page.locator(byTestId('agent-pane-toggle'));
    await expect(openToggle).toBeVisible();
    await expect(openToggle).not.toHaveAttribute('selected', '');

    // The reserved region (and therefore the native view) now reaches the
    // window's right edge: no blank margin where the chat pane used to be.
    await expect
      .poll(async () => Math.round((await host.boundingBox())?.width ?? 0), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(windowWidth - 2);

    // And the real composited WebContentsView actually followed it there.
    await expect
      .poll(
        async () => {
          const measured = (await host.boundingBox())?.width ?? 0;
          const nativeBounds = await readNativeBounds(app);
          return nativeBounds.some((bounds) => Math.abs(bounds.width - measured) <= 1);
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // ── Restore ─────────────────────────────────────────────────────────────
    await page.locator(byTestId('agent-pane-toggle')).click();

    await expect(chatPane).toBeVisible();
    const restoredToggle = page.locator(byTestId('agent-pane-toggle'));
    await expect(restoredToggle).toBeVisible();
    await expect(restoredToggle).toHaveAttribute('selected', '');
    await expect
      .poll(async () => Math.round((await host.boundingBox())?.width ?? 0), { timeout: 15_000 })
      .toBeLessThanOrEqual(Math.round(beforeWidth) + 2);
  } finally {
    await app.close();
    server.close();
  }
});
