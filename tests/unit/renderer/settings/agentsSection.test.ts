import type { JSDOM } from 'jsdom';
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
import { flushMicrotasks } from '../../../support/asyncWaits';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';
import { byField } from '../../../support/selectors';

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

let dom: JSDOM;
let restoreGlobals: () => void;

const getAuthStatus = vi.fn();
const getAuthPresence = vi.fn();
const onAuthProgress = vi.fn(() => () => undefined);
const getModelSelection = vi.fn();
const setAgentSettings = vi.fn();
const setModelPreferences = vi.fn();
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
const flush = (): Promise<void> => flushMicrotasks(4);

/**
 * Lets a commit saver's zero-delay serialization hop fire, then drains its
 * promise chain. Deliberately one macrotask, not a 1 s debounce: a picker
 * change must persist on `change`.
 */
async function settleCommit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
}

function buildSection(definitions?: readonly AgentDefinition[]) {
  return createAgentsSection({
    status,
    reportSave,
    onSettingsChanged,
    ...(definitions === undefined ? {} : { definitions }),
  });
}

/**
 * The token control for the provider row at `index` (in definitions order):
 * its text field plus the two deliberate actions, so a test reads as the user's
 * gesture rather than as a DOM query.
 */
function tokenControlAt(
  section: ReturnType<typeof buildSection>,
  index: number,
): {
  setToken(value: string): void;
  clearToken(): void;
} {
  const control = section.element.querySelectorAll('.password-control')[index];
  if (control === undefined) throw new Error(`no token control at index ${String(index)}`);
  const field = control.querySelector<HTMLElement & { value: string }>('sp-textfield');
  if (field === null) throw new Error('token control has no field');
  const buttons = [...control.querySelectorAll('sp-action-button')];
  const click = (label: string): void => {
    buttons
      .find((button) => button.textContent === label)
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };
  return {
    setToken(value: string): void {
      field.value = value;
      click('Set');
    },
    clearToken(): void {
      click('Clear');
    },
  };
}

beforeEach(() => {
  getAuthStatus.mockReset();
  getAuthPresence.mockReset();
  getModelSelection.mockReset();
  setAgentSettings.mockReset();
  setModelPreferences.mockReset();
  setPassword.mockReset();
  clearPassword.mockReset();

  // Signed out: the pickers are inert, and the auth action is "Sign in".
  getAuthStatus.mockResolvedValue({ apiVersion: 1, isAuthenticated: false });
  // No cheap presence by default: a provider is then eligible only via a token.
  getAuthPresence.mockResolvedValue({ present: false });
  getModelSelection.mockResolvedValue({
    ok: true,
    state: {
      models: [],
      selectedModel: null,
      selectedReasoningEffort: null,
      catalogUnavailable: false,
    },
  });
  setAgentSettings.mockResolvedValue({ ok: true });
  setModelPreferences.mockResolvedValue({ ok: true });
  setPassword.mockResolvedValue({ ok: true });
  clearPassword.mockResolvedValue({ ok: true });

  status = {
    showStatus: vi.fn(),
    showError: vi.fn(),
    showPrompt: vi.fn(),
    showNotice: vi.fn(),
    clear: vi.fn(),
  };
  reportSave = vi.fn<(outcome: Promise<SaveOutcome>) => void>();
  onSettingsChanged = vi.fn<() => void>();

  ({ dom, restore: restoreGlobals } = installJsdomGlobals({ url: 'https://daisy.test/' }));
  Reflect.set(dom.window, 'daisy', {
    agent: { getAuthStatus, getAuthPresence, onAuthProgress },
    settings: {
      getModelSelection,
      setModelPreferences,
      setAgentSettings,
      setPassword,
      clearPassword,
    },
  });
});

afterEach(() => {
  restoreGlobals();
});

describe('createAgentsSection', () => {
  it('badges the signed-in provider that is actually active', async () => {
    getAuthStatus.mockResolvedValue({ apiVersion: 1, isAuthenticated: true, login: 'octocat' });
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const badge = section.element.querySelector('.agent-item__active');
    expect(badge?.textContent?.length).toBeGreaterThan(0);
    expect(
      section.element.querySelector('.agent-item')?.querySelector('.agent-item__set-active'),
    ).toBeNull();
    // The badge sits on the header line, right after the provider's name.
    const header = section.element.querySelector('.agent-item__header')?.textContent ?? '';
    expect(header.endsWith(badge?.textContent ?? '')).toBe(true);
    expect(header.length).toBeGreaterThan(badge?.textContent?.length ?? 0);
    // The active item carries the highlight class the light-blue wash is keyed on.
    expect(
      section.element.querySelector('.agent-item')?.classList.contains('agent-item--active'),
    ).toBe(true);
  });

  it('shows no badge and a disabled control while the provider is signed out', async () => {
    // Signed out, the configured provider is not eligible, so nothing is
    // active: the badge must not claim otherwise, and "Set active" stays inert
    // until a sign-in makes it eligible. The sign-in action is still offered.
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    expect(section.element.querySelector('.agent-item__active')).toBeNull();
    const setActive = section.element.querySelector('.agent-item__set-active');
    expect(setActive).not.toBeNull();
    expect(setActive?.textContent?.length).toBeGreaterThan(0);
    expect(setActive?.hasAttribute('disabled')).toBe(true);
    expect(
      section.element.querySelector('.agent-item__action')?.textContent?.length,
    ).toBeGreaterThan(0);
    expect(
      section.element.querySelector('.agent-item')?.classList.contains('agent-item--active'),
    ).toBe(false);
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
      supportsInteractiveLogin: false,
    };
    const localB: AgentDefinition = {
      id: 'local-b' as AgentId,
      label: 'Local B',
      requiresAuth: false,
      supportsInteractiveLogin: false,
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

  it('shows a settings-derived marker on a provider whose runtime is not running', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const rows = section.element.querySelectorAll('.agent-item__auth');
    expect(rows).toHaveLength(2);
    // The second provider (OpenRouter) is not the configured one, so its
    // runtime is not started; its marker is derived from settings alone and the
    // row must remain visible (the defect: a non-configured row had no marker).
    expect(rows[1]?.hasAttribute('hidden')).toBe(false);
    expect(rows[1]?.querySelector('sp-status-light')?.textContent?.length).toBeGreaterThan(0);
    // Only the configured provider offers a sign-in/out action.
    expect(rows[1]?.querySelector('.agent-item__action')).toBeNull();
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

    expect(section.element.querySelector('.agent-item__active')).not.toBeNull();
    const light = section.element.querySelector('.agent-item__auth sp-status-light');
    expect(light?.getAttribute('variant')).toBe('positive');
    expect(light?.textContent).toBeTruthy();
  });

  it('offers "Sign in", not "Sign out", when the stored token is what authenticates the runtime', async () => {
    // The runtime resolves the injected COPILOT_GITHUB_TOKEN before the vault
    // session, so a token-only setup reports `authType: "env"`. The status row
    // still says "Authenticated with API key (token)", but the action must describe the
    // (absent) interactive session - a local sign-out would change nothing.
    const signedOut = buildSection();
    await signedOut.refresh(snapshotWith({ copilot: { active: true } }));
    const signInLabel = signedOut.element.querySelector('.agent-item__action')?.textContent;
    expect(signInLabel?.length).toBeGreaterThan(0);

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
    expect(light?.textContent).toBeTruthy();

    const actions = section.element.querySelectorAll('.agent-item__action');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.textContent).toBe(signInLabel);
  });

  it('updates the provider row in place instead of rebuilding its pickers', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const item = section.element.querySelector('.agent-item');
    const pickers = [...(item?.querySelectorAll('sp-picker') ?? [])];
    expect(pickers).toHaveLength(3);

    // The panel reloads after every save, so a refresh is the common path. It
    // must reuse the row and its pickers: re-creating a Spectrum picker blanks
    // it for a frame - the flicker this in-place update exists to remove.
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    expect(section.element.querySelector('.agent-item')).toBe(item);
    const again = [...(item?.querySelectorAll('sp-picker') ?? [])];
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
        catalogUnavailable: false,
      },
    });

    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const modelPicker = section.element.querySelector(byField('agent-model'));
    const reasoningPicker = section.element.querySelector(byField('agent-reasoning-effort'));

    getModelSelection.mockResolvedValue({
      ok: true,
      state: {
        models: [
          { id: 'model-a', name: 'Model A', supportedReasoningEfforts: ['low', 'high'] },
          { id: 'model-b', name: 'Model B', supportedReasoningEfforts: [] },
        ],
        selectedModel: 'model-b',
        selectedReasoningEffort: null,
        catalogUnavailable: false,
      },
    });
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    // Same elements, new values: the selection moved without a rebuild.
    expect(section.element.querySelector(byField('agent-model'))).toBe(modelPicker);
    expect(section.element.querySelector(byField('agent-reasoning-effort'))).toBe(reasoningPicker);
    expect((modelPicker as HTMLElement & { value: string }).value).toBe('model-b');
    expect((reasoningPicker as HTMLElement & { value: string }).value).toBe(NO_PREFERENCE_VALUE);
  });

  it('persists a picker change on change, with no debounce', async () => {
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
        catalogUnavailable: false,
      },
    });

    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const modelPicker = section.element.querySelector(byField('agent-model')) as HTMLElement & {
      value: string;
    };
    modelPicker.value = 'model-b';
    modelPicker.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    // One macrotask settles the serialization hop; a 1 s debounce would leave
    // this un-called here.
    await settleCommit();

    expect(setModelPreferences).toHaveBeenCalledWith({ model: 'model-b', reasoningEffort: null });
    // The committed change alters the snapshot, so the shell must be told:
    // otherwise the chat pane's agent/model/reasoning footer keeps showing the
    // previous model until some unrelated settings edit happens to reload it.
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('re-reads but does not signal a settings change when the model save is refused', async () => {
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
        catalogUnavailable: false,
      },
    });
    setModelPreferences.mockResolvedValue({
      ok: false,
      error: { code: 'model_not_available', message: 'The agent does not offer that model' },
    });

    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    const modelPicker = section.element.querySelector(byField('agent-model')) as HTMLElement & {
      value: string;
    };
    modelPicker.value = 'model-b';
    modelPicker.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleCommit();

    // Nothing was persisted, so the snapshot did not change and the shell must
    // not be told; the section still re-reads to reset the picker.
    expect(setModelPreferences).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it('auto-activates the provider a token just made eligible when none is active', async () => {
    // A bare install: no provider can serve. Entering a token for the second
    // provider (OpenRouter) must not leave the user staring at "Set active".
    const section = buildSection();
    await section.refresh(snapshotWith({}));

    tokenControlAt(section, 1).setToken('sk-or-secret');
    await flush();

    expect(setPassword).toHaveBeenCalledExactlyOnceWith(
      { kind: 'agent', agentId: 'openrouter' },
      'sk-or-secret',
    );

    // The panel reloads after the save; the fresh snapshot carries the token.
    await section.refresh(snapshotWith({ openrouter: { active: false, hasToken: true } }));

    expect(setAgentSettings).toHaveBeenCalledExactlyOnceWith({
      agentId: 'openrouter',
      changes: { active: true },
    });
  });

  it('does not auto-activate a provider while another is already active', async () => {
    getAuthStatus.mockResolvedValue({ apiVersion: 1, isAuthenticated: true, login: 'octocat' });
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: true } }));

    tokenControlAt(section, 1).setToken('sk-or-secret');
    await flush();

    await section.refresh(
      snapshotWith({ copilot: { active: true }, openrouter: { active: false, hasToken: true } }),
    );

    expect(setAgentSettings).not.toHaveBeenCalled();
  });

  it('does not write the active flag when the configured provider resolves active anyway', async () => {
    // The first provider is the configured one; once its token makes it
    // eligible, effective-active resolution already selects it, so the shortcut
    // must not add a second, redundant write (which would disturb the save
    // banner for no reason).
    const section = buildSection();
    await section.refresh(snapshotWith({}));

    tokenControlAt(section, 0).setToken('ghp_secret');
    await flush();

    await section.refresh(snapshotWith({ copilot: { active: false, hasToken: true } }));

    expect(setAgentSettings).not.toHaveBeenCalled();
  });

  it('does not activate on a token clear', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ openrouter: { active: false, hasToken: true } }));

    tokenControlAt(section, 1).clearToken();
    await flush();

    expect(clearPassword).toHaveBeenCalledExactlyOnceWith({ kind: 'agent', agentId: 'openrouter' });

    await section.refresh(snapshotWith({ openrouter: { active: false, hasToken: false } }));

    expect(setAgentSettings).not.toHaveBeenCalled();
  });

  it('does not activate on a clear even when the provider stays eligible via a session', async () => {
    // The guard that only a *set* arms the shortcut, proven where it matters:
    // the configured provider is a token-only one (OpenRouter) that is signed
    // out, while the interactive Copilot still has a detected local session and
    // a token - eligible, but not active. Clearing Copilot's token must not
    // activate it (a clear is not a credential action that makes a provider able
    // to serve); without the `set`-only guard this case would activate Copilot.
    getAuthPresence.mockImplementation((agentId: string) =>
      Promise.resolve({ present: agentId === 'copilot' }),
    );
    const section = buildSection();
    await section.refresh(
      snapshotWith({ openrouter: { active: true }, copilot: { active: false, hasToken: true } }),
    );

    tokenControlAt(section, 0).clearToken();
    await flush();

    expect(clearPassword).toHaveBeenCalledExactlyOnceWith({ kind: 'agent', agentId: 'copilot' });

    await section.refresh(
      snapshotWith({ openrouter: { active: true }, copilot: { active: false, hasToken: false } }),
    );

    expect(setAgentSettings).not.toHaveBeenCalled();
  });
});
