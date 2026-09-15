import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Step 09 (models bullet): the Settings window really can select a model and a
 * reasoning effort, and the choice really is persisted.
 *
 * This spec exists for two defects the unit suite provably cannot see.
 *
 * First, custom-element registration. jsdom renders an unregistered tag as
 * `HTMLUnknownElement` without complaint, so every `modelsViewModel` test
 * would stay green if `sp-picker` were never imported in `settingsMain.ts` -
 * and the section would be inert in the real app. Only a real Chromium can
 * answer `customElements.get("sp-picker")`, so that is asserted head-on.
 *
 * Second, the IPC wiring. `settings:get-model-selection` and
 * `settings:set-model-preferences` are new channels on a window that is a
 * separate `BrowserWindow` - exactly the configuration that made the entire
 * settings UI inert in step 05 while its unit tests passed.
 *
 * The catalogue here is the fixed one `fakeModelCatalog()` supplies under the
 * deterministic fake agent, so the options are known without a live Copilot.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step09-models-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test('a model and reasoning effort chosen in Settings are persisted and shown again', async () => {
  test.setTimeout(180_000);

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
    ETOOLBOX_DAISY_FAKE_AGENT_SERVICE: '1',
  };
  const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');

  const openSettings = async () => {
    const app = await electron.launch({ args: [mainEntry], env });
    const shell = await app.firstWindow();
    await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    const settingsPagePromise = app.waitForEvent('window', { timeout: 60_000 });
    await shell.locator('sp-action-button', { hasText: 'Settings' }).first().click();
    const settings = await settingsPagePromise;
    await settings.waitForLoadState('domcontentloaded');
    await settings
      .locator('section[aria-label="Models"]')
      .waitFor({ state: 'visible', timeout: 60_000 });
    return { app, settings };
  };

  // --- Launch 1: the section is real, and a choice can be saved -----------
  const first = await openSettings();
  try {
    const section = first.settings.locator('section[aria-label="Models"]');

    // The step-07 deferral placeholder must be gone, not merely supplemented.
    await expect(section).not.toContainText('deferred to a later step');
    await expect(first.settings.locator('body')).not.toContainText('step 07');

    // `sp-picker` is genuinely upgraded - the assertion jsdom cannot make.
    const registered = await first.settings.evaluate(
      () => customElements.get('sp-picker') !== undefined,
    );
    expect(registered).toBe(true);
    const hasShadowRoot = await section
      .locator('sp-picker')
      .first()
      .evaluate((node) => node.shadowRoot !== null);
    expect(hasShadowRoot).toBe(true);

    const modelPicker = section.locator('sp-picker[label="Model"]');
    const reasoningPicker = section.locator('sp-picker[label="Reasoning effort"]');
    await expect(modelPicker).toHaveCount(1);
    await expect(reasoningPicker).toHaveCount(1);

    // The catalogue arrived over the new IPC channel: "no preference" plus the
    // two fake models.
    await expect(modelPicker.locator('sp-menu-item')).toHaveCount(3);
    await expect(section).toContainText('Fake Model (reasoning)');

    // Nothing is chosen yet, and the section says a change applies next prompt.
    await expect(section).toContainText('next prompt');

    // Choosing the reasoning-capable model must populate the second picker
    // with that model's own levels - "show only supported reasoning levels".
    await modelPicker.evaluate((node: HTMLElement & { value: string }) => {
      node.value = 'fake-model-reasoning';
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(reasoningPicker.locator('sp-menu-item')).toHaveCount(3);

    await reasoningPicker.evaluate((node: HTMLElement & { value: string }) => {
      node.value = 'high';
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await section.locator('sp-button', { hasText: 'Save' }).first().click();
    await expect(section.locator('.models-section__save-status')).toContainText('Saved', {
      timeout: 60_000,
    });
  } finally {
    await first.app.close();
  }

  // Persisted to disk, not merely held in renderer memory.
  const saved = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    defaultModel?: unknown;
    defaultReasoningEffort?: unknown;
  };
  expect(saved.defaultModel).toBe('fake-model-reasoning');
  expect(saved.defaultReasoningEffort).toBe('high');

  // --- Launch 2: the saved choice comes back, and can be cleared ----------
  const second = await openSettings();
  try {
    const section = second.settings.locator('section[aria-label="Models"]');
    const modelPicker = section.locator('sp-picker[label="Model"]');
    const reasoningPicker = section.locator('sp-picker[label="Reasoning effort"]');

    await expect
      .poll(
        async () => modelPicker.evaluate((node: HTMLElement & { value: string }) => node.value),
        { timeout: 60_000 },
      )
      .toBe('fake-model-reasoning');
    expect(
      await reasoningPicker.evaluate((node: HTMLElement & { value: string }) => node.value),
    ).toBe('high');

    // Switching to a model with no reasoning levels must disable the second
    // picker immediately, without a save.
    await modelPicker.evaluate((node: HTMLElement & { value: string }) => {
      node.value = 'fake-model-plain';
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(reasoningPicker).toHaveAttribute('disabled', '');
    await expect(reasoningPicker.locator('sp-menu-item')).toHaveCount(1);

    await section.locator('sp-button', { hasText: 'Save' }).first().click();
    await expect(section.locator('.models-section__save-status')).toContainText('Saved', {
      timeout: 60_000,
    });
  } finally {
    await second.app.close();
  }

  // Changing to a model with no levels must clear the stored level too, not
  // leave "high" orphaned against a model that cannot accept it.
  const afterSwitch = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    defaultModel?: unknown;
    defaultReasoningEffort?: unknown;
  };
  expect(afterSwitch.defaultModel).toBe('fake-model-plain');
  expect(afterSwitch.defaultReasoningEffort).toBeNull();
});
