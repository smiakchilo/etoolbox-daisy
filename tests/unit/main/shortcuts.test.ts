import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachShortcutHandling, resolveShortcut } from '../../../src/main/shortcuts';
import { makeInput } from '../../support/electronInput';
import { createFakeWebContents } from '../../support/fakeWebContents';

/**
 * The application-wide keyboard shortcut layer (`src/main/shortcuts.ts`).
 *
 * `shortcuts.ts` imports nothing from `electron` at runtime (types only), so
 * these tests drive it with plain fakes: a `Input` object and a fake
 * `WebContents` whose `before-input-event` listener can be invoked. What is
 * checked is the key map and the routing decision (consume + send a semantic
 * action, and bind the chat actions only where allowed) - the live keystroke
 * pipeline is what the built-app spec exercises.
 */

const preventDefaultSpy = vi.fn();

beforeEach(() => {
  preventDefaultSpy.mockClear();
});

interface ShortcutHarness {
  readonly send: ReturnType<typeof vi.fn>;
  readonly focusShell: ReturnType<typeof vi.fn>;
  readonly press: (input: Electron.Input) => void;
}

function attachHarness(allowChatShortcuts: boolean): ShortcutHarness {
  const source = createFakeWebContents();
  const send = vi.fn();
  const focusShell = vi.fn();
  attachShortcutHandling(source.webContents, { allowChatShortcuts, send, focusShell });
  return {
    send,
    focusShell,
    press: (input) => {
      source.emit('before-input-event', { preventDefault: preventDefaultSpy }, input);
    },
  };
}

describe('resolveShortcut', () => {
  it('maps the browser-navigation keys', () => {
    expect(resolveShortcut(makeInput('F5'))).toBe('browser.refresh');
    expect(resolveShortcut(makeInput('KeyR', { control: true }))).toBe('browser.refresh');
    expect(resolveShortcut(makeInput('ArrowLeft', { alt: true }))).toBe('browser.back');
    expect(resolveShortcut(makeInput('ArrowRight', { alt: true }))).toBe('browser.forward');
    expect(resolveShortcut(makeInput('Home', { alt: true }))).toBe('browser.home');
  });

  it('maps the address-bar and chat-pane keys', () => {
    expect(resolveShortcut(makeInput('KeyL', { control: true }))).toBe('browser.focusAddress');
    expect(resolveShortcut(makeInput('KeyH', { control: true }))).toBe('chat.history');
    expect(resolveShortcut(makeInput('KeyN', { control: true }))).toBe('chat.newSession');
    expect(resolveShortcut(makeInput('Comma', { control: true }))).toBe('chat.settings');
  });

  it('matches the physical key, so the layout does not change the binding', () => {
    // A non-Latin layout reports a different `key`; `code` is unchanged.
    expect(resolveShortcut(makeInput('KeyR', { control: true, key: 'я' }))).toBe('browser.refresh');
  });

  it('rejects a key-up, an auto-repeat, and every unclaimed combination', () => {
    const rejected: Electron.Input[] = [
      makeInput('KeyR', { control: true, type: 'keyUp' }),
      makeInput('KeyR', { control: true, isAutoRepeat: true }),
      // Shift is deliberately never claimed, so the DevTools combo and the
      // other Ctrl+Shift+<key> conventions are left to their own handlers.
      makeInput('KeyR', { control: true, shift: true }),
      makeInput('KeyH', { control: true, shift: true }),
      // Bare keys and other modifiers.
      makeInput('F5', { shift: true }),
      makeInput('KeyR'),
      makeInput('ArrowLeft'),
      makeInput('KeyL', { control: true, alt: true }),
      makeInput('KeyL', { meta: true }),
      // Claimed letters, but not for these keys.
      makeInput('KeyB', { control: true }),
      makeInput('KeyF', { control: true }),
      makeInput('KeyI', { control: true, shift: true }),
    ];
    for (const input of rejected) {
      expect(resolveShortcut(input)).toBeNull();
    }
  });
});

describe('attachShortcutHandling', () => {
  it('consumes a claimed key and sends its action', () => {
    const harness = attachHarness(true);

    harness.press(makeInput('F5'));

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith('browser.refresh');
  });

  it('leaves an unclaimed keystroke alone', () => {
    const harness = attachHarness(true);

    harness.press(makeInput('KeyQ'));

    expect(preventDefaultSpy).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('binds the chat actions on the shell only, leaving the AEM page its own letters', () => {
    const shell = attachHarness(true);
    const aemView = attachHarness(false);

    shell.press(makeInput('KeyH', { control: true }));
    expect(shell.send).toHaveBeenCalledWith('chat.history');

    aemView.press(makeInput('KeyH', { control: true }));
    expect(aemView.send).not.toHaveBeenCalled();
    // Not consumed either, so the page still sees the keystroke.
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it('still binds the shared browser-navigation keys on the AEM view', () => {
    const aemView = attachHarness(false);

    aemView.press(makeInput('ArrowLeft', { alt: true }));

    expect(aemView.send).toHaveBeenCalledWith('browser.back');
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the shell before asking it to focus the address bar', () => {
    const harness = attachHarness(true);

    harness.press(makeInput('KeyL', { control: true }));

    expect(harness.focusShell).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith('browser.focusAddress');
  });

  it('does not move focus for any other action', () => {
    const harness = attachHarness(true);

    harness.press(makeInput('KeyR', { control: true }));

    expect(harness.focusShell).not.toHaveBeenCalled();
  });
});
