import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

/**
 * Every Settings field carries an `sp-contextual-help` badge
 * (`settings/fieldHelp.ts`; AGENTS.md section 5). Only the real built app can
 * prove it: jsdom renders the tag as an inert `HTMLUnknownElement`, so the
 * registration in `main.ts`, the component's shadow root, its placement
 * immediately after the field's label, its understated styling, and its opening
 * popover are all asserted here head-on.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-context-help-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test('Settings fields carry registered contextual-help badges whose popovers open', async () => {
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
    await settings.locator('sp-action-button[title="Settings"]').first().click();
    await settings
      .locator('.settings-panel')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    // The component itself is genuinely registered and upgraded.
    expect(
      await settings.evaluate(() => customElements.get('sp-contextual-help') !== undefined),
    ).toBe(true);

    // The Browser tab's two fields always render, even on a fresh profile.
    await settings.locator('sp-tab', { hasText: 'Browser' }).click();
    const browserSection = settings.locator('.settings-panel .browser-section');
    await expect(browserSection).toBeVisible();

    const badges = browserSection.locator('sp-contextual-help');
    await expect(badges).toHaveCount(2);
    expect(await badges.first().evaluate((node) => node.shadowRoot !== null)).toBe(true);
    await expect(badges.first()).toHaveAttribute('label', 'Help: Default proxy');
    await expect(badges.nth(1)).toHaveAttribute(
      'label',
      'Help: Suppress the Windows security-key prompt',
    );

    // The badge sits immediately after the label's text, with only the row's
    // small gap between - never pushed to the far right of the column.
    const placement = await badges.first().evaluate((node) => {
      const row = node.closest('.field-label-row');
      const label = row?.querySelector('sp-field-label');
      if (!row || !label) return { labelToBadge: -1, badgeToRowEnd: -1 };
      const labelBox = label.getBoundingClientRect();
      const badgeBox = node.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return {
        labelToBadge: badgeBox.left - labelBox.right,
        badgeToRowEnd: rowBox.right - badgeBox.right,
      };
    });
    expect(placement.labelToBadge).toBeGreaterThanOrEqual(0);
    expect(placement.labelToBadge).toBeLessThanOrEqual(12);
    expect(placement.badgeToRowEnd).toBeGreaterThan(20);

    // Understated at rest: 80% scale, 70% opacity.
    const styling = await badges.first().evaluate((node) => {
      const style = getComputedStyle(node);
      return { transform: style.transform, opacity: style.opacity };
    });
    expect(styling.opacity).toBe('0.7');
    expect(styling.transform).toContain('0.8');

    // The one hover cue is returning to full opacity; the fill never changes.
    const badgeOpacity = (): Promise<string> =>
      badges.first().evaluate((node) => getComputedStyle(node).opacity);
    const triggerBackground = (): Promise<string> =>
      badges
        .first()
        .locator('#trigger')
        .evaluate((node) => getComputedStyle(node).backgroundColor);
    const restingBackground = await triggerBackground();
    await badges.first().locator('#trigger').hover();
    await expect.poll(badgeOpacity).toBe('1');
    expect(await triggerBackground()).toBe(restingBackground);
    expect(restingBackground).toBe('rgba(0, 0, 0, 0)');

    // Clicking the badge opens its popover. The phrase itself is light DOM
    // (slotted into the popover), so its presence is asserted in the unit
    // tests; here we prove the real component actually opens.
    await badges.first().locator('#trigger').click();
    await expect(badges.first().locator('#trigger')).toHaveAttribute('aria-expanded', 'true');
    await expect(badges.first().locator('sp-overlay[open]')).toHaveCount(1);
    await expect(badges.first().locator('sp-popover')).toBeVisible();

    // The popover lives in the native top layer, which escapes the badge's
    // transform - so the help text is never scaled with the badge.
    const popoverRatio = await badges
      .first()
      .locator('sp-popover')
      .evaluate((node) => node.getBoundingClientRect().width / (node as HTMLElement).offsetWidth);
    expect(popoverRatio).toBeGreaterThan(0.99);
  } finally {
    await app.close();
  }
});
