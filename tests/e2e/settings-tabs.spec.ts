import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

/**
 * The Settings surface's sections are organised as Spectrum Tabs
 * (`sp-tabs` / `sp-tab` / `sp-tab-panel`, registered in `main.ts`): one tab
 * per section, Hosts selected by default, exactly one panel visible.
 *
 * Only the real built app can prove this. jsdom renders `sp-tabs`,
 * `sp-tab` and `sp-tab-panel` as inert `HTMLUnknownElement`s, and the
 * panel-show/hide logic lives inside their shadow roots (`display: none`
 * on the unselected panels), so a unit test would stay green even if the
 * registration imports in `main.ts` were missing - custom-element
 * registration and the tab switch are asserted here head-on, exactly like
 * step09-model-selection.spec.ts does for `sp-picker`.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-tabs-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test('Settings sections are real tab panels, switching their content', async () => {
  test.setTimeout(120_000);

  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const env = {
    ...definedEnv(process.env),
    USERPROFILE: home,
    HOME: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const settings = await app.firstWindow();
    await settings.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await settings.locator('sp-action-button[title="Settings"]').first().click();
    await settings
      .locator('.settings-panel')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    // The three tab elements are genuinely registered and upgraded - the
    // assertions jsdom cannot make.
    const tabs = settings.locator('.settings-panel__tabs');
    await expect(tabs).toHaveCount(1);
    for (const tag of ['sp-tabs', 'sp-tab', 'sp-tab-panel'] as const) {
      const registered = await settings.evaluate(
        (tagName) => customElements.get(tagName) !== undefined,
        tag,
      );
      expect(registered).toBe(true);
    }
    const firstTab = tabs.locator('sp-tab').first();
    const firstPanel = tabs.locator('.settings-panel__tab-panel').first();
    await expect(firstTab).toHaveCount(1);
    await expect(firstPanel).toHaveCount(1);
    expect(await firstTab.evaluate((node) => node.shadowRoot !== null)).toBe(true);
    expect(await firstPanel.evaluate((node) => node.shadowRoot !== null)).toBe(true);

    // Every section is one tab, labelled with its former heading. (The
    // certificate-exceptions tab was removed when approval moved into the
    // browser pane's banner - see docs/verification.md's certificate-prompt
    // deviation note. The standalone Authentication and Models tabs were
    // folded into the single Agents tab, which hosts the provider's
    // active badge/set-active control, sign-in and model/effort pickers
    // together - see agentsSection.ts.)
    const labels = ['Hosts', 'Projects', 'Agents', 'Browser', 'Proxies'];
    await expect(tabs.locator('sp-tab')).toHaveCount(labels.length);
    for (const label of labels) {
      await expect(tabs.locator('sp-tab', { hasText: label })).toHaveCount(1);
    }
    // Projects sits right after Hosts; Browser sits ahead of Proxies, because a
    // host's Proxy combobox offers "(Default)" pointing at the browser's default
    // proxy.
    await expect(tabs.locator('sp-tab').nth(1)).toHaveText('Projects');
    await expect(tabs.locator('sp-tab').nth(3)).toHaveText('Browser');
    await expect(tabs.locator('sp-tab').nth(4)).toHaveText('Proxies');

    // Hosts is selected by default; every other panel is hidden. The panel's
    // node value is `hosts` (not `servers`) - the surface language was renamed
    // even though the underlying data model still calls these servers.
    await expect(settings.locator('section[aria-label="Hosts"]')).toBeVisible();
    const selectedPanel = settings.locator('.settings-panel__tab-panel[selected]');
    await expect(selectedPanel).toHaveCount(1);
    await expect(selectedPanel.first()).toHaveAttribute('value', 'hosts');
    for (const panelValue of ['browser', 'agents', 'proxies', 'projects']) {
      await expect(
        settings.locator(`.settings-panel__tab-panel[value="${panelValue}"]`),
      ).toBeHidden();
    }

    // The Browser tab carries the WebAuthn suppression checkbox - checked by
    // default - with the restart caveat beneath it.
    await settings.locator('sp-tab', { hasText: 'Browser' }).click();
    const browserSection = settings.locator('section[aria-label="Browser"]');
    await expect(browserSection).toBeVisible();
    // The Default proxy is the first field on the tab, with "(No proxy)" plus
    // the library's entries (no "(Default)" - this *is* the default).
    await expect(browserSection.locator('sp-field-label').first()).toHaveText('Default proxy');
    const defaultProxy = browserSection.locator('sp-picker[aria-label="Proxy"]');
    await expect(defaultProxy).toHaveCount(1);
    await expect(defaultProxy.locator('sp-menu-item').first()).toHaveText('(No proxy)');
    const webauthnCheckbox = browserSection.locator('sp-checkbox#browser-disable-native-webauthn');
    await expect(webauthnCheckbox).toHaveCount(1);
    await expect(webauthnCheckbox).toHaveText('Suppress the Windows security-key prompt');
    await expect(browserSection).toContainText('Takes effect after restarting the app.');
    expect(
      await webauthnCheckbox.evaluate(
        (node) => (node as HTMLElement & { checked: boolean }).checked,
      ),
    ).toBe(true);

    // Switching tabs swaps the visible content.
    await settings.locator('sp-tab', { hasText: 'Agents' }).click();
    await expect(settings.locator('section[aria-label="Agents"]')).toBeVisible();
    await expect(settings.locator('section[aria-label="Hosts"]')).toBeHidden();
    const agentsSection = settings.locator('section[aria-label="Agents"]');
    // Two providers ship: GitHub Copilot and OpenRouter, each with a Model and a
    // Reasoning-effort picker.
    await expect(agentsSection.locator('sp-picker[aria-label="Model"]')).toHaveCount(2);

    // The personal-access-token field is the Proxies tab's password control,
    // labelled "API key (token)", with its Set/Clear actions - one per provider.
    await expect(agentsSection.locator('.password-control')).toHaveCount(2);
    const tokenControl = agentsSection.locator('.password-control').first();
    await expect(tokenControl.locator('sp-textfield')).toHaveAttribute(
      'aria-label',
      'API key (token)',
    );
    await expect(tokenControl.locator('sp-action-button')).toHaveCount(2);

    // Which provider is active is derived from eligibility, not merely stored:
    // a fresh profile seeds GitHub Copilot as the configured provider, but with
    // no Copilot session it cannot be active - so there is no badge, and each
    // provider's "Set active" control is present but inert until it can serve.
    await expect(agentsSection.locator('.agent-item__active')).toHaveCount(0);
    // Both providers render, Copilot first then OpenRouter. OpenRouter is
    // token-only, so its item offers no Sign in/out action - the single
    // `.agent-item__action` asserted below belongs to Copilot.
    await expect(agentsSection.locator('.agent-item__title')).toHaveText([
      'GitHub Copilot',
      'OpenRouter',
    ]);
    const setActive = agentsSection.locator('.agent-item__set-active');
    await expect(setActive).toHaveCount(2);
    await expect(setActive.first()).toHaveText('Set active');
    await expect(setActive.first()).toHaveAttribute('disabled', '');
    await expect(agentsSection.locator('sp-radio')).toHaveCount(0);

    // The auth row carries no visible label - its own status light says what it
    // is - and offers one action at a time: an `sp-action-button`, on the same
    // line as the light. A scratch profile has no Copilot session, so the offer
    // is "Sign in".
    await expect(agentsSection).not.toContainText('Authentication');
    const authAction = agentsSection.locator('.agent-item__action');
    await expect(authAction).toHaveCount(1);
    await expect(authAction).toHaveText('Sign in');
    expect(await authAction.evaluate((node) => node.tagName.toLowerCase())).toBe(
      'sp-action-button',
    );
    const authRow = agentsSection.locator('.agent-item__auth').first();
    expect(
      await authRow.evaluate((node) => {
        const light = node.querySelector('sp-status-light');
        const button = node.querySelector('.agent-item__action');
        if (light === null || button === null) return false;
        // Same line: identical vertical centre, light first.
        const a = light.getBoundingClientRect();
        const b = button.getBoundingClientRect();
        return Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 2 && a.right <= b.left + 1;
      }),
    ).toBe(true);

    // Every provider shows its authentication marker, including one whose
    // runtime is not running (the second row here is OpenRouter, which is not
    // the configured provider): its marker is derived from settings alone, so a
    // non-configured provider never looks unconfigured.
    const authRows = agentsSection.locator('.agent-item__auth');
    await expect(authRows).toHaveCount(2);
    await expect(authRows.nth(1)).toBeVisible();
    await expect(authRows.nth(1).locator('sp-status-light')).toHaveText(
      'Set API key (token) before activating',
    );

    // The action is right-aligned, and it is the shared `.agent-item__button`
    // that gives it (and "Set active" when it appears) one width - so the two
    // would line up in a single column at the item's right edge. A 1px
    // tolerance: sub-pixel layout rounds the button's right edge.
    expect(
      await authAction.evaluate((node) => {
        const item = node.closest('.agent-item');
        if (item === null) return null;
        const button = node.getBoundingClientRect();
        const padding = Number.parseFloat(getComputedStyle(item).paddingRight);
        const itemRight = item.getBoundingClientRect().right - padding;
        return {
          rightAligned: Math.abs(itemRight - button.right) <= 1,
          minWidth: getComputedStyle(node).minWidth,
        };
      }),
    ).toEqual({ rightAligned: true, minWidth: '112px' });

    // Signed out means no model list exists, so neither picker is offered -
    // the defect this asserts against left the model picker looking usable.
    const modelPicker = agentsSection.locator('sp-picker[aria-label="Model"]').first();
    const effortPicker = agentsSection.locator('sp-picker[aria-label="Reasoning effort"]').first();
    expect(
      await modelPicker.evaluate((node) => (node as HTMLElement & { disabled: boolean }).disabled),
    ).toBe(true);
    expect(
      await effortPicker.evaluate((node) => (node as HTMLElement & { disabled: boolean }).disabled),
    ).toBe(true);

    // The Proxies tab is a multifield too: its "Add item" and the per-item
    // quiet Set/Clear password actions are present.
    await settings.locator('sp-tab', { hasText: 'Proxies' }).click();
    await expect(settings.locator('section[aria-label="Proxies"]')).toBeVisible();
    await expect(settings.locator('section[aria-label="Agents"]')).toBeHidden();
    await settings.locator('section[aria-label="Proxies"] .multifield__add').click();
    await expect(settings.locator('section[aria-label="Proxies"] .password-control')).toHaveCount(
      1,
    );
    await expect(
      settings.locator('section[aria-label="Proxies"] .password-control sp-action-button'),
    ).toHaveCount(2);

    await settings.locator('sp-tab', { hasText: 'Hosts' }).click();
    await expect(settings.locator('section[aria-label="Hosts"] .multifield__add')).toBeVisible();
  } finally {
    await app.close();
  }
});
