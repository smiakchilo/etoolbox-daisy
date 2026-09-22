import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import type { ScriptedTurn } from '../../src/agent/fakeAgentService';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';

/**
 * Message links (owner request, 2026-09-22): an assistant message's `http(s)`
 * link on a configured AEM host, or a bare AEM-native path (`/content`,
 * `/apps`, ...), must become a real anchor that opens the AEM pane in edit
 * mode.
 *
 * Proven against the REAL shipped `out/main/index.js` and renderer bundle -
 * not jsdom - because the pieces this feature adds are exactly the ones a
 * unit test cannot vouch for end to end:
 *
 *  - the settings snapshot reaching `chatPane.setLinkContext` (host origins),
 *  - the browser pane's own `browser:state-changed` push setting the active
 *    origin, and
 *  - a real click on a real anchor being routed through
 *    `window.daisy.browser.navigate` to a genuine AEM navigation attempt.
 *
 * No AEM server is required: a host at a reserved, never-resolving origin is
 * enough to prove the link is resolved and the click reaches navigation. The
 * network failure that follows is the proof the click worked, and the pane's
 * error banner is the user-visible form of it.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/message-links.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'message-links-scratch');
const HOST = 'https://aem.example.invalid';

const CHAT_STATUS_BANNER = '.chat-status-banner';
const COMPOSER_SEND = '.chat-composer__send';
const COMPOSER_FIELD = '.chat-composer textarea';
const ASSISTANT = '.chat-message--assistant';

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

/** Seeds a profile whose single configured host is {@link HOST}, then launches the built app. */
async function launchWithHost(): Promise<ElectronApp> {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: randomUUID(),
        label: 'Link fixture',
        origin: HOST,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
    ],
  });
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(seeded, null, 2), 'utf8');

  return electron.launch({
    args: [mainEntry],
    env: {
      ...definedEnv(process.env),
      USERPROFILE: home,
      HOME: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      [FAKE_AGENT_SERVICE_ENV_VAR]: '1',
    },
  });
}

function scriptTurn(app: ElectronApp, turn: ScriptedTurn): Promise<void> {
  const payload = JSON.stringify({ globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY, turn });
  return app.evaluate((_electronNamespace, json: string) => {
    const arg = JSON.parse(json) as { globalKey: string; turn: unknown };
    const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
      readonly scriptNextResponse: (t: unknown) => void;
    };
    fake.scriptNextResponse(arg.turn);
  }, payload);
}

async function flushFake(app: ElectronApp): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    const delivered = await app.evaluate((_electronNamespace, key: string) => {
      const fake = (globalThis as Record<string, unknown>)[key] as {
        readonly advance: () => boolean;
      };
      return fake.advance();
    }, TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY);
    if (!delivered) return;
  }
  throw new Error('flushFake exceeded its guard - the fake never drained.');
}

async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(shell.locator(CHAT_STATUS_BANNER)).not.toHaveAttribute('open', '', {
    timeout: 60_000,
  });
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '', {
    timeout: 60_000,
  });
}

async function sendMessage(app: ElectronApp, shell: Page, text: string): Promise<void> {
  await scriptTurn(app, { steps: [{ kind: 'delta', text }] });
  await shell.locator(COMPOSER_FIELD).fill('link please');
  await shell.locator(COMPOSER_SEND).click();
  await flushFake(app);
}

test.describe('Message links open the AEM pane in edit mode', () => {
  test('an absolute link on a configured host is rewritten to the editor and opens the pane', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    await sendMessage(app, shell, `See [Alpha](${HOST}/content/site/alpha.html) for the page.`);

    const link = shell.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(link).toHaveCount(1, { timeout: 30_000 });
    await expect(link).toHaveAttribute('href', `${HOST}/editor.html/content/site/alpha.html`, {
      timeout: 30_000,
    });

    // The click must reach the pane's real navigation path. The host does not
    // resolve, so the proof is the pane's own error banner naming the URL the
    // click asked for - not the absence of an error.
    await link.click();
    const banner = shell.locator(CHAT_STATUS_BANNER);
    await expect(banner).toHaveAttribute('open', '', { timeout: 60_000 });
    await expect(banner).toContainText(`${HOST}/editor.html/content/site/alpha.html`, {
      timeout: 60_000,
    });

    await app.close();
  });

  test('a bare AEM path stays text until the pane is on a host, then becomes an editor link', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    // With no page loaded, the pane has no active host: the bare path must be
    // plain text (owner decision: "do not convert relative paths to links if
    // none").
    await sendMessage(app, shell, 'Look at /content/site/beta when you can.');
    await expect(shell.locator(`${ASSISTANT}`)).toContainText('/content/site/beta', {
      timeout: 30_000,
    });
    await expect(shell.locator(`${ASSISTANT} a[data-daisy-link]`)).toHaveCount(0);

    // Put the pane on the host. The load fails, but the attempted navigation
    // is what makes the host "active" - exactly the state a real AEM page
    // would leave it in.
    const addressInput = shell.locator('#browser-address-bar input');
    await addressInput.fill(HOST);
    await addressInput.press('Enter');
    await expect(shell.locator('sp-alert-banner.browser-toolbar-message')).toHaveAttribute(
      'open',
      '',
      { timeout: 60_000 },
    );

    // The same already-rendered message must repaint with the path now
    // clickable - no new message, no text change.
    const link = shell.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(link).toHaveCount(1, { timeout: 30_000 });
    await expect(link).toHaveAttribute('href', `${HOST}/editor.html/content/site/beta.html`);

    await app.close();
  });
});
