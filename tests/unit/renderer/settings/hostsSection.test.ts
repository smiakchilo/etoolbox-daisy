import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostsSection } from '../../../../src/renderer/src/settings/hostsSection';
import type {
  SaveOutcome,
  StatusBannerAction,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';
import { newServerId, serverSnapshotSchema, type ServerSnapshot } from '../../../../src/shared';

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

const addServer = vi.fn();
const removeServer = vi.fn();
const updateServerPresentation = vi.fn();
const updateServerTargeting = vi.fn();
const reorderServers = vi.fn();

function snapshot(id: string, origin: string, label: string, swatch = 'blue'): ServerSnapshot {
  return serverSnapshotSchema.parse({
    id: newServerId(() => id),
    label,
    origin,
    color: { kind: 'swatch', swatch },
    revision: 0,
  });
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

function field(root: ParentNode, ariaLabel: 'Address' | 'Label' | 'Color tag') {
  return root.querySelector<HTMLElement & { value: string }>(`[aria-label="${ariaLabel}"]`);
}

function type(node: HTMLElement & { value: string }, value: string): void {
  node.value = value;
  node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
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
    expect(section.element.querySelectorAll('sp-field-label')).toHaveLength(6);
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
    type(address, 'https://draft.example');
    await settle();

    expect(addServer).toHaveBeenCalledExactlyOnceWith({
      label: 'https://draft.example',
      origin: 'https://draft.example',
      color: { kind: 'swatch', swatch: 'blue' },
    });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(reportSave).toHaveBeenCalledTimes(1);
  });

  it('saves a label change on an existing host via updateServerPresentation', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'https://a.example', 'A')]);

    const label = field(section.element, 'Label');
    if (!label) throw new Error('missing label field');
    type(label, 'Renamed');
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
    type(color, '#9256d9');
    await settle();

    expect(updateServerPresentation).toHaveBeenCalledExactlyOnceWith({
      serverId: newServerId(() => 'a'),
      changes: { label: 'A', color: { kind: 'swatch', swatch: 'purple' } },
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
    type(address, 'not a url');
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
    type(address, 'https://moved.example');
    await settle();

    expect(updateServerTargeting).not.toHaveBeenCalled();
    expect(lastPrompt?.copy).toBe('Confirm changing the address');

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

    expect(lastPrompt?.copy).toBe('Confirm removing the host. This action cannot be undone');
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
});
