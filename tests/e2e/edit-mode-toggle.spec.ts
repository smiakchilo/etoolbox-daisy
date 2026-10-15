import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * The browser toolbar's edit-mode toggle, against the real built app.
 *
 * jsdom cannot prove a custom element is registered - it renders an unknown tag
 * as `HTMLUnknownElement` and a unit test passes against a missing import - so
 * the `sp-icon-edit` registration is asserted here through `customElements.get`
 * and a real shadow root (AGENTS.md section 9). The spec then drives the real
 * switch between AEM's two renderings of one page - the web-content visitor
 * view (`/content/site/page.html?wcmmode=disabled`) and the editor
 * (`/editor.html/content/site/page.html`, no `wcmmode`) - against a local echo
 * server, which is what proves the toggle actually navigates (and rewrites the
 * `wcmmode` query parameter) rather than merely repainting.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'edit-mode-toggle-scratch');

test('the edit-mode toggle follows the open page and flips /editor.html', async () => {
  test.setTimeout(120_000);

  const env = createLaunchProfile(scratchBase).env;

  const state = { hits: 0, paths: [] as string[] };
  const server: Server = createServer((req, res) => {
    state.hits += 1;
    state.paths.push(new URL(req.url ?? '/', 'http://localhost').pathname);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>echo</title><p>ok</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const declared = server.address();
  if (declared === null || typeof declared === 'string') throw new Error('no port');
  const origin = `http://127.0.0.1:${String(declared.port)}`;

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
    // page loads and the idle shell is reached.
    await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
    await expect.poll(() => state.hits > 0, { timeout: 30_000 }).toBe(true);

    const toggle = page.locator(byTestId('browser-edit-mode'));
    // The host root is not an editable page, so the control is hidden entirely.
    await expect(toggle).toBeHidden();
    // Labelless, like the rest of the toolbar buttons: icon only.
    await expect(toggle).toHaveText('');

    // A real custom element registry entry plus a real shadow root is the only
    // proof the register-imports step ran in the built app.
    const upgraded = await toggle.evaluate(
      (el) =>
        Boolean(customElements.get('sp-icon-edit')) &&
        el.shadowRoot !== null &&
        el.querySelector('[slot="icon"]')?.shadowRoot != null,
    );
    expect(upgraded).toBe(true);

    // The control sits after the address bar, before "Open in external browser".
    const place = await toggle.evaluate((el) => ({
      afterAddressGroup: el.previousElementSibling?.classList.contains(
        'browser-toolbar__address-group',
      ),
      beforeExternal: el.nextElementSibling?.getAttribute('data-testid') === 'browser-external',
    }));
    expect(place).toEqual({ afterAddressGroup: true, beforeExternal: true });

    const addressBar = page.locator(byTestId('browser-address'));
    const addressInput = addressBar.locator('input').first();

    // A `/content` `.html` page in the web-content view: shown, off.
    await addressInput.fill(`${origin}/content/site/page.html`);
    await addressInput.press('Enter');
    await expect
      .poll(() => state.paths.includes('/content/site/page.html'), { timeout: 30_000 })
      .toBe(true);
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toHaveAttribute('selected', '');
    await expect(toggle).toHaveAttribute('title', 'Edit mode');

    // Toggle on: the page editor, and no `wcmmode` on the URL.
    await toggle.click();
    await expect
      .poll(() => state.paths.includes('/editor.html/content/site/page.html'), { timeout: 30_000 })
      .toBe(true);
    await expect(toggle).toHaveAttribute('selected', '');
    await expect(toggle).toHaveAttribute('title', 'Exit edit mode');
    await expect(addressInput).toHaveValue(`${origin}/editor.html/content/site/page.html`);

    // Toggle off: the web-content visitor view carries `wcmmode=disabled`.
    await toggle.click();
    await expect(toggle).not.toHaveAttribute('selected', '');
    await expect(addressInput).toHaveValue(`${origin}/content/site/page.html?wcmmode=disabled`);

    // Toggle on again: `wcmmode=disabled` is stripped from the editor URL.
    await toggle.click();
    await expect(toggle).toHaveAttribute('selected', '');
    await expect(addressInput).toHaveValue(`${origin}/editor.html/content/site/page.html`);

    // A non-page URL (the host root, no `.html`) hides the control again.
    await addressInput.fill(`${origin}/`);
    await addressInput.press('Enter');
    await expect(toggle).toBeHidden();
  } finally {
    await app.close();
    server.close();
  }
});
