import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { verticalGap } from '../support/e2e/layout';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byField, byTestId } from '../support/selectors';

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
    await expect(badge).toHaveCount(4);
    expect(await badge.first().evaluate((node) => node.shadowRoot !== null)).toBe(true);

    // The three folder actions line up as one column: equal widths, and the
    // Self-learning checkbox sits above the Memos folder action.
    const folderButtonIds = [
      'skills-open-folder',
      'rules-open-folder',
      'memos-open-folder',
    ] as const;
    const widths: number[] = [];
    for (const id of folderButtonIds) {
      const box = await panel.locator(byTestId(id)).boundingBox();
      widths.push(Math.round(box?.width ?? 0));
    }
    expect(new Set(widths).size).toBe(1);

    const selfLearningBox = await panel.locator(byField('memos-enabled')).boundingBox();
    const memosBox = await panel.locator(byTestId('memos-open-folder')).boundingBox();
    expect(selfLearningBox?.y ?? Number.NEGATIVE_INFINITY).toBeLessThan(
      memosBox?.y ?? Number.POSITIVE_INFINITY,
    );

    // The three subsections (skills, rules, memos pair) are separated by a
    // doubled gap; the pair's two rows keep the plain one. Asserted relationally
    // so neither exact value is pinned.
    const rows = panel.locator('.skills-section .field-label-row');
    const pairGap = await verticalGap(rows.nth(2), rows.nth(3));
    expect(await verticalGap(rows.nth(0), rows.nth(1))).toBeGreaterThan(pairGap);
    expect(await verticalGap(rows.nth(1), rows.nth(2))).toBeGreaterThan(pairGap);

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

    await panel.locator(byTestId('rules-open-folder')).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as Record<string, unknown>)['__openedPaths'] as string[]),
      )
      .toHaveLength(2);
    const openedPaths = await app.evaluate(
      () => (globalThis as Record<string, unknown>)['__openedPaths'] as string[],
    );
    expect(path.basename(openedPaths[1] ?? '')).toBe('rules');
    expect(existsSync(openedPaths[1] ?? '')).toBe(true);

    await panel.locator(byTestId('memos-open-folder')).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as Record<string, unknown>)['__openedPaths'] as string[]),
      )
      .toHaveLength(3);
    const withMemos = await app.evaluate(
      () => (globalThis as Record<string, unknown>)['__openedPaths'] as string[],
    );
    expect(path.basename(withMemos[2] ?? '')).toBe('memos');
    expect(existsSync(withMemos[2] ?? '')).toBe(true);

    const selfLearning = panel.locator(byField('memos-enabled'));
    await expect(selfLearning).toHaveJSProperty('checked', true);
    await selfLearning.click();
    const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
    await expect
      .poll(() => (existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : ''))
      .toMatch(/"memos"\s*:\s*\{\s*"enabled"\s*:\s*false/);
  } finally {
    await app.close();
  }
});
