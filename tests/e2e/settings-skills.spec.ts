import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * The Settings "Skills" tab against the built app: the tab exists after Agents,
 * its help badge is a real registered element, and the **Custom skills folder**
 * control makes main create the folder and hand it to the OS file manager. The
 * file manager is replaced in main so no window opens.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-skills-scratch');

test('the Skills tab opens the custom skills folder through main', async () => {
  test.setTimeout(120_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);
  const env = scratchEnv({ home, appData, localAppData });

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const shell = await app.firstWindow();
    await shell.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
    await shell.locator(byTestId('chat-settings')).click();
    await shell
      .locator(byTestId('settings-panel'))
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    await app.evaluate(({ shell: electronShell }) => {
      const opened: string[] = [];
      (globalThis as Record<string, unknown>)['__openedPaths'] = opened;
      electronShell.openPath = (target: string) => {
        opened.push(target);
        return Promise.resolve('');
      };
    });

    const tabIds = await shell
      .locator('.settings-panel__tabs sp-tab')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
    expect(tabIds.indexOf('settings-tab-skills')).toBe(tabIds.indexOf('settings-tab-agents') + 1);

    await shell.locator(byTestId('settings-tab-skills')).click();
    const panel = shell.locator('.settings-panel__tab-panel[selected]');
    const badge = panel.locator('sp-contextual-help');
    await expect(badge).toHaveCount(1);
    expect(await badge.evaluate((node) => node.shadowRoot !== null)).toBe(true);

    await panel.locator(byTestId('skills-open-folder')).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as Record<string, unknown>)['__openedPaths'] as string[]),
      )
      .toHaveLength(1);

    const [opened] = await app.evaluate(
      () => (globalThis as Record<string, unknown>)['__openedPaths'] as string[],
    );
    expect(path.basename(opened ?? '')).toBe('skills');
    expect(existsSync(opened ?? '')).toBe(true);
  } finally {
    await app.close();
  }
});
