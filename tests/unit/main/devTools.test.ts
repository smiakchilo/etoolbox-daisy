import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { makeInput } from '../../support/electronInput';

/**
 * `devTools.ts` is the app's only menu-less key binding. It imports nothing
 * from `electron` at runtime (types only), so these tests drive it with plain
 * fakes: a fake `WebContents` whose `before-input-event` listener can be
 * invoked with a chosen `Input`, and a fake event whose `preventDefault` is
 * observable. That is the whole contract - "does Ctrl+Shift+I toggle exactly
 * the target's DevTools, and nothing else?" - and it is the only part a unit
 * test can reach without a live Chromium input pipeline.
 */
const { attachDevToolsShortcut, isToggleDevToolsShortcut, openDetachedDevTools } =
  await import('../../../src/main/devTools');

const preventDefaultSpy = vi.fn();

/** The DevTools combination, as an `Input` - `makeInput`'s neutral defaults plus Ctrl+Shift. */
function makeDevToolsInput(overrides: Partial<Electron.Input> = {}): Electron.Input {
  return makeInput('KeyI', { key: 'I', control: true, shift: true, ...overrides });
}

interface FakeWebContents {
  readonly webContents: WebContents;
  readonly emitInput: (input: Electron.Input) => void;
  readonly toggleDevTools: ReturnType<typeof vi.fn>;
  readonly openDevTools: ReturnType<typeof vi.fn>;
  readonly isDevToolsOpened: ReturnType<typeof vi.fn>;
}

function makeFakeWebContents(devToolsOpened = false): FakeWebContents {
  let listener: ((event: { preventDefault(): void }, input: Electron.Input) => void) | undefined;
  const toggleDevTools = vi.fn();
  const openDevTools = vi.fn();
  const isDevToolsOpened = vi.fn(() => devToolsOpened);
  const webContents = {
    on: (event: string, candidate: typeof listener) => {
      if (event === 'before-input-event') {
        listener = candidate;
      }
      return webContents;
    },
    toggleDevTools,
    openDevTools,
    isDevToolsOpened,
  } as unknown as WebContents;
  return {
    webContents,
    emitInput: (input) => {
      listener?.({ preventDefault: preventDefaultSpy }, input);
    },
    toggleDevTools,
    openDevTools,
    isDevToolsOpened,
  };
}

beforeEach(() => {
  preventDefaultSpy.mockClear();
});

describe('isToggleDevToolsShortcut', () => {
  it('accepts a fresh Ctrl+Shift+I key-down regardless of keyboard layout', () => {
    expect(isToggleDevToolsShortcut(makeDevToolsInput())).toBe(true);
    expect(isToggleDevToolsShortcut(makeDevToolsInput({ key: 'i' }))).toBe(true);
  });

  it('rejects key-up, auto-repeat, a missing/extra modifier, and other keys', () => {
    const rejected: Electron.Input[] = [
      makeDevToolsInput({ type: 'keyUp' }),
      makeDevToolsInput({ isAutoRepeat: true }),
      makeDevToolsInput({ control: false, shift: false }),
      makeDevToolsInput({ shift: false }),
      makeDevToolsInput({ control: false }),
      makeDevToolsInput({ alt: true }),
      makeDevToolsInput({ control: false, meta: true }),
      makeDevToolsInput({ code: 'KeyJ' }),
    ];
    for (const input of rejected) {
      expect(isToggleDevToolsShortcut(input)).toBe(false);
    }
  });
});

describe('attachDevToolsShortcut', () => {
  it('toggles the target DevTools and consumes the key', () => {
    const source = makeFakeWebContents();
    const target = makeFakeWebContents();
    attachDevToolsShortcut(source.webContents, target.webContents);

    source.emitInput(makeDevToolsInput());

    expect(target.toggleDevTools).toHaveBeenCalledTimes(1);
    expect(source.toggleDevTools).not.toHaveBeenCalled();
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves every other keystroke alone', () => {
    const source = makeFakeWebContents();
    const target = makeFakeWebContents();
    attachDevToolsShortcut(source.webContents, target.webContents);

    source.emitInput(makeDevToolsInput({ code: 'KeyJ' }));
    source.emitInput(makeDevToolsInput({ type: 'keyUp' }));
    source.emitInput(makeDevToolsInput({ isAutoRepeat: true }));

    expect(target.toggleDevTools).not.toHaveBeenCalled();
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  it('lets the shell bind the shortcut to its own webContents', () => {
    const shell = makeFakeWebContents();
    attachDevToolsShortcut(shell.webContents, shell.webContents);

    shell.emitInput(makeDevToolsInput());

    expect(shell.toggleDevTools).toHaveBeenCalledTimes(1);
  });
});

describe('openDetachedDevTools', () => {
  it('opens DevTools detached when they are closed', () => {
    const { webContents, openDevTools } = makeFakeWebContents(false);

    openDetachedDevTools(webContents);

    expect(openDevTools).toHaveBeenCalledTimes(1);
    expect(openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
  });

  it('leaves already-open DevTools as they are', () => {
    const { webContents, openDevTools } = makeFakeWebContents(true);

    openDetachedDevTools(webContents);

    expect(openDevTools).not.toHaveBeenCalled();
  });
});
