import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentsSection } from '../../../../src/renderer/src/settings/agentsSection';
import { NO_PREFERENCE_VALUE } from '../../../../src/renderer/src/settings/modelsViewModel';
import type {
  SaveOutcome,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';
import {
  parseAppSettingsSnapshot,
  type AgentDefinition,
  type AgentId,
  type AppSettingsSnapshot,
} from '../../../../src/shared';

/**
 * The Agents section's DOM, in jsdom.
 *
 * Two things are asserted here that the E2E cannot reach. First, the
 * "Set active" half of the header: this build ships one provider and a fresh
 * settings file seeds it as active, so the control only appears when the
 * settings file names a *different* provider as the active one - a legal,
 * hand-editable document (`agents` is keyed by provider id, and at most one
 * node may be active). Second, the structural contract behind the equal-width
 * buttons: both action buttons carry the one shared class whose CSS gives them
 * their width, which a single-provider E2E can only ever see on one of them.
 *
 * jsdom cannot prove any of that *looks* right - it has no layout engine - so
 * the real geometry (right-aligned, one width, one line) is asserted in
 * `tests/e2e/settings-tabs.spec.ts`.
 */

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

const getAuthStatus = vi.fn();
const getModelSelection = vi.fn();
const setAgentSettings = vi.fn();
const setPassword = vi.fn();
const clearPassword = vi.fn();

let status: StatusBannerSink;
let reportSave: (outcome: Promise<SaveOutcome>) => void;
let onSettingsChanged: () => void;

/** A snapshot with only the providers named - hosts, proxies and browser flags are irrelevant here. */
function snapshotWith(
  agents: Record<string, { active: boolean; hasToken?: boolean }>,
): AppSettingsSnapshot {
  return parseAppSettingsSnapshot({
    hosts: [],
    proxies: [],
    agents,
    browser: { disableNativeWebAuthn: true },
  });
}

/** Flushes the promise chain behind a click (the save's own `.then`s). */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
}

function buildSection(definitions?: readonly AgentDefinition[]) {
  return createAgentsSection({
    status,
    reportSave,
    onSettingsChanged,
    ...(definitions === undefined ? {} : { definitions }),
  });
}

beforeEach(() => {
  getAuthStatus.mockReset();
  getModelSelection.mockReset();
  setAgentSettings.mockReset();
  setPassword.mockReset();
  clearPassword.mockReset();

  // Signed out: the pickers are inert, and the auth action is "Sign in".
  getAuthStatus.mockResolvedValue({ apiVersion: 1, isAuthenticated: false });
  getModelSelection.mockResolvedValue({
    ok: true,
    state: {
      models: [],
      selectedModel: null,
      selectedReasoningEffort: null,
      changesLocked: false,
      catalogUnavailable: false,
    },
  });
  setAgentSettings.mockResolvedValue({ ok: true });
  setPassword.mockResolvedValue({ ok: true });
  clearPassword.mockResolvedValue({ ok: true });

  status = {
    showStatus: vi.fn(),
    showError: vi.fn(),
    showPrompt: vi.fn(),
    clear: vi.fn(),
  };
  reportSave = vi.fn<(outcome: Promise<SaveOutcome>) => void>();
  onSettingsChanged = vi.fn<() => void>();

  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
  Reflect.set(dom.window, 'daisy', {
    agent: { getAuthStatus },
    settings: { getModelSelection, setAgentSettings, setPassword, clearPassword },
  });
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

describe('createAgentsSection', () => {
  it('badges the signed-in provider that is actually active', async () => {
    getAuthStatus.mockResolvedValue({ apiVersion: 1, isAuthenticated: true, login: 'octocat' });
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const badge = section.element.querySelector('.agent-item__active');
    expect(badge?.textContent).toBe('(active)');
    expect(section.element.querySelector('.agent-item__set-active')).toBeNull();
    // The badge sits on the header line, right after the provider's name.
    expect(section.element.querySelector('.agent-item__header')?.textContent).toBe(
      'GitHub Copilot(active)',
    );
  });

  it('shows no badge and a disabled control while the provider is signed out', async () => {
    // Signed out, the configured provider is not eligible, so nothing is
    // active: the badge must not claim otherwise, and "Set active" stays inert
    // until a sign-in makes it eligible. The sign-in action is still offered.
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    expect(section.element.querySelector('.agent-item__active')).toBeNull();
    const setActive = section.element.querySelector('.agent-item__set-active');
    expect(setActive?.tagName.toLowerCase()).toBe('sp-action-button');
    expect(setActive?.textContent).toBe('Set active');
    expect(setActive?.hasAttribute('disabled')).toBe(true);
    expect(section.element.querySelector('.agent-item__action')?.textContent).toBe('Sign in');
  });

  it('does not persist an activation for a provider that cannot be active', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const setActive = section.element.querySelector('.agent-item__set-active');
    // Bypasses the disabled attribute the way a stray programmatic click would;
    // the guard, not the attribute, must be what refuses the write.
    setActive?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    expect(setAgentSettings).not.toHaveBeenCalled();
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it('activates an eligible provider that is not the active one', async () => {
    // Two auth-free providers: the configured one is active, the other is
    // eligible but not active - the one case where "Set active" is live.
    const localA: AgentDefinition = {
      id: 'local-a' as AgentId,
      label: 'Local A',
      requiresAuth: false,
    };
    const localB: AgentDefinition = {
      id: 'local-b' as AgentId,
      label: 'Local B',
      requiresAuth: false,
    };
    const section = buildSection([localA, localB]);
    await section.refresh(snapshotWith({ 'local-a': { active: true } }));

    const second = section.element.querySelectorAll('.agent-item')[1];
    const setActive = second?.querySelector('.agent-item__set-active');
    expect(setActive?.hasAttribute('disabled')).toBe(false);
    setActive?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    expect(setAgentSettings).toHaveBeenCalledWith({
      agentId: 'local-b',
      changes: { active: true },
    });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('gives both action buttons the one class whose CSS makes them equally wide', async () => {
    const active = buildSection();
    await active.refresh(snapshotWith({ copilot: { active: true } }));
    const authAction = active.element.querySelector('.agent-item__action');
    expect(authAction?.classList.contains('agent-item__button')).toBe(true);

    const inactive = buildSection();
    await inactive.refresh(
      snapshotWith({ copilot: { active: false }, opencode: { active: true } }),
    );
    const setActive = inactive.element.querySelector('.agent-item__set-active');
    expect(setActive?.classList.contains('agent-item__button')).toBe(true);
  });

  it('labels the auth row with its status light alone - no heading over it', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const authRow = section.element.querySelector('.agent-item__auth');
    expect(authRow?.querySelector('sp-status-light')?.textContent).toBe('Not signed in');
    expect(authRow?.querySelector('sp-field-label')).toBeNull();
    expect(section.element.textContent).not.toContain('Authentication');
    // Exactly one action on the row, and it is the sign-in half.
    const actions = section.element.querySelectorAll('.agent-item__action');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.textContent).toBe('Sign in');

    // The remaining fields keep their visible labels.
    expect(
      [...section.element.querySelectorAll('.host-field sp-field-label')].map(
        (label) => label.textContent,
      ),
    ).toEqual(['Token', 'Proxy', 'Model', 'Reasoning effort']);
  });

  it('renders a Token field whose Set/Clear actions target the agent', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const control = section.element.querySelector('.password-control');
    expect(control).not.toBeNull();
    expect(control?.querySelector('sp-textfield')?.getAttribute('aria-label')).toBe('Token');
    const buttons = [...(control?.querySelectorAll('sp-action-button') ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual(['Set', 'Clear']);
    for (const button of buttons) expect(button.hasAttribute('quiet')).toBe(true);
  });

  it('sets a token through setPassword targeting the agent, and clears the field', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const field = section.element.querySelector('.password-control sp-textfield') as HTMLElement & {
      value: string;
    };
    field.value = 'ghp_secret';
    const setButton = [
      ...section.element.querySelectorAll('.password-control sp-action-button'),
    ].find((button) => button.textContent === 'Set');
    setButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    expect(setPassword).toHaveBeenCalledExactlyOnceWith(
      { kind: 'agent', agentId: 'copilot' },
      'ghp_secret',
    );
    expect(field.value).toBe('');
  });

  it('clears a token through clearPassword targeting the agent', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const clearButton = [
      ...section.element.querySelectorAll('.password-control sp-action-button'),
    ].find((button) => button.textContent === 'Clear');
    clearButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    expect(clearPassword).toHaveBeenCalledExactlyOnceWith({ kind: 'agent', agentId: 'copilot' });
  });

  it('treats a stored token as authenticated and active, with a positive status light', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true, hasToken: true } }));

    expect(section.element.querySelector('.agent-item__active')?.textContent).toBe('(active)');
    const light = section.element.querySelector('.agent-item__auth sp-status-light');
    expect(light?.getAttribute('variant')).toBe('positive');
    expect(light?.textContent).toBe('Authenticated with token');
  });

  it('offers "Sign in", not "Sign out", when the stored token is what authenticates the runtime', async () => {
    // The runtime resolves the injected COPILOT_GITHUB_TOKEN before the vault
    // session, so a token-only setup reports `authType: "env"`. The status row
    // still says "Authenticated with token", but the action must describe the
    // (absent) interactive session - a local sign-out would change nothing.
    getAuthStatus.mockResolvedValue({
      apiVersion: 1,
      isAuthenticated: true,
      authType: 'env',
      login: 'octocat',
    });
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true, hasToken: true } }));

    const light = section.element.querySelector('.agent-item__auth sp-status-light');
    expect(light?.getAttribute('variant')).toBe('positive');
    expect(light?.textContent).toBe('Authenticated with token');

    const actions = section.element.querySelectorAll('.agent-item__action');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.textContent).toBe('Sign in');
  });

  it('updates the provider row in place instead of rebuilding its pickers', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const item = section.element.querySelector('.agent-item');
    const pickers = [...section.element.querySelectorAll('sp-picker')];
    expect(pickers).toHaveLength(3);

    // The panel reloads after every save, so a refresh is the common path. It
    // must reuse the row and its pickers: re-creating a Spectrum picker blanks
    // it for a frame - the flicker this in-place update exists to remove.
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    expect(section.element.querySelector('.agent-item')).toBe(item);
    const again = [...section.element.querySelectorAll('sp-picker')];
    expect(again).toHaveLength(pickers.length);
    for (const [index, node] of again.entries()) {
      expect(node).toBe(pickers[index]);
    }
  });

  it('applies a changed live selection to the existing pickers', async () => {
    getAuthStatus.mockResolvedValue({ apiVersion: 1, isAuthenticated: true, login: 'octocat' });
    getModelSelection.mockResolvedValue({
      ok: true,
      state: {
        models: [
          { id: 'model-a', name: 'Model A', supportedReasoningEfforts: ['low', 'high'] },
          { id: 'model-b', name: 'Model B', supportedReasoningEfforts: [] },
        ],
        selectedModel: 'model-a',
        selectedReasoningEffort: 'high',
        changesLocked: false,
        catalogUnavailable: false,
      },
    });

    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const modelPicker = section.element.querySelector('sp-picker[aria-label="Model"]');
    const reasoningPicker = section.element.querySelector(
      'sp-picker[aria-label="Reasoning effort"]',
    );

    getModelSelection.mockResolvedValue({
      ok: true,
      state: {
        models: [
          { id: 'model-a', name: 'Model A', supportedReasoningEfforts: ['low', 'high'] },
          { id: 'model-b', name: 'Model B', supportedReasoningEfforts: [] },
        ],
        selectedModel: 'model-b',
        selectedReasoningEffort: null,
        changesLocked: false,
        catalogUnavailable: false,
      },
    });
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    // Same elements, new values: the selection moved without a rebuild.
    expect(section.element.querySelector('sp-picker[aria-label="Model"]')).toBe(modelPicker);
    expect(section.element.querySelector('sp-picker[aria-label="Reasoning effort"]')).toBe(
      reasoningPicker,
    );
    expect((modelPicker as HTMLElement & { value: string }).value).toBe('model-b');
    expect((reasoningPicker as HTMLElement & { value: string }).value).toBe(NO_PREFERENCE_VALUE);
  });
});
