import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { FAKE_AGENT_SERVICE_ENV_VAR } from '../../src/main/agentComposition';

/**
 * The History panel, proven against the real built app.
 *
 * The list is derived from real journal files on disk and the panel is a
 * Spectrum/DOM surface over the suspended native view, so neither is provable
 * in jsdom. The deterministic fake agent service is used (the same switch
 * `chat-restore.spec.ts` uses), so no Copilot sign-in is needed and the SDK
 * "resume" always succeeds.
 *
 * Flow: one host; send a first prompt; start a New session and send a second;
 * open History and assert both rows (title, host, date); Resume the first and
 * assert its transcript returns; delete the second (in-place confirm) and
 * assert the row is gone.
 *
 *   npm run build
 *   npx playwright test tests/e2e/history.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'history-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function createProfile(): Record<string, string> {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    ...definedEnv(process.env),
    USERPROFILE: home,
    HOME: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    [FAKE_AGENT_SERVICE_ENV_VAR]: '1',
  };
}

function writeSettings(home: string, settings: unknown): void {
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

async function waitForComposerReady(page: Page): Promise<void> {
  await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(page.locator('.chat-status-banner')).not.toHaveAttribute('open', '', {
    timeout: 60_000,
  });
  await expect(page.locator('.chat-composer__send')).not.toHaveAttribute('disabled', '', {
    timeout: 60_000,
  });
}

async function sendViaComposer(page: Page, prompt: string): Promise<void> {
  await page.locator('.chat-composer textarea').fill(prompt);
  await page.locator('.chat-composer__send').click();
  await expect(page.locator('.chat-message--user')).toContainText(prompt, { timeout: 30_000 });
}

function row(page: Page, text: string) {
  return page.locator('.history-item', { hasText: text });
}

test.describe('History panel', () => {
  test('lists stored conversations, resumes one, and deletes another', async () => {
    test.setTimeout(180_000);
    const env = createProfile();
    const home = env['USERPROFILE'] ?? '';

    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>echo</title><p>ok</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    const base = defaultAppSettings();
    writeSettings(
      home,
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
      await page.locator(`.hosts-item[data-origin="${origin}"]`).click();
      await waitForComposerReady(page);

      // Two conversations, so History has something to distinguish.
      await sendViaComposer(page, 'first question about media');
      await page.locator('[title="New session"]').click();
      await expect(page.locator('.chat-message--user')).toHaveCount(0, { timeout: 30_000 });
      await sendViaComposer(page, 'second question about assets');

      // The History button opens the panel; both chats are listed, newest first.
      await page.locator('.chat-toolbar sp-action-button[aria-label="History"]').click();
      await expect(page.locator('.history-panel')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.history-item')).toHaveCount(2, { timeout: 30_000 });

      const firstRow = row(page, 'first question about media');
      const secondRow = row(page, 'second question about assets');
      await expect(firstRow).toBeVisible();
      await expect(secondRow).toBeVisible();
      // Each row carries a formatted start date. The host is the server that
      // was active when the chat *opened*: the first chat opened at startup
      // before any host was picked, so its row has no host chip at all (omitted,
      // not shown as a placeholder); the second opened after the page loaded,
      // so it names Echo.
      await expect(firstRow.locator('.history-item__date')).not.toBeEmpty();
      await expect(firstRow.locator('.history-item__server')).toHaveCount(0);
      await expect(secondRow.locator('.history-item__server-label')).toHaveText('Echo');

      // Resume is an icon button wearing the replay glyph, and the glyph is a
      // *registered* custom element - not an unknown tag (which jsdom cannot
      // prove, so it is asserted here against the built app).
      await expect(firstRow.locator('.history-item__resume sp-icon-replay')).toHaveCount(1);
      expect(await page.evaluate(() => customElements.get('sp-icon-replay') !== undefined)).toBe(
        true,
      );

      // Newest first: the second chat sits above the first.
      const order = await page.locator('.history-item__title').allInnerTexts();
      expect(order[0]).toContain('second question about assets');

      // Resume the first: the panel closes and its transcript returns.
      await firstRow.locator('.history-item__resume').click();
      await expect(page.locator('.history-panel')).not.toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.chat-message--user')).toContainText(
        'first question about media',
        {
          timeout: 30_000,
        },
      );

      // Delete the second: an in-place confirm, then the row is gone.
      await page.locator('.chat-toolbar sp-action-button[aria-label="History"]').click();
      await expect(page.locator('.history-panel')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.history-item')).toHaveCount(2, { timeout: 30_000 });
      await secondRow.locator('.history-item__delete').click();
      // The confirmation names its buttons OK and Cancel.
      await expect(secondRow.locator('.history-item__confirm-delete')).toHaveText('OK');
      await expect(secondRow.locator('.history-item__confirm-cancel')).toHaveText('Cancel');
      await secondRow.locator('.history-item__confirm-delete').click();
      await expect(page.locator('.history-item')).toHaveCount(1, { timeout: 30_000 });
      await expect(row(page, 'second question about assets')).toHaveCount(0);
      await expect(row(page, 'first question about media')).toBeVisible();
    } finally {
      await app.close();
      server.close();
    }
  });
});
