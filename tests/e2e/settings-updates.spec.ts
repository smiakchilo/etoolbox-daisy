import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byField, byTestId } from '../support/selectors';

/**
 * The Settings "Updates" tab against the built app, end to end: the tab is last,
 * **Update** is hidden until a check finds something, and applying an update
 * hands the install script the offered source. A full-archive source needs no
 * network to "find" (it is always offered), and a development build is not an
 * installed one, so applying it fails cleanly before any build starts - which is
 * exactly what this spec relies on to stay hermetic.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-updates-scratch');

test('the Updates tab offers a source, and applying it on a non-installed build fails cleanly', async () => {
  test.setTimeout(180_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);
  const archiveUrl = 'https://example.invalid/etoolbox-daisy-source.zip';

  const app = await electron.launch({
    args: [mainEntry],
    env: scratchEnv({ home, appData, localAppData }),
  });
  try {
    const shell = await app.firstWindow();
    await shell.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
    await shell.locator(byTestId('chat-settings')).click();
    await shell
      .locator(byTestId('settings-panel'))
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    const tabIds = await shell
      .locator('.settings-panel__tabs sp-tab')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
    expect(tabIds.at(-1)).toBe('settings-tab-updates');

    await shell.locator(byTestId('settings-tab-updates')).click();
    const panel = shell.locator('.settings-panel__tab-panel[selected]');
    const badges = panel.locator('sp-contextual-help');
    await expect(badges).toHaveCount(2);
    expect(await badges.first().evaluate((node) => node.shadowRoot !== null)).toBe(true);

    const checkButton = panel.locator(byTestId('updates-check'));
    const applyButton = panel.locator(byTestId('updates-apply'));
    await expect(checkButton).toBeVisible();
    await expect(applyButton).toBeHidden();

    // Check, then the startup checkbox, then the source; the checkbox is set
    // apart from the button line by a gap.
    const startupBox = await panel.locator(byField('updates-check-on-startup')).boundingBox();
    const sourceBox = await panel.locator(byField('updates-source')).boundingBox();
    const buttonBox = await checkButton.boundingBox();
    expect(buttonBox?.y ?? 0).toBeLessThan(startupBox?.y ?? 0);
    expect(startupBox?.y ?? 0).toBeLessThan(sourceBox?.y ?? 0);
    expect((startupBox?.y ?? 0) - ((buttonBox?.y ?? 0) + (buttonBox?.height ?? 0))).toBeGreaterThan(
      16,
    );

    const sourceInput = panel.locator(byField('updates-source') + ' input');
    await sourceInput.fill(archiveUrl);
    await sourceInput.press('Enter');
    const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
    await expect
      .poll(() => (existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : ''))
      .toContain(archiveUrl);

    await checkButton.click();
    await expect(applyButton).toBeVisible({ timeout: 30_000 });
    // The reader asked for this check and sees its answer right here: the chat
    // pane's fallback notice must not fire for a check they started.
    await expect(shell.locator(byTestId('banner-update-details'))).toHaveCount(0);
    // The check button and the Update button share one line, in different fills.
    const fillOf = (node: HTMLElement) => getComputedStyle(node).backgroundColor;
    expect(await applyButton.evaluate(fillOf)).not.toBe(await checkButton.evaluate(fillOf));
    const checkBox = await checkButton.boundingBox();
    const applyBox = await applyButton.boundingBox();
    expect(Math.abs((checkBox?.y ?? 0) - (applyBox?.y ?? 1000))).toBeLessThan(8);

    await applyButton.click();
    await shell.locator(`.surface-status-banner[open] ${byTestId('banner-confirm')}`).click();

    // A development build has no install script to hand the source to, so the
    // attempt fails and the offer is withdrawn until the next check. The reason
    // lands in the pane's status row (which outlives the panel), and the label
    // beside Check is cleared rather than repeating it.
    await expect(applyButton).toBeHidden({ timeout: 30_000 });
    await expect(shell.locator('.surface-status-banner[open]')).not.toHaveText('');
    await expect(panel.locator(byTestId('updates-status'))).toHaveText('');
  } finally {
    await app.close();
  }
});
