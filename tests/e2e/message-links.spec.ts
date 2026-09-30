import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import type { ScriptedTurn } from '../../src/main/agents/fakeAgentService';
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
/**
 * Every browser navigation - including one a transcript link starts - is owned
 * by the browser pane, so a failed load is reported in the browser pane's
 * message row (with its Reload), never the chat pane's banner.
 */
const BROWSER_MESSAGE = '.browser-toolbar-message';
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

/** Replaces main's `shell.openExternal` with a recorder, so no real browser is launched. */
async function stubOpenExternal(app: ElectronApp): Promise<void> {
  await app.evaluate(({ shell }) => {
    const scope = globalThis as Record<string, unknown>;
    scope['__openedExternal'] = [] as string[];
    (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = (url) => {
      (scope['__openedExternal'] as string[]).push(url);
      return Promise.resolve();
    };
  });
}

function readOpenedExternal(app: ElectronApp): Promise<string[]> {
  return app.evaluate(
    () => ((globalThis as Record<string, unknown>)['__openedExternal'] as string[]) ?? [],
  );
}

test.describe('Message links open the AEM pane in edit mode', () => {
  test('an absolute link on a configured host opens its rendered page in the pane', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    await sendMessage(app, shell, `See [Alpha](${HOST}/content/site/alpha.html) for the page.`);

    const link = shell.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(link).toHaveCount(1, { timeout: 30_000 });
    await expect(link).toHaveAttribute('href', `${HOST}/content/site/alpha.html`, {
      timeout: 30_000,
    });

    // The click must reach the pane's real navigation path. The host does not
    // resolve, so the proof is the pane's own error banner naming the URL the
    // click asked for - not the absence of an error.
    await link.click();
    const banner = shell.locator(BROWSER_MESSAGE);
    await expect(banner).toHaveAttribute('open', '', { timeout: 60_000 });
    await expect(banner).toContainText(`${HOST}/content/site/alpha.html`, { timeout: 60_000 });

    await app.close();
  });

  test('a bare AEM path stays text until the pane is on a host, then becomes a page link', async () => {
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
    await expect(link).toHaveAttribute('href', `${HOST}/content/site/beta.html`);

    await app.close();
  });

  test('a page link offers Edit and CRX in one travelling hover popover', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    await sendMessage(app, shell, `See [Alpha](${HOST}/content/site/alpha.html).`);
    const link = shell.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(link).toHaveCount(1, { timeout: 30_000 });

    // The overlay is registered in the shipped bundle (jsdom cannot prove
    // this) and appears with exactly the two page actions.
    await link.hover();
    const overlay = shell.locator('sp-overlay');
    await expect(overlay).toHaveCount(1);
    const edit = shell.locator('sp-overlay sp-action-button[title="Edit"]');
    const crx = shell.locator('sp-overlay sp-action-button[title="CRX"]');
    await expect(edit).toBeVisible({ timeout: 30_000 });
    await expect(crx).toBeVisible();
    await expect
      .poll(() => overlay.evaluate((element) => (element as unknown as { open: boolean }).open))
      .toBe(true);

    // Edit drives the real pane navigation path; the unresolvable host makes
    // the resulting error banner the proof it reached it.
    await edit.click();
    const banner = shell.locator(BROWSER_MESSAGE);
    await expect(banner).toHaveAttribute('open', '', { timeout: 60_000 });
    await expect(banner).toContainText(`${HOST}/editor.html/content/site/alpha.html`, {
      timeout: 60_000,
    });

    await app.close();
  });

  test('a jcr:content link opens its owning page; Edit is trimmed but CRX keeps the resource, and no popover button takes focus', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    // Record every focus that lands inside the popover.
    await shell.evaluate(() => {
      const scope = window as unknown as { __popoverFocus: string[] };
      scope.__popoverFocus = [];
      document.addEventListener(
        'focusin',
        (event) => {
          const target = event.target as Element | null;
          if (target !== null && target.closest('sp-overlay') !== null) {
            scope.__popoverFocus.push(target.tagName);
          }
        },
        true,
      );
    });

    // First turn: CRX keeps the exact resource the message referenced - this is
    // the regression, since re-classifying the trimmed href retargeted it at the
    // page. Each popover interaction below is the first for its own message:
    // re-hovering one link after a click races the overlay's 200ms hide grace.
    await sendMessage(
      app,
      shell,
      `See [Resource](${HOST}/content/site/alpha/jcr:content/myComponent/2).`,
    );
    const resourceLink = shell.locator(`${ASSISTANT} a[data-daisy-link]`).last();
    await expect(shell.locator(`${ASSISTANT} a[data-daisy-link]`)).toHaveCount(1, {
      timeout: 30_000,
    });
    // The link itself opens the owning page, trimmed at /jcr:content.
    await expect(resourceLink).toHaveAttribute('href', `${HOST}/content/site/alpha.html`);

    await resourceLink.hover();
    const crx = shell.locator('sp-overlay sp-action-button[title="CRX"]');
    await expect(crx).toBeVisible({ timeout: 30_000 });

    // Prove the detector is not vacuous: a programmatic focus IS recorded, so
    // an empty record after the real click is evidence, not an untested pass.
    const detectorWorks = await shell.evaluate(() => {
      const scope = window as unknown as { __popoverFocus: string[] };
      const button = document.querySelector('sp-overlay sp-action-button[title="CRX"]');
      (button as HTMLElement | null)?.focus();
      const recorded = scope.__popoverFocus.length;
      (document.activeElement as HTMLElement | null)?.blur?.();
      scope.__popoverFocus.length = 0;
      return recorded;
    });
    expect(detectorWorks).toBeGreaterThan(0);

    await crx.click();
    const banner = shell.locator(BROWSER_MESSAGE);
    await expect(banner).toHaveAttribute('open', '', { timeout: 60_000 });
    await expect(banner).toContainText(
      `${HOST}/crx/de/index.jsp#/content/site/alpha/jcr:content/myComponent/2`,
      { timeout: 60_000 },
    );

    // Second turn: Edit opens the owning page's editor (trimmed).
    await sendMessage(app, shell, `Also [Resource2](${HOST}/content/site/beta/jcr:content/x).`);
    const secondLink = shell.locator(`${ASSISTANT} a[data-daisy-link]`).last();
    await expect(shell.locator(`${ASSISTANT} a[data-daisy-link]`)).toHaveCount(2, {
      timeout: 30_000,
    });
    await expect(secondLink).toHaveAttribute('href', `${HOST}/content/site/beta.html`);

    await secondLink.hover();
    const edit = shell.locator('sp-overlay sp-action-button[title="Edit"]');
    await expect(edit).toBeVisible({ timeout: 30_000 });
    await edit.click();
    await expect(banner).toContainText(`${HOST}/editor.html/content/site/beta.html`, {
      timeout: 60_000,
    });

    // No popover button ever received focus.
    await expect
      .poll(() =>
        shell.evaluate(() => (window as unknown as { __popoverFocus: string[] }).__popoverFocus),
      )
      .toEqual([]);

    await app.close();
  });

  test('a jcr:content path is percent-encoded in the URL the pane loads', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    await sendMessage(app, shell, `See [Apps](${HOST}/apps/x/jcr:content/y).`);
    const link = shell.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(link).toHaveCount(1, { timeout: 30_000 });
    await expect(link).toHaveAttribute('href', `${HOST}/apps/x/jcr%3Acontent/y`);

    // The unresolvable host makes the pane's error banner the proof the encoded
    // URL is what actually reached the load path.
    await link.click();
    const banner = shell.locator(BROWSER_MESSAGE);
    await expect(banner).toHaveAttribute('open', '', { timeout: 60_000 });
    await expect(banner).toContainText(`${HOST}/apps/x/jcr%3Acontent/y`, { timeout: 60_000 });

    await app.close();
  });

  test('an external link opens in the system browser, not the pane', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    await stubOpenExternal(app);
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    await sendMessage(app, shell, 'See [External](https://external.example/page).');
    const link = shell.locator(`${ASSISTANT} a[data-daisy-external]`);
    await expect(link).toHaveCount(1, { timeout: 30_000 });
    await expect(link).toHaveAttribute('href', 'https://external.example/page');
    await expect(link).toHaveAttribute('title', 'Opens in your browser');

    await link.click();

    await expect.poll(() => readOpenedExternal(app)).toEqual(['https://external.example/page']);
    // No pane navigation, so no error banner.
    await expect(shell.locator(CHAT_STATUS_BANNER)).not.toHaveAttribute('open', '');

    await app.close();
  });
});
