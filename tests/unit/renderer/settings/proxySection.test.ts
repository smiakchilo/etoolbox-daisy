import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProxySection } from '../../../../src/renderer/src/settings/proxySection';
import type {
  SaveOutcome,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;
const setCopilotProxy = vi.fn(() => Promise.resolve({ ok: true }));

let status: StatusBannerSink;
let reportSave: (outcome: Promise<SaveOutcome>) => void;
let onCredentialsChanged: () => void;
const showError = vi.fn<(message: string) => void>();

function createStatusStub(): StatusBannerSink {
  return { showStatus: vi.fn(), showError, showPrompt: vi.fn(), clear: vi.fn() };
}

function buildSection() {
  return createProxySection({ onCredentialsChanged, status, reportSave });
}

beforeEach(() => {
  vi.useFakeTimers();
  setCopilotProxy.mockClear();
  showError.mockClear();
  status = createStatusStub();
  reportSave = vi.fn<(outcome: Promise<SaveOutcome>) => void>();
  onCredentialsChanged = vi.fn<() => void>();
  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
  Reflect.set(dom.window, 'daisy', { settings: { setCopilotProxy } });
});

afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

it('saves proxy edits together after one second of inactivity without a Save click', async () => {
  const section = buildSection();
  section.update(undefined);
  const address = section.element.querySelector<HTMLElement & { value: string }>(
    '[aria-label="Copilot proxy address"]',
  );
  const username = section.element.querySelector<HTMLElement & { value: string }>(
    '[aria-label="Copilot proxy username"]',
  );
  if (!address || !username) throw new Error('Missing proxy fields');
  address.value = 'https://proxy.example:8080';
  address.dispatchEvent(new dom.window.Event('input'));
  await vi.advanceTimersByTimeAsync(750);
  username.value = 'test-user';
  username.dispatchEvent(new dom.window.Event('input'));
  await vi.advanceTimersByTimeAsync(999);
  expect(setCopilotProxy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(setCopilotProxy).toHaveBeenCalledExactlyOnceWith({
    url: 'https://proxy.example:8080',
    username: 'test-user',
  });
  // The save is reported into the panel's save reporter (which drives the
  // "Saving..." -> "Settings saved" sequence), and a successful save tells
  // the panel to re-read.
  expect(reportSave).toHaveBeenCalledTimes(1);
  expect(onCredentialsChanged).toHaveBeenCalledTimes(1);
});

it('reports a validation failure to the banner instead of saving', async () => {
  const section = buildSection();
  section.update(undefined);
  const address = section.element.querySelector<HTMLElement & { value: string }>(
    '[aria-label="Copilot proxy address"]',
  );
  if (!address) throw new Error('Missing proxy address field');
  address.value = 'not a url';
  address.dispatchEvent(new dom.window.Event('input'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(setCopilotProxy).not.toHaveBeenCalled();
  expect(reportSave).not.toHaveBeenCalled();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining('must be a valid address'));
});

it('does not auto-save when the fields already match the stored value', async () => {
  const section = buildSection();
  section.update({
    url: 'https://proxy.example:8080',
    credentials: { username: 'keepme', hasPassword: false },
  });
  const address = section.element.querySelector<HTMLElement & { value: string }>(
    '[aria-label="Copilot proxy address"]',
  );
  const username = section.element.querySelector<HTMLElement & { value: string }>(
    '[aria-label="Copilot proxy username"]',
  );
  if (!address || !username) throw new Error('Missing proxy fields');
  // Editing back to the stored value is a no-op save: nothing persisted,
  // nothing reported.
  address.value = 'https://proxy.example:8080';
  address.dispatchEvent(new dom.window.Event('input'));
  expect(section.hasPendingEdits()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(setCopilotProxy).not.toHaveBeenCalled();
  expect(reportSave).not.toHaveBeenCalled();
  expect(onCredentialsChanged).not.toHaveBeenCalled();
  expect(section.hasPendingEdits()).toBe(false);
  void username;
});

it('reports unsaved edits precisely: a genuine change counts, a no-op impulse does not', async () => {
  const section = buildSection();
  section.update({
    url: 'https://proxy.example:8080',
    credentials: { username: 'keepme', hasPassword: false },
  });
  const address = section.element.querySelector<HTMLElement & { value: string }>(
    '[aria-label="Copilot proxy address"]',
  );
  const username = section.element.querySelector<HTMLElement & { value: string }>(
    '[aria-label="Copilot proxy username"]',
  );
  if (!address || !username) throw new Error('Missing proxy fields');
  username.value = 'keepme';

  // A blur-duplicated "change" that re-commits the stored value is not an
  // unsaved edit: the panel's reload guard must not skip this section for it
  // (that is what leaves a freshly-stored password invisible in the summary).
  address.value = 'https://proxy.example:8080';
  address.dispatchEvent(new dom.window.Event('input'));
  expect(section.hasPendingEdits()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(section.hasPendingEdits()).toBe(false);

  // A genuine edit counts, until it has been saved and the section updated.
  address.value = 'https://other.example:8080';
  address.dispatchEvent(new dom.window.Event('input'));
  expect(section.hasPendingEdits()).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(setCopilotProxy).toHaveBeenCalledExactlyOnceWith({
    url: 'https://other.example:8080',
    username: 'keepme',
  });
  expect(section.hasPendingEdits()).toBe(false);
});

it('re-fills the fields from a fresh snapshot on update', () => {
  const section = buildSection();
  section.update(undefined);
  const address = section.element.querySelector<HTMLElement & { value: string }>(
    '[aria-label="Copilot proxy address"]',
  );
  const username = section.element.querySelector<HTMLElement & { value: string }>(
    '[aria-label="Copilot proxy username"]',
  );
  if (!address || !username) throw new Error('Missing proxy fields');
  section.update({
    url: 'https://dedicated.example:3128',
    credentials: { username: 'proxy-user', hasPassword: true },
  });
  expect(address.value).toBe('https://dedicated.example:3128');
  expect(username.value).toBe('proxy-user');
});
