import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BANNER_ACTION_MARKER } from '../../../../src/renderer/src/lib/alertBanner';
import { createHostsSection } from '../../../../src/renderer/src/settings/hostsSection';
import type {
  SaveOutcome,
  StatusBannerAction,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';
import {
  newProjectId,
  newProxyId,
  newServerId,
  projectSnapshotSchema,
  proxySnapshotSchema,
  serverSnapshotSchema,
  type ProjectSnapshot,
  type ProxySnapshot,
  type ServerSnapshot,
} from '../../../../src/shared';
import {
  PROXY_DEFAULT_VALUE,
  PROXY_NONE_VALUE,
} from '../../../../src/renderer/src/settings/proxyPicker';
import { PROJECT_DEFAULT_VALUE } from '../../../../src/renderer/src/settings/projectPicker';

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

const addServer = vi.fn();
const removeServer = vi.fn();
const updateServerPresentation = vi.fn();
const updateServerTargeting = vi.fn();
const reorderServers = vi.fn();

function snapshot(
  id: string,
  origin: string,
  label: string,
  options: { swatch?: string; proxyId?: string; projectId?: string } = {},
): ServerSnapshot {
  return serverSnapshotSchema.parse({
    id: newServerId(() => id),
    label,
    origin,
    color: { kind: 'swatch', swatch: options.swatch ?? 'blue' },
    ...(options.proxyId !== undefined ? { proxyId: options.proxyId } : {}),
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    revision: 0,
  });
}

function proxySnapshot(id: string, label: string, url: string): ProxySnapshot {
  return proxySnapshotSchema.parse({ id: newProxyId(() => id), label, url });
}

function projectSnapshot(id: string, label: string): ProjectSnapshot {
  return projectSnapshotSchema.parse({ id: newProjectId(() => id), label });
}

function proxyMenuLabels(picker: HTMLElement): string[] {
  return [...picker.querySelectorAll('sp-menu-item')].map((item) => item.textContent ?? '');
}

function proxyMenuValues(picker: HTMLElement): string[] {
  return [...picker.querySelectorAll('sp-menu-item')].map(
    (item) => item.getAttribute('value') ?? '',
  );
}

function chooseProxy(picker: HTMLElement & { value: string }, value: string): void {
  picker.value = value;
  picker.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

interface PromptCapture {
  copy: string;
  action: StatusBannerAction;
}

let status: StatusBannerSink;
let lastPrompt: PromptCapture | undefined;
let reportSave: (outcome: Promise<SaveOutcome>) => void;
let onSettingsChanged: () => void;
const showPrompt = vi.fn<(copy: string, action: StatusBannerAction) => void>();

function buildSection() {
  return createHostsSection({ status, reportSave, onSettingsChanged });
}

function field(
  root: ParentNode,
  ariaLabel: 'Address' | 'Label' | 'Color tag' | 'Proxy' | 'Project',
) {
  return root.querySelector<HTMLElement & { value: string }>(`[aria-label="${ariaLabel}"]`);
}

function type(node: HTMLElement & { value: string }, value: string): void {
  node.value = value;
  node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

/** Leaves the field (`change`: blur or Enter), which is when a value commits. */
function commit(node: HTMLElement): void {
  node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

function typeAndCommit(node: HTMLElement & { value: string }, value: string): void {
  type(node, value);
  commit(node);
}

async function settle(ms = 1000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  addServer.mockReset();
  removeServer.mockReset();
  updateServerPresentation.mockReset();
  updateServerTargeting.mockReset();
  reorderServers.mockReset();

  addServer.mockResolvedValue({
    ok: true,
    server: snapshot('created', 'https://created.example', 'Created'),
  });
  removeServer.mockResolvedValue({ ok: true });
  updateServerPresentation.mockResolvedValue({ ok: true, server: null });
  updateServerTargeting.mockResolvedValue({ ok: true, server: null, kind: 'origin_changed' });
  reorderServers.mockResolvedValue({ ok: true });

  lastPrompt = undefined;
  showPrompt.mockReset();
  showPrompt.mockImplementation((copy, action) => {
    lastPrompt = { copy, action };
  });
  status = {
    showStatus: vi.fn(),
    showError: vi.fn(),
    showPrompt,
    showNotice: vi.fn(),
    clear: vi.fn(),
  };
  reportSave = vi.fn<(outcome: Promise<SaveOutcome>) => void>();
  onSettingsChanged = vi.fn<() => void>();

  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
  Reflect.set(dom.window, 'daisy', {
    settings: {
      addServer,
      removeServer,
      updateServerPresentation,
      updateServerTargeting,
      reorderServers,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

describe('createHostsSection', () => {
  it('renders one labelled item per host with no empty draft', () => {
    const section = buildSection();
    section.update([
      snapshot('a', 'https://a.example', 'A'),
      snapshot('b', 'https://b.example', 'B'),
    ]);

    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(2);
    expect(field(section.element, 'Address')?.value).toBe('https://a.example');
    expect(field(section.element, 'Label')?.value).toBe('A');
    // Address, Color tag, Label, Proxy, Project per item.
    expect(section.element.querySelectorAll('sp-field-label')).toHaveLength(10);
    expect(section.element.querySelectorAll('.multifield__action--remove')).toHaveLength(2);
  });

  it('adds an empty draft only when "Add item" is clicked', () => {
    const section = buildSection();
    section.update([]);
    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(0);

    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(1);
    expect(field(section.element, 'Address')?.value).toBe('');
    // Default colour is the blue swatch.
    expect(field(section.element, 'Color tag')?.value).toBe('#2680eb');
    expect(section.hasPendingEdits()).toBe(true);
  });

  it('creates a draft through addServer on the first valid address, defaulting the label to it', async () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const address = field(section.element, 'Address');
    if (!address) throw new Error('missing address field');
    typeAndCommit(address, 'https://draft.example');
    await settle();

    expect(addServer).toHaveBeenCalledExactlyOnceWith({
      label: 'https://draft.example',
      origin: 'https://draft.example',
      color: { kind: 'swatch', swatch: 'blue' },
    });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(reportSave).toHaveBeenCalledTimes(1);
  });

  it('does not save while typing, and only commits when the field is left', async () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const address = field(section.element, 'Address');
    if (!address) throw new Error('missing address field');
    // A typing pause (no `change`) must not create the host: this is the
    // reported defect - a pause used to fire the save and turn further typing
    // into an origin change.
    type(address, 'https://loc');
    await settle();
    expect(addServer).not.toHaveBeenCalled();
    expect(reportSave).not.toHaveBeenCalled();

    // Continuing to type still saves nothing...
    type(address, 'https://localhost');
    await settle();
    expect(addServer).not.toHaveBeenCalled();

    // ...and only leaving the field commits the full value.
    commit(address);
    await settle();
    expect(addServer).toHaveBeenCalledExactlyOnceWith({
      label: 'https://localhost',
      origin: 'https://localhost',
      color: { kind: 'swatch', swatch: 'blue' },
    });
  });

  it('saves a label change on an existing host via updateServerPresentation', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'https://a.example', 'A')]);

    const label = field(section.element, 'Label');
    if (!label) throw new Error('missing label field');
    typeAndCommit(label, 'Renamed');
    await settle();

    expect(updateServerPresentation).toHaveBeenCalledExactlyOnceWith({
      serverId: newServerId(() => 'a'),
      changes: { label: 'Renamed', color: { kind: 'swatch', swatch: 'blue' } },
    });
    expect(updateServerTargeting).not.toHaveBeenCalled();
  });

  it('saves a colour change', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'https://a.example', 'A')]);

    const color = field(section.element, 'Color tag');
    if (!color) throw new Error('missing colour field');
    typeAndCommit(color, '#9256d9');
    await settle();

    expect(updateServerPresentation).toHaveBeenCalledExactlyOnceWith({
      serverId: newServerId(() => 'a'),
      changes: { label: 'A', color: { kind: 'swatch', swatch: 'purple' } },
    });
  });

  it('saves a project change via updateServerPresentation', async () => {
    const section = buildSection();
    const hpe = projectSnapshot('project-a', 'HPE');
    section.update([snapshot('a', 'https://a.example', 'A')], [], [hpe]);

    const project = field(section.element, 'Project');
    if (!project) throw new Error('missing project picker');
    chooseProxy(
      project,
      newProjectId(() => 'project-a'),
    );
    await settle();

    expect(updateServerPresentation).toHaveBeenCalledExactlyOnceWith({
      serverId: newServerId(() => 'a'),
      changes: { projectId: newProjectId(() => 'project-a') },
    });
    // A project is presentation, never a targeting change.
    expect(updateServerTargeting).not.toHaveBeenCalled();
  });

  it('returns a host to "(Default)" by sending projectId: null', async () => {
    const section = buildSection();
    const hpe = projectSnapshot('project-a', 'HPE');
    section.update(
      [snapshot('a', 'https://a.example', 'A', { projectId: newProjectId(() => 'project-a') })],
      [],
      [hpe],
    );

    const project = field(section.element, 'Project');
    if (!project) throw new Error('missing project picker');
    chooseProxy(project, PROJECT_DEFAULT_VALUE);
    await settle();

    expect(updateServerPresentation).toHaveBeenCalledExactlyOnceWith({
      serverId: newServerId(() => 'a'),
      changes: { projectId: null },
    });
  });

  it('carries a chosen project into addServer when a draft is created', async () => {
    const section = buildSection();
    const hpe = projectSnapshot('project-a', 'HPE');
    section.update([], [], [hpe]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const address = field(section.element, 'Address');
    const project = field(section.element, 'Project');
    if (!address || !project) throw new Error('missing fields');
    chooseProxy(
      project,
      newProjectId(() => 'project-a'),
    );
    typeAndCommit(address, 'https://new.example');
    await settle();

    expect(addServer).toHaveBeenCalledExactlyOnceWith({
      label: 'https://new.example',
      origin: 'https://new.example',
      color: { kind: 'swatch', swatch: 'blue' },
      projectId: newProjectId(() => 'project-a'),
    });
  });

  it('shows an inline invalid state instead of saving for a bad address', async () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const address = field(section.element, 'Address');
    if (!address) throw new Error('missing address field');
    typeAndCommit(address, 'not a url');
    await settle();

    expect(address.hasAttribute('invalid')).toBe(true);
    expect(address.querySelector('[slot="negative-help-text"]')?.textContent).toMatch(
      /valid address/,
    );
    expect(addServer).not.toHaveBeenCalled();
    expect(reportSave).not.toHaveBeenCalled();
  });

  it('requires a confirmation before persisting an address change', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'https://a.example', 'A')]);

    const address = field(section.element, 'Address');
    if (!address) throw new Error('missing address field');
    // Typing a new address does not raise the warning on a pause...
    type(address, 'https://moved.example');
    await settle();
    expect(showPrompt).not.toHaveBeenCalled();
    expect(updateServerTargeting).not.toHaveBeenCalled();

    // ...only leaving the field does.
    commit(address);
    await settle();

    expect(updateServerTargeting).not.toHaveBeenCalled();
    expect(lastPrompt?.copy).toBe(`Press ${BANNER_ACTION_MARKER} to change the address`);

    lastPrompt?.action.onActivate();
    await settle();

    expect(updateServerTargeting).toHaveBeenCalledExactlyOnceWith({
      serverId: newServerId(() => 'a'),
      changes: { origin: 'https://moved.example' },
      originChangeConfirmed: true,
    });
  });

  it('persists the persisted-host order after a move', async () => {
    const section = buildSection();
    section.update([
      snapshot('a', 'https://a.example', 'A'),
      snapshot('b', 'https://b.example', 'B'),
    ]);

    const firstRow = section.element.querySelector('.multifield__item');
    firstRow
      ?.querySelector('.multifield__action--down')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();

    expect(reorderServers).toHaveBeenCalledExactlyOnceWith({
      serverIds: [newServerId(() => 'b'), newServerId(() => 'a')],
    });
  });

  it('confirms a saved host removal and removes its row', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'https://a.example', 'A')]);

    section.element
      .querySelector('.multifield__action--remove')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(lastPrompt?.copy).toBe(`Press ${BANNER_ACTION_MARKER} to remove the host`);
    expect(removeServer).not.toHaveBeenCalled();

    lastPrompt?.action.onActivate();
    await settle();

    expect(removeServer).toHaveBeenCalledExactlyOnceWith({ serverId: newServerId(() => 'a') });
    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(0);
  });

  it('removes a draft immediately, with no confirmation', () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    section.element
      .querySelector('.multifield__action--remove')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(0);
    expect(showPrompt).not.toHaveBeenCalled();
    expect(removeServer).not.toHaveBeenCalled();
  });

  it('does not rebuild rows while a persisted host field holds focus', () => {
    const section = buildSection();
    // jsdom only focuses an element that is attached to the document.
    dom.window.document.body.append(section.element);
    section.update([snapshot('a', 'https://a.example', 'A')]);

    const label = field(section.element, 'Label');
    if (!label) throw new Error('missing label field');
    // The real Spectrum field is focusable; jsdom's un-upgraded host is not
    // unless it is given a tabindex.
    label.setAttribute('tabindex', '0');
    label.focus();
    expect(dom.window.document.activeElement).toBe(label);

    // The reload that follows an auto-save must not tear the row down: doing so
    // detaches the focused field and drops the caret mid-typing.
    section.update([snapshot('a', 'https://a.example', 'A')]);

    expect(section.element.contains(label)).toBe(true);
    expect(dom.window.document.activeElement).toBe(label);
  });

  it('does not let a snapshot update clobber an unsaved draft', () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const address = field(section.element, 'Address');
    if (!address) throw new Error('missing address field');
    type(address, 'https://draft.example');

    section.update([snapshot('a', 'https://a.example', 'A')]);

    // The draft survives; the incoming server is not applied until the draft is
    // resolved (saved or removed).
    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(1);
    expect(field(section.element, 'Address')?.value).toBe('https://draft.example');
  });

  describe('Proxy combobox', () => {
    const corp = proxySnapshot('p1', 'Corporate', 'https://proxy.example:8080');
    const home = proxySnapshot('p2', 'Home', 'https://home.example:3128');

    it('offers "(Default)" and "(No proxy)" plus every library label, and stores ids', () => {
      const section = buildSection();
      section.update([snapshot('a', 'https://a.example', 'A')], [corp, home]);

      const picker = field(section.element, 'Proxy');
      if (!picker) throw new Error('missing proxy picker');
      // Labels are shown...
      expect(proxyMenuLabels(picker)).toEqual(['(Default)', '(No proxy)', 'Corporate', 'Home']);
      // ...but the item values (what is stored) are the sentinels and ids.
      expect(proxyMenuValues(picker)).toEqual([
        PROXY_DEFAULT_VALUE,
        PROXY_NONE_VALUE,
        String(newProxyId(() => 'p1')),
        String(newProxyId(() => 'p2')),
      ]);
      // Host 'a' has no explicit selection, so "(Default)" is selected.
      expect(picker.value).toBe(PROXY_DEFAULT_VALUE);
    });

    it('preselects the stored library id', () => {
      const section = buildSection();
      section.update([snapshot('a', 'https://a.example', 'A', { proxyId: 'p1' })], [corp, home]);

      const picker = field(section.element, 'Proxy');
      expect(picker?.value).toBe(String(newProxyId(() => 'p1')));
    });

    it('preselects "(No proxy)" for the explicit no-proxy sentinel', () => {
      const section = buildSection();
      section.update([snapshot('a', 'https://a.example', 'A', { proxyId: 'none' })], [corp, home]);

      const picker = field(section.element, 'Proxy');
      expect(picker?.value).toBe(PROXY_NONE_VALUE);
    });

    it('persists the chosen id via updateServerTargeting', async () => {
      const section = buildSection();
      section.update([snapshot('a', 'https://a.example', 'A')], [corp, home]);

      const picker = field(section.element, 'Proxy');
      if (!picker) throw new Error('missing proxy picker');
      chooseProxy(picker, String(newProxyId(() => 'p1')));
      await Promise.resolve();

      expect(updateServerTargeting).toHaveBeenCalledExactlyOnceWith({
        serverId: newServerId(() => 'a'),
        changes: { proxyId: newProxyId(() => 'p1') },
      });
    });

    it('persists the "No proxy" sentinel when that choice is made', async () => {
      const section = buildSection();
      section.update([snapshot('a', 'https://a.example', 'A', { proxyId: 'p1' })], [corp, home]);

      const picker = field(section.element, 'Proxy');
      if (!picker) throw new Error('missing proxy picker');
      chooseProxy(picker, PROXY_NONE_VALUE);
      await Promise.resolve();

      expect(updateServerTargeting).toHaveBeenCalledExactlyOnceWith({
        serverId: newServerId(() => 'a'),
        changes: { proxyId: 'none' },
      });
    });

    it('resets to "(Default)" with null when that choice is made', async () => {
      const section = buildSection();
      section.update([snapshot('a', 'https://a.example', 'A', { proxyId: 'p1' })], [corp, home]);

      const picker = field(section.element, 'Proxy');
      if (!picker) throw new Error('missing proxy picker');
      chooseProxy(picker, PROXY_DEFAULT_VALUE);
      await Promise.resolve();

      expect(updateServerTargeting).toHaveBeenCalledExactlyOnceWith({
        serverId: newServerId(() => 'a'),
        changes: { proxyId: null },
      });
    });

    it('reflects library changes made in parallel (added entries)', () => {
      const section = buildSection();
      const host = snapshot('a', 'https://a.example', 'A');
      section.update([host], [corp]);

      section.update([host], [corp, home]);

      const picker = field(section.element, 'Proxy');
      expect(proxyMenuLabels(picker!)).toEqual(['(Default)', '(No proxy)', 'Corporate', 'Home']);
    });

    it('reflects a renamed entry without changing the stored id', () => {
      const section = buildSection();
      const host = snapshot('a', 'https://a.example', 'A', { proxyId: 'p1' });
      section.update([host], [corp]);

      const renamed = proxySnapshot('p1', 'Corporate HQ', 'https://proxy.example:8080');
      section.update([host], [renamed]);

      const picker = field(section.element, 'Proxy');
      expect(picker?.value).toBe(String(newProxyId(() => 'p1')));
      expect(proxyMenuLabels(picker!)).toEqual(['(Default)', '(No proxy)', 'Corporate HQ']);
    });

    it('falls back to "(Default)" when the selected entry no longer exists', () => {
      const section = buildSection();
      section.update([snapshot('a', 'https://a.example', 'A', { proxyId: 'p1' })], [corp]);

      section.update([snapshot('a', 'https://a.example', 'A', { proxyId: 'p1' })], []);

      const picker = field(section.element, 'Proxy');
      expect(picker?.value).toBe(PROXY_DEFAULT_VALUE);
    });

    it("applies a draft's chosen proxy once addServer creates the host", async () => {
      const section = buildSection();
      section.update([], [corp]);

      section.element
        .querySelector('.multifield__add')
        ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      const picker = field(section.element, 'Proxy');
      if (!picker) throw new Error('missing proxy picker');
      chooseProxy(picker, String(newProxyId(() => 'p1')));

      const address = field(section.element, 'Address');
      if (!address) throw new Error('missing address field');
      typeAndCommit(address, 'https://draft.example');
      await settle();

      expect(addServer).toHaveBeenCalledTimes(1);
      expect(updateServerTargeting).toHaveBeenCalledExactlyOnceWith({
        serverId: newServerId(() => 'created'),
        changes: { proxyId: newProxyId(() => 'p1') },
      });
    });

    it('applies a draft\'s explicit "No proxy" choice once addServer creates the host', async () => {
      const section = buildSection();
      section.update([], [corp]);

      section.element
        .querySelector('.multifield__add')
        ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      const picker = field(section.element, 'Proxy');
      if (!picker) throw new Error('missing proxy picker');
      chooseProxy(picker, PROXY_NONE_VALUE);

      const address = field(section.element, 'Address');
      if (!address) throw new Error('missing address field');
      typeAndCommit(address, 'https://draft.example');
      await settle();

      expect(updateServerTargeting).toHaveBeenCalledExactlyOnceWith({
        serverId: newServerId(() => 'created'),
        changes: { proxyId: 'none' },
      });
    });
  });
});
