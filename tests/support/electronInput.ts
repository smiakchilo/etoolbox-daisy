import type { Input } from 'electron';

/**
 * Builds an `Electron.Input` for a `before-input-event` unit test.
 *
 * Neutral by default - a plain key-down with no modifiers and no auto-repeat -
 * so a test states exactly the keystroke it means and nothing more. `code` is
 * required because the key map matches on the physical key
 * (`src/main/shortcuts.ts`, `devTools.ts`), not on `key`.
 */
export function makeInput(code: string, overrides: Partial<Input> = {}): Input {
  return {
    type: 'keyDown',
    key: '',
    code,
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...overrides,
  };
}
