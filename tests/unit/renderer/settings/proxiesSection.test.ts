import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BANNER_ACTION_MARKER } from '../../../../src/renderer/src/lib/alertBanner';
import { createProxiesSection } from '../../../../src/renderer/src/settings/proxiesSection';
import type {
  SaveOutcome,
  StatusBannerAction,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';
import { newProxyId, proxySnapshotSchema, type ProxySnapshot } from '../../../../src/shared';

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

const addProxy = vi.fn();
const updateProxy = vi.fn();
const removeProxy = vi.fn();
const reorderProxies = vi.fn();
const setPassword = vi.fn();
const clearPassword = vi.fn();

function snapshot(
  id: string,
  url: string,
  label: string,
  credentials?: { username: string; hasPassword: boolean },
): ProxySnapshot {
  return proxySnapshotSchema.parse({
    id: newProxyId(() => id),
    label,
    url,
    ...(credentials ? { credentials } : {}),
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
  return createProxiesSection({ status, reportSave, onSettingsChanged });
}

function field(root: ParentNode, ariaLabel: 'Address' | 'Label' | 'User name' | 'Password') {
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
  addProxy.mockReset();
  updateProxy.mockReset();
  removeProxy.mockReset();
  reorderProxies.mockReset();
  setPassword.mockReset();
  clearPassword.mockReset();

  addProxy.mockResolvedValue({
    ok: true,
    proxy: snapshot('created', 'https://created.example', 'Created'),
  });
  updateProxy.mockResolvedValue({ ok: true });
  removeProxy.mockResolvedValue({ ok: true });
  reorderProxies.mockResolvedValue({ ok: true });
  setPassword.mockResolvedValue({ ok: true });
  clearPassword.mockResolvedValue({ ok: true });

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
      addProxy,
      updateProxy,
      removeProxy,
      reorderProxies,
      setPassword,
      clearPassword,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

describe('createProxiesSection', () => {
  it('renders one labelled item per proxy with the four field labels and quiet Set/Clear actions', () => {
    const section = buildSection();
    section.update([
      snapshot('a', 'https://a.example', 'A'),
      snapshot('b', 'https://b.example', 'B'),
    ]);

    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(2);
    expect(field(section.element, 'Address')?.value).toBe('https://a.example');
    expect(field(section.element, 'Label')?.value).toBe('A');
    expect(field(section.element, 'User name')?.value).toBe('');
    expect(section.element.querySelectorAll('sp-field-label')).toHaveLength(8);

    const passwordRow = section.element.querySelector('.password-control');
    expect(passwordRow).not.toBeNull();
    const buttons = [...(passwordRow?.querySelectorAll('sp-action-button') ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual(['Set', 'Clear']);
    for (const button of buttons) expect(button.hasAttribute('quiet')).toBe(true);
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
    expect(section.hasPendingEdits()).toBe(true);
  });

  it('creates a draft through addProxy on the first valid address, defaulting the label to it', async () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const address = field(section.element, 'Address');
    if (!address) throw new Error('missing address field');
    type(address, 'https://draft.example');
    await settle();

    expect(addProxy).toHaveBeenCalledExactlyOnceWith({
      label: 'https://draft.example',
      url: 'https://draft.example',
    });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(reportSave).toHaveBeenCalledTimes(1);
  });

  it('saves a label change on an existing proxy via updateProxy', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'https://a.example', 'A')]);

    const label = field(section.element, 'Label');
    if (!label) throw new Error('missing label field');
    type(label, 'Renamed');
    await settle();

    expect(updateProxy).toHaveBeenCalledExactlyOnceWith({
      proxyId: newProxyId(() => 'a'),
      label: 'Renamed',
      url: 'https://a.example',
    });
  });

  it('includes the username in the update when one is configured', async () => {
    const section = buildSection();
    section.update([
      snapshot('a', 'https://a.example', 'A', { username: 'alice', hasPassword: true }),
    ]);

    const username = field(section.element, 'User name');
    if (!username) throw new Error('missing username field');
    type(username, 'bob');
    await settle();

    expect(updateProxy).toHaveBeenCalledExactlyOnceWith({
      proxyId: newProxyId(() => 'a'),
      label: 'A',
      url: 'https://a.example',
      username: 'bob',
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
    expect(addProxy).not.toHaveBeenCalled();
    expect(reportSave).not.toHaveBeenCalled();
  });

  it('sets a password through setPassword targeting the proxy id', async () => {
    const section = buildSection();
    section.update([
      snapshot('a', 'https://a.example', 'A', { username: 'alice', hasPassword: false }),
    ]);

    const password = field(section.element, 'Password');
    if (!password) throw new Error('missing password field');
    password.value = 'secret';
    const setButton = section.element.querySelector('.password-control sp-action-button');
    setButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle(0);

    expect(setPassword).toHaveBeenCalledExactlyOnceWith(
      { kind: 'proxy', proxyId: newProxyId(() => 'a') },
      'secret',
    );
    expect(password.value).toBe('');
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('clears a password through clearPassword targeting the proxy id', async () => {
    const section = buildSection();
    section.update([
      snapshot('a', 'https://a.example', 'A', { username: 'alice', hasPassword: true }),
    ]);

    const clearButton = section.element.querySelectorAll('.password-control sp-action-button')[1];
    clearButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle(0);

    expect(clearPassword).toHaveBeenCalledExactlyOnceWith({
      kind: 'proxy',
      proxyId: newProxyId(() => 'a'),
    });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('persists the proxy order after a move', async () => {
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

    expect(reorderProxies).toHaveBeenCalledExactlyOnceWith({
      proxyIds: [newProxyId(() => 'b'), newProxyId(() => 'a')],
    });
  });

  it('confirms a saved proxy removal and removes its row', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'https://a.example', 'A')]);

    section.element
      .querySelector('.multifield__action--remove')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(lastPrompt?.copy).toBe(
      `Removing the proxy cannot be undone. Press ${BANNER_ACTION_MARKER} to remove it`,
    );
    expect(removeProxy).not.toHaveBeenCalled();

    lastPrompt?.action.onActivate();
    await settle();

    expect(removeProxy).toHaveBeenCalledExactlyOnceWith({ proxyId: newProxyId(() => 'a') });
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
    expect(removeProxy).not.toHaveBeenCalled();
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

    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(1);
    expect(field(section.element, 'Address')?.value).toBe('https://draft.example');
  });

  it('does not rebuild rows while a persisted proxy field holds focus', () => {
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
});
