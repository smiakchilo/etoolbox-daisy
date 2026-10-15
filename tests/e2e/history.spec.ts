import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';

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
 * assert its transcript returns; delete the second (confirmed in the pane's
 * alert banner) and assert the row is gone.
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

/** The journal files a profile has written, under `<home>/etoolbox-daisy/chats`. */
function journalFiles(home: string): readonly string[] {
  const dir = path.join(home, 'etoolbox-daisy', 'chats');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name));
}

/** Every `sdkSessionId` the live fake agent was asked to delete, in order. */
function readDeletedSessionIds(app: ElectronApplication): Promise<readonly string[]> {
  return app.evaluate((_electronNamespace, globalKey: string) => {
    const fake = (globalThis as Record<string, unknown>)[globalKey] as {
      readonly deletedSessionIds: () => readonly string[];
    };
    return fake.deletedSessionIds();
  }, TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY);
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
      // Each row carries a formatted start date and the host the chat was first
      // *used* on. The first chat's header was still deferred when it was opened
      // at startup (before any host was picked), so it takes the host its first
      // prompt named; the second opened after the page loaded, so it names Echo
      // too.
      await expect(firstRow.locator('.history-item__date')).not.toBeEmpty();
      await expect(firstRow.locator('.history-item__server-label')).toHaveText('Echo');
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

      // Delete the second: the confirmation is the pane's one-button alert
      // banner (the same prompt Settings uses for a removal), never a
      // row-local dialog.
      await page.locator('.chat-toolbar sp-action-button[aria-label="History"]').click();
      await expect(page.locator('.history-panel')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.history-item')).toHaveCount(2, { timeout: 30_000 });
      await secondRow.locator('.history-item__delete').click();
      const confirmBanner = page.locator('.surface-status-banner[open]');
      // The one-button confirmation names its action; the button reads OK.
      await expect(confirmBanner).toContainText('Press OK to delete the conversation');
      const confirmOk = confirmBanner.locator('sp-action-button');
      await expect(confirmOk).toHaveText('OK');
      await confirmOk.click();
      await expect(page.locator('.history-item')).toHaveCount(1, { timeout: 30_000 });
      await expect(row(page, 'second question about assets')).toHaveCount(0);
      await expect(row(page, 'first question about media')).toBeVisible();
      // The outcome takes the same banner row after the confirmation clears.
      await expect(page.locator('.surface-status-banner')).toContainText('Conversation deleted');
    } finally {
      await app.close();
      server.close();
    }
  });

  test('deleting a chat whose journal recorded several sessions removes every session', async () => {
    test.setTimeout(180_000);
    const env = createProfile();
    const home = env['USERPROFILE'] ?? '';

    const app = await electron.launch({ args: [mainEntry], env });
    try {
      const page = await app.firstWindow();
      await waitForComposerReady(page);
      await sendViaComposer(page, 'a chat that will be recycled');

      // This chat now has one journal, whose header names its first SDK session.
      const journalPaths = journalFiles(home);
      expect(journalPaths).toHaveLength(1);
      const journalPath = journalPaths[0];
      if (journalPath === undefined) throw new Error('no journal was written');
      const records = readFileSync(journalPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const header = records.find((record) => record['recordType'] === 'header');
      const chatId = header?.['chatId'];
      const headerSession = header?.['sdkSessionId'];
      if (typeof chatId !== 'string' || typeof headerSession !== 'string') {
        throw new Error('the journal has no header');
      }

      // A runtime recycle re-opens the same chat under a new SDK session; this
      // is the exact record `chatJournal.openChat` appends for it. The fake
      // cannot recycle itself (its `reconcile` is deliberately inert), so the
      // second session is written here rather than driven through Settings -
      // the point under test is deletion, not how the record came to exist.
      const recycledSession = 'sdk-recycled-e2e';
      appendFileSync(
        journalPath,
        JSON.stringify({
          recordType: 'session.opened',
          at: Date.now(),
          chatId,
          sdkSessionId: recycledSession,
        }) + '\n',
        'utf8',
      );

      // Delete the chat through History.
      await page.locator('.chat-toolbar sp-action-button[aria-label="History"]').click();
      await expect(page.locator('.history-panel')).toBeVisible({ timeout: 30_000 });
      const target = row(page, 'a chat that will be recycled');
      // No host was configured or picked in this profile, so the chat stayed
      // host-less and its row shows no host chip at all (omitted, never a
      // placeholder).
      await expect(target.locator('.history-item__server')).toHaveCount(0);
      await target.locator('.history-item__delete').click();
      await page.locator('.surface-status-banner[open] sp-action-button').click();
      await expect(page.locator('.history-item')).toHaveCount(0, { timeout: 30_000 });

      // The stored transcript is gone...
      expect(existsSync(journalPath)).toBe(false);
      // ...and the SDK was asked to delete *both* sessions, in journal order.
      expect(await readDeletedSessionIds(app)).toEqual([headerSession, recycledSession]);
    } finally {
      await app.close();
    }
  });
});
