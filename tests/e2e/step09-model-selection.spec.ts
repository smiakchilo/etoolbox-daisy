import { _electron as electron, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { verticalGap } from '../support/e2e/layout';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byField, byTestId } from '../support/selectors';

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

const scratchBase = path.resolve(__dirname, '../../test-results', 'step09-models-scratch');

test('a model and reasoning effort chosen in Settings are persisted and shown again', async () => {
  test.setTimeout(180_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData }, { fakeAgent: true });
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
    await settings
      .locator(byTestId('browser-address'))
      .waitFor({ state: 'visible', timeout: 60_000 });
    await settings.locator(byTestId('chat-settings')).click();
    await settings
      .locator(byTestId('settings-panel'))
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    // Settings is tabbed and the Hosts tab is selected by default, so the
    // Agents panel is only visible once its tab is chosen.
    await settings.locator(byTestId('settings-tab-agents')).click();
    await settings.locator('.agents-section').waitFor({ state: 'visible', timeout: 60_000 });
    return { app, settings };
  };

  // --- Launch 1: the section is real, and a choice can be saved -----------
  const first = await openSettings();
  try {
    const section = first.settings.locator('.agents-section');

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

    const modelPicker = section.locator(byField('agent-model')).first();
    const reasoningPicker = section.locator(byField('agent-reasoning-effort')).first();
    // One picker pair per provider (Copilot and OpenRouter).
    await expect(section.locator(byField('agent-model'))).toHaveCount(2);
    await expect(section.locator(byField('agent-reasoning-effort'))).toHaveCount(2);

    // The provider cards are separated by a doubled gap (a section boundary),
    // while the fields inside one card keep the plain gap. Asserted relationally
    // so neither exact value is pinned.
    const cards = section.locator('.agent-item');
    await expect(cards).toHaveCount(2);
    const cardGap = await verticalGap(cards.nth(0), cards.nth(1));
    const cardFields = cards.nth(0).locator('.host-field');
    const fieldGap = await verticalGap(cardFields.nth(0), cardFields.nth(1));
    expect(cardGap).toBeGreaterThan(fieldGap);

    // The catalogue arrived over the new IPC channel: "no preference" plus the
    // two fake models.
    await expect(modelPicker.locator('sp-menu-item')).toHaveCount(3);

    // The fake reports a signed-in provider, so both pickers are live (a
    // signed-out one disables them both - see settings-tabs.spec.ts).
    await expect(modelPicker).toBeEnabled();
    await expect(reasoningPicker).toBeEnabled();

    // One auth action at a time (the provider is signed in).
    await expect(section.locator(byTestId('agent-auth-action'))).toHaveCount(1);

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

    // The selection commits when the picker changes (no Save button); the
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
    const section = second.settings.locator('.agents-section');
    const modelPicker = section.locator(byField('agent-model')).first();
    const reasoningPicker = section.locator(byField('agent-reasoning-effort')).first();

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

    // The same commit path persists the plain model (and clears the
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
