import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentsSection } from '../../../../src/renderer/src/settings/agentsSection';
import type {
  SaveOutcome,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';
import { parseAppSettingsSnapshot, type AppSettingsSnapshot } from '../../../../src/shared';

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

let status: StatusBannerSink;
let reportSave: (outcome: Promise<SaveOutcome>) => void;
let onSettingsChanged: () => void;

/** A snapshot with only the providers named - hosts, proxies and browser flags are irrelevant here. */
function snapshotWith(agents: Record<string, { active: boolean }>): AppSettingsSnapshot {
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

function buildSection() {
  return createAgentsSection({ status, reportSave, onSettingsChanged });
}

beforeEach(() => {
  getAuthStatus.mockReset();
  getModelSelection.mockReset();
  setAgentSettings.mockReset();

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
    settings: { getModelSelection, setAgentSettings },
  });
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

describe('createAgentsSection', () => {
  it('states that the active provider is active, with a badge instead of a control', async () => {
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

  it('offers the one control that would activate a provider the settings file does not', async () => {
    // A legal hand-edited document: a provider this build does not compile in
    // is named active, so the compiled-in one is rendered as inactive.
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: false }, opencode: { active: true } }));

    const setActive = section.element.querySelector('.agent-item__set-active');
    expect(setActive?.tagName.toLowerCase()).toBe('sp-action-button');
    expect(setActive?.textContent).toBe('Set active');
    expect(section.element.querySelector('.agent-item__active')).toBeNull();
    // A non-active provider has no runtime, so it offers no auth action at all.
    expect(section.element.querySelector('.agent-item__action')).toBeNull();
  });

  it('persists the active choice when Set active is clicked', async () => {
    const section = buildSection();
    await section.refresh(snapshotWith({ copilot: { active: false }, opencode: { active: true } }));

    const setActive = section.element.querySelector('.agent-item__set-active');
    setActive?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    expect(setAgentSettings).toHaveBeenCalledWith({
      agentId: 'copilot',
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
    ).toEqual(['Proxy', 'Model', 'Reasoning effort']);
  });
});
