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

  test('a message link dismisses an open Settings panel so the page is visible', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    await sendMessage(app, shell, `See [Alpha](${HOST}/content/site/alpha.html).`);
    const link = shell.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(link).toHaveCount(1, { timeout: 30_000 });

    // Open Settings so it covers the pane's page-view region.
    const settingsPanel = shell.locator('.settings-panel');
    await shell.locator('sp-action-button[title="Settings"]').first().click();
    await expect(settingsPanel).toBeVisible({ timeout: 30_000 });

    // Clicking the link starts an externally-caused navigation, which must
    // dismiss the covering panel so the newly opened page is visible; the
    // unresolvable host then makes the pane's error banner the proof the
    // navigation actually ran.
    await link.click();
    await expect(settingsPanel).toBeHidden({ timeout: 30_000 });
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

  test('a bare AEM path inside inline code or a fenced block becomes a link too', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    // Put the pane on the host so a relative path resolves (the load fails, but
    // the attempt is what makes the origin active).
    const addressInput = shell.locator('#browser-address-bar input');
    await addressInput.fill(HOST);
    await addressInput.press('Enter');
    await expect(shell.locator('sp-alert-banner.browser-toolbar-message')).toHaveAttribute(
      'open',
      '',
      { timeout: 60_000 },
    );

    // Owner request (2026-10-08): the model writes JCR paths inside inline code
    // and fenced blocks; a path matching the roots must be a link wherever it
    // appears, exactly as if it were bare prose.
    await sendMessage(
      app,
      shell,
      '**Node:** `/content/site/beta/jcr:content`\n\n```\n/content/site/gamma\n```',
    );

    const links = shell.locator(`${ASSISTANT} code a[data-daisy-link]`);
    await expect(links).toHaveCount(2, { timeout: 30_000 });
    // Inline code: opens the owning page, trimmed at /jcr:content.
    await expect(links.nth(0)).toHaveAttribute('href', `${HOST}/content/site/beta.html`);
    // Fenced block: the same page link a bare path would get.
    await expect(links.nth(1)).toHaveAttribute('href', `${HOST}/content/site/gamma.html`);

    // The click must still reach the pane's real navigation path.
    await links.nth(0).click();
    const banner = shell.locator(BROWSER_MESSAGE);
    await expect(banner).toContainText(`${HOST}/content/site/beta.html`, { timeout: 60_000 });

    await app.close();
  });

  test('a markdown table of long path links wraps instead of widening the transcript', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    // Put the pane on the host so the table's bare paths linkify.
    const addressInput = shell.locator('#browser-address-bar input');
    await addressInput.fill(HOST);
    await addressInput.press('Enter');
    await expect(shell.locator('sp-alert-banner.browser-toolbar-message')).toHaveAttribute(
      'open',
      '',
      { timeout: 60_000 },
    );

    // Mirrors the real chat's table: one long path per cell, one of them using a
    // U+2011 non-breaking hyphen (`custom\u2011skeleton`), which used to be
    // linkified only up to `custom`.
    await sendMessage(
      app,
      shell,
      '| Query | What was returned |\n' +
        '|---|---|\n' +
        '| /content/hpe/base/blueprint/regression/templates/custom\u2011skeleton/column-container/1 | ' +
        '/content/hpe/base/blueprint/regression/components/text-only, ' +
        '/content/hpe/base/blueprint/regression/templates/custom-fragment/portfolio/portfolio-fragment5-touch |',
    );

    const table = shell.locator(`${ASSISTANT} table`);
    await expect(table).toHaveCount(1, { timeout: 30_000 });
    const links = shell.locator(`${ASSISTANT} table a[data-daisy-link]`);
    await expect(links).toHaveCount(3);

    // The U+2011 path links over its full length and targets the ASCII node.
    await expect(links.nth(0)).toHaveAttribute(
      'href',
      `${HOST}/content/hpe/base/blueprint/regression/templates/custom-skeleton/column-container/1.html`,
    );

    // The transcript must not scroll horizontally: the table fits its container.
    const overflow = await shell.locator('.chat-transcript').evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

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

  test('a page-relative table cell offers only its node CRX in the hover popover', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    // Put the pane on the host, so the table's full paths (and the page-relative
    // node hanging off them) resolve.
    const addressInput = shell.locator('#browser-address-bar input');
    await addressInput.fill(HOST);
    await addressInput.press('Enter');
    await expect(shell.locator('sp-alert-banner.browser-toolbar-message')).toHaveAttribute(
      'open',
      '',
      { timeout: 60_000 },
    );

    // A component-instance search shape: the owning page, a repeated page path
    // the executor blanked, and each node's path within its page.
    const data = {
      rows: [
        { 'jcr:path': '/content/site/alpha', node: 'jcr:content/parsys/mine' },
        { 'jcr:path': '', node: 'jcr:content/parsys/second' },
      ],
    };
    await scriptTurn(app, {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: 'format_table',
            arguments: { data, mode: 'new' },
            decision: {
              kind: 'approved',
              outcome: {
                ok: true,
                data: {
                  operation: 'format_table',
                  rowCount: 2,
                  mode: 'new',
                  textResultForLlm: 'ok',
                  resultType: 'success',
                } as never,
              },
            },
          },
        },
      ],
    });
    await shell.locator(COMPOSER_FIELD).fill('list the component instances');
    await shell.locator(COMPOSER_SEND).click();
    await flushFake(app);

    const nodeCells = shell.locator('.chat-partial-link');
    await expect(nodeCells).toHaveCount(2, { timeout: 30_000 });
    // Plain text, not a second navigable link (the row's Path cell is the link).
    expect(await nodeCells.first().evaluate((element) => element.tagName)).toBe('SPAN');

    // Hover the blanked-path row: its node hangs off the page the row above
    // rendered, and the popover offers the node's CRX and nothing else.
    await nodeCells.nth(1).hover();
    const crx = shell.locator('sp-overlay sp-action-button[title="CRX"]');
    await expect(crx).toBeVisible({ timeout: 30_000 });
    await expect(shell.locator('sp-overlay sp-action-button[title="Edit"]')).toHaveCount(0);
    // Spectrum positions the overlay a frame or two after it opens, so a click
    // fired the instant it appears can land on the table cell underneath it.
    // Wait until the button is the hit-test target before clicking.
    await expect
      .poll(() =>
        shell.evaluate(() => {
          const button = document.querySelector('sp-overlay sp-action-button[title="CRX"]');
          if (button === null) return false;
          const rect = button.getBoundingClientRect();
          return (
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button
          );
        }),
      )
      .toBe(true);

    // The button drives the node's own CRX in the pane (the unresolvable host
    // makes the resulting error banner the proof the URL reached navigation).
    await crx.click();
    const banner = shell.locator(BROWSER_MESSAGE);
    await expect(banner).toHaveAttribute('open', '', { timeout: 60_000 });
    await expect(banner).toContainText(
      `${HOST}/crx/de/index.jsp#/content/site/alpha/jcr%3Acontent/parsys/second`,
      { timeout: 60_000 },
    );

    await app.close();
  });

  test('moving the pointer swiftly from one link to another keeps the popover open', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    await sendMessage(
      app,
      shell,
      `See [Alpha](${HOST}/content/site/alpha.html) and [Beta](${HOST}/content/site/beta.html).`,
    );
    const links = shell.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(links).toHaveCount(2, { timeout: 30_000 });

    await links.nth(0).hover();
    const overlay = shell.locator('sp-overlay');
    await expect(overlay).toHaveCount(1);
    await expect(shell.locator('sp-overlay sp-action-button[title="Edit"]')).toBeVisible({
      timeout: 30_000,
    });

    // Leaving a link schedules a hide; moving onto the next link must cancel it,
    // or the popover transfers there and then closes on its own. The hide grace
    // is 200ms, so waiting past it proves the old link's timer no longer fires.
    await links.nth(1).hover();
    await shell.waitForTimeout(500);
    await expect
      .poll(() => overlay.evaluate((element) => (element as unknown as { open: boolean }).open))
      .toBe(true);
    await expect(shell.locator('sp-overlay sp-action-button[title="Edit"]')).toBeVisible();

    await app.close();
  });

  test('carrying the pointer up into a link popover never retargets it at the link above', async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    // Two links stacked one per line, the upper directly above the lower. Equal
    // labels keep them the same width, so the lower link's centre column is
    // covered by the upper link - exactly the case the owner hit.
    await sendMessage(
      app,
      shell,
      `- [Alpha](${HOST}/content/site/alpha.html)\n- [Bravo](${HOST}/content/site/bravo.html)`,
    );
    const links = shell.locator(`${ASSISTANT} a[data-daisy-link]`);
    await expect(links).toHaveCount(2, { timeout: 30_000 });

    // Hover the LOWER link; the popover opens above it, over the upper link.
    const lower = links.nth(1);
    await lower.hover();
    const edit = shell.locator('sp-overlay sp-action-button[title="Edit"]');
    await expect(edit).toBeVisible({ timeout: 30_000 });

    // Carry the pointer up into the popover in small steps, as a hand would. A
    // popover floating off its link leaves the strip between them uncovered, so
    // the path crosses the upper anchor and switches the popover to it.
    const from = await lower.boundingBox();
    const to = await edit.boundingBox();
    if (from === null || to === null) throw new Error('popover geometry unavailable');
    await shell.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await shell.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 24 });

    // The popover must still belong to the lower link: Edit opens Bravo's
    // editor, where a switch to the upper link would open Alpha's.
    await edit.click();
    const banner = shell.locator(BROWSER_MESSAGE);
    await expect(banner).toContainText(`${HOST}/editor.html/content/site/bravo.html`, {
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
      `${HOST}/crx/de/index.jsp#/content/site/alpha/jcr%3Acontent/myComponent/2`,
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

  test("an in-message table's path link carries no underline", async () => {
    test.setTimeout(120_000);
    const app = await launchWithHost();
    const shell = await app.firstWindow();
    await waitForComposerReady(shell);

    // Put the pane on the host so the table's bare AEM path resolves to a link
    // (the load fails; the attempt is what makes the origin active).
    const addressInput = shell.locator('#browser-address-bar input');
    await addressInput.fill(HOST);
    await addressInput.press('Enter');
    await expect(shell.locator('sp-alert-banner.browser-toolbar-message')).toHaveAttribute(
      'open',
      '',
      { timeout: 60_000 },
    );

    const turn: ScriptedTurn = {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: 'format_table',
            arguments: {
              data: {
                rows: [{ 'jcr:path': '/content/site/alpha' }],
                pagination: { total: { accuracy: 'exact', value: 1 } },
              },
              mode: 'new',
            },
            decision: {
              kind: 'approved',
              outcome: {
                ok: true,
                data: {
                  operation: 'format_table',
                  rowCount: 1,
                  mode: 'new',
                  textResultForLlm: 'ok',
                  resultType: 'success',
                },
              },
            },
          },
        },
      ],
    };
    await scriptTurn(app, turn);
    await shell.locator(COMPOSER_FIELD).fill('table please');
    await shell.locator(COMPOSER_SEND).click();
    await flushFake(app);

    const link = shell.locator('.chat-table-message a[data-daisy-link]');
    await expect(link).toHaveCount(1, { timeout: 30_000 });
    await expect(link).toHaveAttribute('href', `${HOST}/content/site/alpha.html`);
    // Owner request (2026-10-14): an in-message table's links carry no
    // underline - the accent colour alone marks them. The author rule overrides
    // the user agent's default for `a`.
    expect(await link.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe(
      'none',
    );

    await app.close();
  });
});
