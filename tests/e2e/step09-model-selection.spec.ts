import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Step 09 (models bullet): the Settings surface really can select a model and
 * a reasoning effort, and the choice really is persisted.
 *
 * This spec exists for two defects the unit suite provably cannot see.
 *
 * First, custom-element registration. jsdom renders an unregistered tag as
 * `HTMLUnknownElement` without complaint, so every `modelsViewModel` test
 * would stay green if `sp-picker` were never imported in the renderer entry
 * (`main.ts`) - and the section would be inert in the real app. Only a real
 * Chromium can answer `customElements.get("sp-picker")`, so that is asserted
 * head-on.
 *
 * Second, the IPC wiring. `settings:get-model-selection` and
 * `settings:set-model-preferences` are new channels, and Settings is now a
 * panel served from the one shell window - so the end-to-end round trip from
 * a real picker in the DOM through the preload sender guard (which trusts
 * only that single shell webContents id) to the main-process handler and back
 * is what this spec drives.
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

  // The persisted model/reasoning pair moved from two top-level keys to the
  // active agent's own node. This reads that node straight off disk; a missing
  // file is "not persisted yet", not an error (expect.poll retries on matcher
  // mismatch only, never on a thrown callback, so never throw here).
  const readAgentNode = (): {
    readonly model?: unknown;
    readonly reasoningEffort?: unknown;
  } => {
    try {
      const doc = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
        readonly agents?: Record<string, { model?: unknown; reasoningEffort?: unknown }>;
      };
      return doc.agents?.['copilot'] ?? {};
    } catch {
      return {};
    }
  };

  const openSettings = async () => {
    const app = await electron.launch({ args: [mainEntry], env });
    const settings = await app.firstWindow();
    await settings.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await settings.locator('sp-action-button[title="Settings"]').first().click();
    await settings
      .locator('.settings-panel')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    // Settings is tabbed and the Hosts tab is selected by default, so the
    // Agents panel is only visible once its tab is chosen.
    await settings.locator('sp-tab', { hasText: 'Agents' }).click();
    await settings
      .locator('section[aria-label="Agents"]')
      .waitFor({ state: 'visible', timeout: 60_000 });
    return { app, settings };
  };

  // --- Launch 1: the section is real, and a choice can be saved -----------
  const first = await openSettings();
  try {
    const section = first.settings.locator('section[aria-label="Agents"]');

    // The step-07 deferral placeholder must be gone, not merely supplemented.
    await expect(section).not.toContainText('deferred to a later step');
    await expect(section).not.toContainText('step 07');

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

    const modelPicker = section.locator('sp-picker[aria-label="Model"]').first();
    const reasoningPicker = section.locator('sp-picker[aria-label="Reasoning effort"]').first();
    // One picker pair per provider (Copilot and OpenRouter).
    await expect(section.locator('sp-picker[aria-label="Model"]')).toHaveCount(2);
    await expect(section.locator('sp-picker[aria-label="Reasoning effort"]')).toHaveCount(2);

    // The catalogue arrived over the new IPC channel: "no preference" plus the
    // two fake models.
    await expect(modelPicker.locator('sp-menu-item')).toHaveCount(3);
    await expect(section).toContainText('Fake Model (reasoning)');

    // The fake reports a signed-in provider, so both pickers are live (a
    // signed-out one disables them both - see settings-tabs.spec.ts).
    await expect(modelPicker).toBeEnabled();
    await expect(reasoningPicker).toBeEnabled();

    // One auth action at a time, and it is the sign-out half of the pair.
    await expect(section.locator('.agent-item__action')).toHaveCount(1);
    await expect(section.locator('.agent-item__action')).toHaveText('Sign out');

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

    // The selection auto-saves ~1s after the last pick (no Save button); the
    // settings document on disk is the sync point, and a freshly-read file
    // on a restart is covered by Launch 2.
    await expect
      .poll(() => readAgentNode().model, { timeout: 60_000 })
      .toBe('fake-model-reasoning');
  } finally {
    await first.app.close();
  }

  // Persisted to disk, not merely held in renderer memory.
  expect(readAgentNode().model).toBe('fake-model-reasoning');
  expect(readAgentNode().reasoningEffort).toBe('high');

  // --- Launch 2: the saved choice comes back, and can be cleared ----------
  const second = await openSettings();
  try {
    const section = second.settings.locator('section[aria-label="Agents"]');
    const modelPicker = section.locator('sp-picker[aria-label="Model"]').first();
    const reasoningPicker = section.locator('sp-picker[aria-label="Reasoning effort"]').first();

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

    // The same auto-save path persists the plain model (and clears the
    // reasoning level); the on-disk document is the sync point.
    await expect.poll(() => readAgentNode().model, { timeout: 60_000 }).toBe('fake-model-plain');
  } finally {
    await second.app.close();
  }

  // Changing to a model with no levels must clear the stored level too, not
  // leave "high" orphaned against a model that cannot accept it.
  expect(readAgentNode().model).toBe('fake-model-plain');
  expect(readAgentNode().reasoningEffort).toBeUndefined();
});
