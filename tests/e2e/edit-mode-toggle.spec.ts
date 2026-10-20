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
 * `wcmmode` query parameter) rather than merely repainting. A final step drives
 * AEM as a Cloud Service's shell editor form (`/ui#/aem/editor.html/...`), whose
 * real UI path sits in the fragment, and proves the toggle both recognises it
 * and leaves the shell for the plain web-content view.
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

    // The address field is overwritten by every navigation-state push, so a
    // fresh typed address is only safe once the previous load has settled
    // (the Refresh control is a Stop while one is in flight).
    const waitForIdle = async (): Promise<void> => {
      await expect(page.locator(byTestId('browser-refresh'))).toBeVisible();
    };

    // A `/content` `.html` page in the web-content view: shown, off.
    await waitForIdle();
    await addressInput.fill(`${origin}/content/site/page.html`);
    await addressInput.press('Enter');
    await expect
      .poll(() => state.paths.includes('/content/site/page.html'), { timeout: 30_000 })
      .toBe(true);
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toHaveAttribute('selected', '');
    await expect(toggle).toHaveAttribute('title', 'Edit mode');

    // Spectrum's hold affordance marks the long press. Driving a real pointer
    // hold and waiting for the navigation it triggers (rather than sleeping)
    // proves the 300ms threshold fired before the pointer came up.
    await expect(toggle).toHaveAttribute('hold-affordance', '');
    const longPress = async (): Promise<void> => {
      const box = await toggle.boundingBox();
      if (box === null) throw new Error('the edit-mode toggle has no box');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      try {
        await expect(addressInput).toHaveValue(
          `${origin}/content/site/page.html?wcmmode=disabled`,
          { timeout: 10_000 },
        );
      } finally {
        await page.mouse.up();
      }
      // The release's click is swallowed: had it been delivered, it would have
      // flipped the page straight into the editor.
      await expect(addressInput).toHaveValue(`${origin}/content/site/page.html?wcmmode=disabled`);
    };

    // A long press from the web-content view asks for the visitor view, where a
    // click would have opened the editor instead.
    await longPress();
    await expect(toggle).not.toHaveAttribute('selected', '');

    // Toggle on: the page editor, and no `wcmmode` on the URL.
    await toggle.click();
    await expect
      .poll(() => state.paths.includes('/editor.html/content/site/page.html'), { timeout: 30_000 })
      .toBe(true);
    await expect(toggle).toHaveAttribute('selected', '');
    await expect(toggle).toHaveAttribute('title', 'Exit edit mode');
    await expect(addressInput).toHaveValue(`${origin}/editor.html/content/site/page.html`);

    // A long press from the editor lands on the same visitor view a click does.
    await longPress();
    await expect(toggle).not.toHaveAttribute('selected', '');
    await expect(addressInput).toHaveValue(`${origin}/content/site/page.html?wcmmode=disabled`);

    // Toggle on again: `wcmmode=disabled` is stripped from the editor URL.
    await toggle.click();
    await expect(toggle).toHaveAttribute('selected', '');
    await expect(addressInput).toHaveValue(`${origin}/editor.html/content/site/page.html`);

    // Toggle off with a plain click, which still works right after a long press
    // (the swallowed click only covered the long press's own release).
    await toggle.click();
    await expect(toggle).not.toHaveAttribute('selected', '');
    await expect(addressInput).toHaveValue(`${origin}/content/site/page.html?wcmmode=disabled`);

    // AEM as a Cloud Service serves the editor behind its shell route, with the
    // real UI path in the fragment: the toggle must recognise it and, on a
    // click, leave the shell for the plain web-content view.
    await waitForIdle();
    await addressInput.fill(`${origin}/ui#/aem/editor.html/content/site/page.html`);
    await addressInput.press('Enter');
    await expect.poll(() => state.paths.includes('/ui'), { timeout: 30_000 }).toBe(true);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('selected', '');

    await toggle.click();
    await expect(toggle).not.toHaveAttribute('selected', '');
    await expect
      .poll(() => state.paths.includes('/content/site/page.html'), { timeout: 30_000 })
      .toBe(true);
    await expect(addressInput).toHaveValue(`${origin}/content/site/page.html?wcmmode=disabled`);

    // A non-page URL (the host root, no `.html`) hides the control again.
    await waitForIdle();
    await addressInput.fill(`${origin}/`);
    await addressInput.press('Enter');
    await expect(toggle).toBeHidden();
  } finally {
    await app.close();
    server.close();
  }
});
