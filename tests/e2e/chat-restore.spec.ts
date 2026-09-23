import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { FAKE_AGENT_SERVICE_ENV_VAR } from '../../src/main/agentComposition';

/**
 * The chat pane's remembered conversation, proven across a full quit and
 * relaunch against the real built app.
 *
 * Only `localStorage` persistence and the real journal files survive a restart,
 * so neither the pointer nor the replay is provable in jsdom. The deterministic
 * fake agent service is used (the same switch `step07-agent-chat.spec.ts` uses),
 * so no Copilot sign-in is needed and the SDK "resume" always succeeds.
 *
 * Flow: seed one configured host; run 1 loads its page, sends one prompt, and
 * quits; run 2 must reopen the same page, resume the same conversation, and
 * repaint the prompt from the journal.
 *
 *   npm run build
 *   npx playwright test tests/e2e/chat-restore.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'chat-restore-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A profile directory both launches share - localStorage, the journal and window state live under it. */
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
    // The deterministic fake, not the real Copilot SDK adapter.
    [FAKE_AGENT_SERVICE_ENV_VAR]: '1',
  };
}

function writeSettings(home: string, settings: unknown): void {
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function addressBarValue(page: Page): Promise<string> {
  return page
    .locator('#browser-address-bar')
    .evaluate((element) => (element as unknown as { value: string }).value);
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
}

test.describe('chat restore across a relaunch', () => {
  test('reopens the remembered conversation and repaints it', async () => {
    test.setTimeout(180_000);
    const env = createProfile();
    const home = env['USERPROFILE'] ?? '';

    const hits = { count: 0 };
    const server: Server = createServer((_req, res) => {
      hits.count += 1;
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

    const prompt = 'remember this question';

    // --- run 1: load the host's page, send one prompt, then quit --------------
    const first = await electron.launch({ args: [mainEntry], env });
    const firstPage = await first.firstWindow();
    await firstPage.locator(`.hosts-item[data-origin="${origin}"]`).click();
    await expect.poll(() => hits.count > 0, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => addressBarValue(firstPage), { timeout: 30_000 }).toContain(origin);
    await waitForComposerReady(firstPage);

    await sendViaComposer(firstPage, prompt);
    await expect(firstPage.locator('.chat-message--user')).toContainText(prompt, {
      timeout: 30_000,
    });
    await first.close();

    // --- run 2: both the page and the conversation are restored --------------
    const second = await electron.launch({ args: [mainEntry], env });
    const secondPage = await second.firstWindow();
    // The page is reopened without the startup hosts picker...
    await expect.poll(() => addressBarValue(secondPage), { timeout: 30_000 }).toContain(origin);
    await expect(secondPage.locator(`.hosts-item[data-origin="${origin}"]`)).not.toBeVisible();
    // ...and the previously sent prompt is repainted from the journal, proving
    // the conversation was resumed rather than started fresh.
    await expect(secondPage.locator('.chat-message--user')).toContainText(prompt, {
      timeout: 30_000,
    });

    await second.close();
    server.close();
  });
});
