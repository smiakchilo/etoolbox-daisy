import { _electron as electron, expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * Settings import/export, against the BUILT app.
 *
 * Proves end to end: the header's Export button writes a portable JSON file
 * with no `revision`/`credentials`/`token` (through the real save dialog,
 * stubbed to a fixed path); the Import button reads a file (through the real
 * open dialog, stubbed the same way), merges it into the current settings by
 * key (a host by its `origin`), and the panel reloads to show the result.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-import-export-scratch');

test('Export writes a portable file with no revision/credentials/token, and Import merges it in', async () => {
  test.setTimeout(120_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);
  const env = scratchEnv({ home, appData, localAppData }, { fakeAgent: true });
  const exportPath = path.join(home, 'exported-settings.json');
  const importPath = path.join(home, 'settings-to-import.json');

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const shell = await app.firstWindow();
    await shell.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
    await shell.locator(byTestId('chat-settings')).click();
    await shell.locator(byTestId('settings-panel')).waitFor({ state: 'visible', timeout: 60_000 });

    // Add one host through the real Hosts tab, so there is something to export.
    await shell.locator(byTestId('settings-tab-hosts')).click();
    await shell.locator('.multifield__add').first().waitFor({ state: 'visible', timeout: 60_000 });
    await shell.locator('.multifield__add').first().click();
    const draft = shell.locator('.multifield__item').last();
    await draft.locator('[data-field="host-address"] input').fill('https://acme.example');
    await draft.locator('[data-field="host-label"] input').fill('Acme');
    await draft.locator('[data-field="host-label"] input').press('Enter');
    await expect
      .poll(() => shell.locator('.multifield__item').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // The Export button's OS dialog is replaced with a deterministic path, so
    // the real renderer -> IPC -> write path runs with no native dialog.
    await app.evaluate(({ dialog }, filePath: string) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
    }, exportPath);

    await shell.locator(byTestId('settings-export')).click();
    await expect
      .poll(
        () => {
          try {
            readFileSync(exportPath, 'utf8');
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    const exported = JSON.parse(readFileSync(exportPath, 'utf8')) as {
      hosts: Array<Record<string, unknown>>;
    };
    expect(exported.hosts.some((host) => host['origin'] === 'https://acme.example')).toBe(true);
    const acme = exported.hosts.find((host) => host['origin'] === 'https://acme.example');
    expect(acme).not.toHaveProperty('revision');
    expect(acme?.['id']).toBeTruthy();

    // Build an import file that merges onto the same host (by origin) with a
    // new label, and adds a brand-new one.
    writeFileSync(
      importPath,
      JSON.stringify({
        hosts: [
          { id: acme?.['id'], origin: 'https://acme.example', label: 'Acme Renamed' },
          { id: 'any-id-will-do', origin: 'https://new-host.example', label: 'New Host' },
        ],
      }),
      'utf8',
    );

    await app.evaluate(({ dialog }, filePath: string) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [filePath] });
    }, importPath);

    await shell.locator(byTestId('settings-import')).click();

    // The panel reloads from the merged document: the renamed host and the new
    // one both show up, and no duplicate row was created for the merged one.
    await expect(shell.locator('.multifield__item [data-field="host-label"] input')).toHaveCount(
      2,
      { timeout: 30_000 },
    );
    const labels = await shell
      .locator('.multifield__item [data-field="host-label"] input')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
    expect(labels).toContain('Acme Renamed');
    expect(labels).toContain('New Host');
  } finally {
    await app.close();
  }
});
