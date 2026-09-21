import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';

/**
 * The chat pane's "no usable agent" state, proven against the REAL built app
 * (`out/main/index.js` + `out/preload/app-preload.js`) driven by the
 * deterministic fake agent (`src/agent/fakeAgentService.ts`).
 *
 * What only the real app can prove here (jsdom cannot):
 * - `sp-alert-banner` genuinely exists and is only *visible* while the state
 *   holds (the banner is display-hidden via its own shadow root, not by this
 *   code).
 * - the Send `sp-action-button` is really disabled AND really grey: the
 *   `chat-composer__send--enabled` accent class must be gone, because a
 *   light-DOM class rule outranks the component's `:host([disabled])` tokens.
 * - the banner's inline Settings control opens the Settings panel on the
 *   Agents tab (`sp-tabs` selection is shadow-DOM behaviour).
 *
 * The fake starts signed in, so the test signs out mid-run: main hears
 * immediately (`onAuthStateChanged`), and the renderer follows on its next
 * `getStatus()` poll (up to 15s, `chatPane.ts`), which is exactly the state
 * this test is about. Deliberately no `chat-banner` assertion is made until
 * that poll has had time to run.
 *
 * Run against the BUILT app (this file never builds it):
 *   npm run build
 *   npx playwright test tests/e2e/agent-activation.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'agent-activation-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Blue-minus-red of a computed `rgb(...)`/`rgba(...)` colour; >0 means blue-ish. */
function blueMinusRed(color: string): number {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
  if (match === null) throw new Error(`unexpected computed colour "${color}"`);
  return Number(match[3]) - Number(match[1]);
}

test('no usable agent shows the banner, greys Send, and opens Settings on Agents', async () => {
  test.setTimeout(180_000);

  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...definedEnv(process.env),
      USERPROFILE: home,
      HOME: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      // Selects the deterministic fake so the test can drive auth state.
      [FAKE_AGENT_SERVICE_ENV_VAR]: '1',
    },
  });

  try {
    const shell = await app.firstWindow();
    await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });

    // The fake starts signed in: no banner, Send enabled.
    const send = shell.locator('.chat-composer__send');
    await expect(send).not.toHaveAttribute('disabled', '', { timeout: 60_000 });
    await expect(shell.locator('.chat-banner')).toBeHidden();
    const enabledBackground = await send.evaluate((node) => getComputedStyle(node).backgroundColor);
    // The enabled Send is the accent blue: its blue channel dominates red.
    expect(blueMinusRed(enabledBackground)).toBeGreaterThan(50);

    // Sign out inside the running app; main learns at once, the renderer on
    // its next status poll.
    await app.evaluate((_electronNamespace, globalKey: string) => {
      const fake = (globalThis as Record<string, unknown>)[globalKey] as {
        setAuthState(state: { apiVersion: 1; isAuthenticated: false }): void;
      };
      fake.setAuthState({ apiVersion: 1, isAuthenticated: false });
    }, TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY);

    const banner = shell.locator('.chat-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('Activate an agent in');
    await expect(banner).toContainText('to send messages');

    // Banner styling rules, proven on the real upgraded component:
    // - the embedded action is always size "s" (24px tall);
    // - the message's line box matches the button's height, so it aligns;
    // - the row carries 8px vertical padding;
    // - the message clamps to three lines whatever it holds.
    const geometry = await banner.evaluate((node) => {
      const button = node.querySelector('sp-action-button');
      const copy = node.querySelector('.banner-row__copy');
      const host = getComputedStyle(node);
      if (button === null || copy === null) return null;
      return {
        size: button.getAttribute('size'),
        buttonHeight: button.getBoundingClientRect().height,
        copyLineHeight: Number.parseFloat(getComputedStyle(copy).lineHeight),
        paddingTop: host.paddingTop,
        paddingBottom: host.paddingBottom,
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry?.size).toBe('s');
    expect(Math.round(geometry?.buttonHeight ?? 0)).toBe(24);
    expect(geometry?.copyLineHeight).toBe(Math.round(geometry?.buttonHeight ?? -1));
    expect(geometry?.paddingTop).toBe('8px');
    expect(geometry?.paddingBottom).toBe('8px');

    const clamp = await banner.evaluate((node) => {
      const copy = node.querySelector('.banner-row__copy');
      if (copy === null) return null;
      copy.append(` ${'clamped '.repeat(400)}`);
      return {
        height: copy.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(copy).lineHeight),
        overflow: getComputedStyle(copy).overflow,
      };
    });
    expect(clamp).not.toBeNull();
    expect(clamp?.overflow).toBe('hidden');
    // Three lines exactly: no more, and demonstrably more than one (so the
    // clamp genuinely engaged rather than the text simply fitting).
    expect(clamp?.height).toBeLessThanOrEqual(3 * (clamp?.lineHeight ?? 0) + 1);
    expect(clamp?.height).toBeGreaterThan(1.5 * (clamp?.lineHeight ?? 0));

    // Send is disabled and visibly grey - not the "still looks enabled" accent
    // blue the light-DOM class rule used to force: the class is gone, so the
    // component's disabled tokens paint through.
    await expect(send).toHaveAttribute('disabled', '');
    expect(
      await send.evaluate((node) => node.classList.contains('chat-composer__send--enabled')),
    ).toBe(false);
    const disabledBackground = await send.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    expect(blueMinusRed(disabledBackground)).toBeLessThanOrEqual(20);
    expect(disabledBackground).not.toBe(enabledBackground);
    // The banner carries the explanation; the composer stays silent.
    await expect(shell.locator('.chat-composer__notice')).toHaveText('');

    // The banner's inline Settings control lands on the Agents tab.
    await banner.locator('sp-action-button', { hasText: 'Settings' }).click();
    const panel = shell.locator('.settings-panel').first();
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(shell.locator('.settings-panel__tab-panel[selected]').first()).toHaveAttribute(
      'value',
      'agents',
    );
    await expect(shell.locator('section[aria-label="Agents"]')).toBeVisible();
  } finally {
    await app.close();
  }
});
