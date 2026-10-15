import { _electron as electron, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byField, byTestId } from '../support/selectors';

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

const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-color-picker-scratch');

/** The `rgb(r, g, b)` form a browser reports for a `#rrggbb` colour. */
function hexToRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
}

test('picking a swatch, and typing a custom hex, both set a host colour', async () => {
  test.setTimeout(120_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData });
  const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const settings = await app.firstWindow();
    await settings
      .locator(byTestId('browser-address'))
      .waitFor({ state: 'visible', timeout: 60_000 });
    await settings.locator(byTestId('chat-settings')).click();
    await settings
      .locator(byTestId('settings-panel'))
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    await settings
      .locator('.multifield__add')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    // A draft exists only once "Add item" is clicked.
    await settings.locator('.multifield__add').first().click();
    const item = settings.locator('.multifield__item').first();
    await expect(item).toHaveCount(1);

    const colorField = item.locator('.color-picker input').first();
    const colorFieldHost = item.locator('.color-picker__field').first();
    const colorMenuButton = item.locator('.color-picker-button').first();
    const colorPreview = item.locator('.color-picker__preview').first();

    // Nothing open yet, and the field starts on a concrete default hex. The
    // preview dot shows that colour.
    await expect(settings.getByRole('menuitem')).toHaveCount(0);
    await expect(colorField).toHaveValue(/^#[0-9a-f]{6}$/i);
    const defaultHex = await colorField.inputValue();
    await expect(colorPreview).toHaveCSS('background-color', hexToRgb(defaultHex));

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

    // The live preview dot is rendered *inside* the field's left edge, so the
    // colour field's box itself lines up with the other host fields instead of
    // being pushed right by an external dot.
    const previewBox = await colorPreview.boundingBox();
    expect(previewBox).not.toBeNull();
    expect(previewBox?.x ?? 0).toBeGreaterThan(fieldBox?.x ?? 0);
    expect((previewBox?.x ?? 0) + (previewBox?.width ?? 0)).toBeLessThanOrEqual(
      (fieldBox?.x ?? 0) + (fieldBox?.width ?? 0),
    );
    const addressFieldBox = await item.locator(byField('host-address')).first().boundingBox();
    expect(addressFieldBox).not.toBeNull();
    expect(Math.abs((addressFieldBox?.x ?? 0) - (fieldBox?.x ?? 0))).toBeLessThanOrEqual(1);

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
    const purpleItem = settings.locator(byTestId('host-color-swatch-purple'));
    await expect(purpleItem).toBeVisible({ timeout: 10_000 });

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
    const itemBox = await purpleItem.boundingBox();
    const swatchBox = await purpleItem.locator('.color-picker__swatch').boundingBox();
    expect(itemBox).not.toBeNull();
    expect(swatchBox).not.toBeNull();
    expect(
      Math.abs(
        (swatchBox?.y ?? 0) +
          (swatchBox?.height ?? 0) / 2 -
          ((itemBox?.y ?? 0) + (itemBox?.height ?? 0) / 2),
      ),
    ).toBeLessThanOrEqual(2);

    await purpleItem.click();
    await expect(colorField).toHaveValue(/^#[0-9a-f]{6}$/i);
    const pickedHex = await colorField.inputValue();
    expect(pickedHex).not.toBe(defaultHex);
    await expect(colorPreview).toHaveCSS('background-color', hexToRgb(pickedHex));

    const purpleLabel = item.locator(`${byField('host-label')} input`);
    await purpleLabel.fill('Purple Server');
    const purpleAddress = item.locator(`${byField('host-address')} input`);
    await purpleAddress.fill('https://purple-server.example');
    // Committing the address creates the draft with the label and the picked
    // purple colour.
    await purpleAddress.press('Enter');

    // The draft is created once its address is valid; the colour survives the
    // snapshot round trip (the re-rendered field shows the stored swatch hex).
    const items = settings.locator('.multifield__item');
    const readDoc = () => {
      try {
        return readFileSync(settingsFile, 'utf8');
      } catch {
        return '';
      }
    };
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('https://purple-server.example');
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('"swatch"');
    await expect(items).toHaveCount(1, { timeout: 60_000 });
    await expect(items.first().locator('.color-picker input').first()).toHaveValue(pickedHex);

    // Typing a hex value directly - no menu interaction - also works.
    await settings.locator('.multifield__add').first().click();
    const customItem = items.last();
    await expect(items).toHaveCount(2);
    await customItem.locator('.color-picker input').first().fill('#123abc');
    await expect(customItem.locator('.color-picker__preview').first()).toHaveCSS(
      'background-color',
      hexToRgb('#123abc'),
    );
    await customItem.locator(`${byField('host-label')} input`).fill('Custom Colour Server');
    const customAddress = customItem.locator(`${byField('host-address')} input`);
    await customAddress.fill('https://custom-color-server.example');
    // Enter commits the custom hex, the label and the address together.
    await customAddress.press('Enter');

    await expect.poll(readDoc, { timeout: 60_000 }).toContain('"hex": "#123abc"');
    await expect(items.nth(1).locator('.color-picker input').first()).toHaveValue('#123abc', {
      timeout: 60_000,
    });
  } finally {
    await app.close();
  }
});
