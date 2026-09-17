import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

/**
 * The Settings panel's colour picker is a plain `sp-textfield`
 * (`.color-picker__field`, holding a `#rrggbb` hex string) plus a separate
 * "picker button" (`sp-action-menu`, `.color-picker-button`) beside it: the
 * two are styled as one combobox, with the button overlapping the field's
 * right edge by 1px and the seam-facing corners squared. Clicking the button
 * opens a menu of the named swatches - each dot vertically centred against
 * its capitalised label - and picking one writes that swatch's concrete hex
 * into the field (the field remains typable at all times, so a bare swatch
 * name or a hex can be typed directly too). The combobox look and the
 * swatch/label alignment are geometry assertions, so they can only run
 * against a real renderer: `sp-action-menu` renders its overlay via the
 * native `popover`/top-layer API and its inner button lives in shadow DOM,
 * neither of which jsdom can exercise.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-color-picker-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test("picking a swatch, and typing a custom hex, both set a new server's colour", async () => {
  test.setTimeout(120_000);

  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const env = {
    ...definedEnv(process.env),
    USERPROFILE: home,
    HOME: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const settings = await app.firstWindow();
    await settings.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await settings.locator('sp-action-button', { hasText: 'Settings' }).first().click();
    await settings
      .locator('.settings-panel')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    const form = settings.locator('.add-server-form').first();
    await form.waitFor({ state: 'visible', timeout: 60_000 });

    const colorField = form.locator('.color-picker input').first();
    const colorFieldHost = form.locator('.color-picker__field').first();
    const colorMenuButton = form.locator('.color-picker-button').first();

    // Nothing open yet, and the field starts on the first named swatch with
    // its concrete hex (red = #e34850).
    await expect(settings.getByRole('menuitem')).toHaveCount(0);
    await expect(colorField).toHaveValue('#e34850');

    // The pair reads as one combobox: the button overlaps the field's right
    // edge by 1px (borders coincide), and they share a vertical centre.
    const fieldBox = await colorFieldHost.boundingBox();
    const buttonBox = await colorMenuButton.boundingBox();
    expect(fieldBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    const fieldRight = (fieldBox?.x ?? 0) + (fieldBox?.width ?? 0);
    // The button's left border sits exactly over the field's right border.
    expect(Math.abs((buttonBox?.x ?? 0) - (fieldRight - 1))).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        (buttonBox?.y ?? 0) +
          (buttonBox?.height ?? 0) / 2 -
          ((fieldBox?.y ?? 0) + (fieldBox?.height ?? 0) / 2),
      ),
    ).toBeLessThanOrEqual(2);

    // Picking a swatch from the menu writes its hex into the field; the menu
    // shows the capitalised label.
    const chevron = colorMenuButton.locator('sp-icon-chevron-down');
    const restingChevronColor = await chevron.evaluate((el) => getComputedStyle(el).color);
    // The chevron comparison below only discriminates if the resting colour is
    // a real, visible tone (not transparent).
    expect(restingChevronColor).not.toBe('rgba(0, 0, 0, 0)');
    await expect(colorMenuButton).toHaveCSS('border-top-width', '1px');
    await expect(colorMenuButton).toHaveCSS('border-top-style', 'solid');
    await colorMenuButton.click();
    const blueItem = settings.getByRole('menuitem', { name: 'Blue' });
    await expect(blueItem).toBeVisible({ timeout: 10_000 });

    // The frame must survive the open state: the inner quiet button's border
    // is transparent by definition and `selected` re-pins it transparent, so
    // the border lives on the host - it must still be a solid 1px frame while
    // the menu is open.
    await expect(colorMenuButton).toHaveCSS('border-top-width', '1px');
    await expect(colorMenuButton).toHaveCSS('border-top-style', 'solid');
    const openBorderColor = await colorMenuButton.evaluate(
      (el) => getComputedStyle(el).borderTopColor,
    );
    expect(openBorderColor).not.toBe('rgba(0, 0, 0, 0)');

    // The chevron must survive the open state too: `selected` defaults its
    // content colour to accent white (invisible on the white frame), which is
    // why it is pinned to the resting neutral - assert it did not change.
    const openChevronColor = await chevron.evaluate((el) => getComputedStyle(el).color);
    expect(openChevronColor).toBe(restingChevronColor);

    // Inside the open menu the colour dot is vertically centred on its label
    // (not anchored to the row's top edge).
    const itemBox = await blueItem.boundingBox();
    const swatchBox = await blueItem.locator('.color-picker__swatch').boundingBox();
    expect(itemBox).not.toBeNull();
    expect(swatchBox).not.toBeNull();
    expect(
      Math.abs(
        (swatchBox?.y ?? 0) +
          (swatchBox?.height ?? 0) / 2 -
          ((itemBox?.y ?? 0) + (itemBox?.height ?? 0) / 2),
      ),
    ).toBeLessThanOrEqual(2);

    await blueItem.click();
    await expect(colorField).toHaveValue('#2680eb');

    await form.locator('sp-textfield[placeholder="Label"] input').fill('Blue Server');
    await form
      .locator('sp-textfield[placeholder="https://author.example"] input')
      .fill('https://blue-server.example');
    await form.locator('sp-button', { hasText: 'Add server' }).first().click();

    const blueRow = settings.locator('.server-row', { hasText: 'Blue Server' });
    await expect(blueRow).toHaveCount(1, { timeout: 60_000 });
    await expect(blueRow.locator('.server-swatch').first()).toHaveCSS(
      'background-color',
      'rgb(38, 128, 235)', // #2680eb, the "blue" swatch
    );

    // Typing a hex value directly - no menu interaction - also works.
    await colorField.fill('#123abc');
    await form.locator('sp-textfield[placeholder="Label"] input').fill('Custom Colour Server');
    await form
      .locator('sp-textfield[placeholder="https://author.example"] input')
      .fill('https://custom-color-server.example');
    await form.locator('sp-button', { hasText: 'Add server' }).first().click();

    const customRow = settings.locator('.server-row', { hasText: 'Custom Colour Server' });
    await expect(customRow).toHaveCount(1, { timeout: 60_000 });
    await expect(customRow.locator('.server-swatch').first()).toHaveCSS(
      'background-color',
      'rgb(18, 58, 188)', // #123abc
    );

    await expect(form.locator('.form-errors')).toHaveText('');
  } finally {
    await app.close();
  }
});
