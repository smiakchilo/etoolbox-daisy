import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachShortcutHandling, resolveShortcut } from '../../../src/main/shortcuts';
import { makeInput } from '../../support/electronInput';
import { createFakeWebContents } from '../../support/fakeWebContents';

/**
 * The application-wide keyboard shortcut layer (`src/main/shortcuts.ts`).
 *
 * `shortcuts.ts` imports nothing from `electron` at runtime (types only) and
 * `zoom.ts` only calls two `WebContents` methods, so these tests drive it with
 * plain fakes: an `Input` object and a fake `WebContents` whose
 * `before-input-event` listener can be invoked. What is checked is the key map,
 * the routing decision (consume + send a semantic action, and bind the chat
 * actions only where allowed), and that zoom is applied to the source view
 * directly - the live keystroke pipeline is what the built-app spec exercises.
 */

const preventDefaultSpy = vi.fn();

beforeEach(() => {
  preventDefaultSpy.mockClear();
});

interface ShortcutHarness {
  readonly send: ReturnType<typeof vi.fn>;
  readonly focusShell: ReturnType<typeof vi.fn>;
  readonly setZoomLevel: ReturnType<typeof vi.fn>;
  readonly press: (input: Electron.Input) => void;
}

function attachHarness(allowChatShortcuts: boolean): ShortcutHarness {
  const source = createFakeWebContents();
  const send = vi.fn();
  const focusShell = vi.fn();
  const setZoomLevel = vi.fn();
  source.define(
    'getZoomLevel',
    vi.fn(() => 0),
  );
  source.define('setZoomLevel', setZoomLevel);
  attachShortcutHandling(source.webContents, { allowChatShortcuts, send, focusShell });
  return {
    send,
    focusShell,
    setZoomLevel,
    press: (input) => {
      source.emit('before-input-event', { preventDefault: preventDefaultSpy }, input);
    },
  };
}

/** The `{ kind: 'action' }` resolution for `action`, sparing the boilerplate. */
function action(name: string): { kind: 'action'; action: string } {
  return { kind: 'action', action: name };
}

describe('resolveShortcut', () => {
  it('maps the browser-navigation keys', () => {
    expect(resolveShortcut(makeInput('F5'))).toEqual(action('browser.refresh'));
    expect(resolveShortcut(makeInput('KeyR', { control: true }))).toEqual(
      action('browser.refresh'),
    );
    expect(resolveShortcut(makeInput('ArrowLeft', { alt: true }))).toEqual(action('browser.back'));
    expect(resolveShortcut(makeInput('ArrowRight', { alt: true }))).toEqual(
      action('browser.forward'),
    );
    expect(resolveShortcut(makeInput('Home', { alt: true }))).toEqual(action('browser.home'));
  });

  it('maps the address-bar and chat-pane keys', () => {
    expect(resolveShortcut(makeInput('KeyL', { control: true }))).toEqual(
      action('browser.focusAddress'),
    );
    expect(resolveShortcut(makeInput('KeyH', { control: true }))).toEqual(action('chat.history'));
    expect(resolveShortcut(makeInput('KeyN', { control: true }))).toEqual(
      action('chat.newSession'),
    );
    expect(resolveShortcut(makeInput('Comma', { control: true }))).toEqual(action('chat.settings'));
  });

  it('maps Ctrl+F to the source-resolved find key', () => {
    // Which find bar it opens depends on the key's source view, so the pure
    // resolver reports the neutral key and the attach wrapper picks the action.
    expect(resolveShortcut(makeInput('KeyF', { control: true }))).toEqual({ kind: 'find' });
  });

  it('maps the zoom keys: the numpad + / -, and Ctrl+0', () => {
    expect(resolveShortcut(makeInput('NumpadAdd', { control: true }))).toEqual({
      kind: 'zoom',
      direction: 'in',
    });
    expect(resolveShortcut(makeInput('NumpadSubtract', { control: true }))).toEqual({
      kind: 'zoom',
      direction: 'out',
    });
    expect(resolveShortcut(makeInput('Digit0', { control: true }))).toEqual({
      kind: 'zoom',
      direction: 'reset',
    });
    expect(resolveShortcut(makeInput('Numpad0', { control: true }))).toEqual({
      kind: 'zoom',
      direction: 'reset',
    });
  });

  it('matches the produced key when the physical code is empty (a real numpad keystroke)', () => {
    // Measured live: a real numpad `+`/`-` arrives with `code: ""` and only
    // `key: "+"`/`"-"` set, so matching on `code` alone missed them entirely.
    expect(resolveShortcut(makeInput('', { control: true, key: '+' }))).toEqual({
      kind: 'zoom',
      direction: 'in',
    });
    expect(resolveShortcut(makeInput('', { control: true, key: '-' }))).toEqual({
      kind: 'zoom',
      direction: 'out',
    });
    expect(resolveShortcut(makeInput('', { control: true, key: '0' }))).toEqual({
      kind: 'zoom',
      direction: 'reset',
    });
    // Other shortcuts need the fallback too when `code` is empty.
    expect(resolveShortcut(makeInput('', { control: true, key: 'h' }))).toEqual(
      action('chat.history'),
    );
    expect(resolveShortcut(makeInput('', { control: true, key: 'f' }))).toEqual({ kind: 'find' });
    expect(resolveShortcut(makeInput('', { alt: true, key: 'ArrowLeft' }))).toEqual(
      action('browser.back'),
    );
    expect(resolveShortcut(makeInput('', { key: 'F5' }))).toEqual(action('browser.refresh'));
  });

  it('matches the physical key, so the layout does not change the binding', () => {
    // A non-Latin layout reports a different `key`; `code` is unchanged.
    expect(resolveShortcut(makeInput('KeyR', { control: true, key: 'я' }))).toEqual(
      action('browser.refresh'),
    );
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
      // Numpad zoom needs Ctrl; the bare key is the page's own.
      makeInput('NumpadAdd'),
      makeInput('NumpadSubtract'),
      makeInput('Digit0'),
      makeInput('Equal', { shift: true }),
      // Shift is accepted only for the `+`; Ctrl+Shift+- is not claimed.
      makeInput('Minus', { control: true, shift: true }),
      // Zoom is bound on the numpad, not the main-row `=` key.
      makeInput('Equal', { control: true, key: '=' }),
      // Claimed letters, but not for these keys.
      makeInput('KeyB', { control: true }),
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
    const hostView = attachHarness(false);

    shell.press(makeInput('KeyH', { control: true }));
    expect(shell.send).toHaveBeenCalledWith('chat.history');

    hostView.press(makeInput('KeyH', { control: true }));
    expect(hostView.send).not.toHaveBeenCalled();
    // Not consumed either, so the page still sees the keystroke.
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it('still binds the shared browser-navigation keys on the AEM view', () => {
    const hostView = attachHarness(false);

    hostView.press(makeInput('ArrowLeft', { alt: true }));

    expect(hostView.send).toHaveBeenCalledWith('browser.back');
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves find to the source pane: browser.find from the AEM view, app.find from the shell', () => {
    const shell = attachHarness(true);
    const hostView = attachHarness(false);

    shell.press(makeInput('KeyF', { control: true }));
    expect(shell.send).toHaveBeenCalledWith('app.find');

    hostView.press(makeInput('KeyF', { control: true }));
    expect(hostView.send).toHaveBeenCalledWith('browser.find');
  });

  it('moves focus to the shell before asking it to focus the address bar', () => {
    const harness = attachHarness(true);

    harness.press(makeInput('KeyL', { control: true }));

    expect(harness.focusShell).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith('browser.focusAddress');
  });

  it('moves focus to the shell for a find key, so its field can take typing', () => {
    const harness = attachHarness(false);

    harness.press(makeInput('KeyF', { control: true }));

    expect(harness.focusShell).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith('browser.find');
  });

  it('does not move focus for any other action', () => {
    const harness = attachHarness(true);

    harness.press(makeInput('KeyR', { control: true }));

    expect(harness.focusShell).not.toHaveBeenCalled();
  });

  it('applies zoom to the source view in main, without sending anything across the boundary', () => {
    const harness = attachHarness(true);

    harness.press(makeInput('NumpadAdd', { control: true }));

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
    expect(harness.setZoomLevel).toHaveBeenCalledWith(1);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.focusShell).not.toHaveBeenCalled();
  });

  it('binds zoom on the AEM view too', () => {
    const hostView = attachHarness(false);

    hostView.press(makeInput('NumpadSubtract', { control: true }));

    expect(hostView.setZoomLevel).toHaveBeenCalledWith(-1);
  });

  it('reports an applied zoom step through onZoomChanged, and not other shortcuts', () => {
    const source = createFakeWebContents();
    source.define(
      'getZoomLevel',
      vi.fn(() => 0),
    );
    source.define('setZoomLevel', vi.fn());
    const onZoomChanged = vi.fn();
    attachShortcutHandling(source.webContents, {
      allowChatShortcuts: true,
      send: vi.fn(),
      focusShell: vi.fn(),
      onZoomChanged,
    });
    const press = (input: Electron.Input): void => {
      source.emit('before-input-event', { preventDefault: preventDefaultSpy }, input);
    };

    press(makeInput('F5'));
    expect(onZoomChanged).not.toHaveBeenCalled();

    press(makeInput('NumpadAdd', { control: true }));
    expect(onZoomChanged).toHaveBeenCalledTimes(1);
  });
});
