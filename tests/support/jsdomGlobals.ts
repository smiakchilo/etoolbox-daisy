import { JSDOM } from 'jsdom';

/**
 * Temporarily replaces properties of `globalThis` and returns a function that
 * puts every one of them back - a property that did not exist beforehand is
 * deleted again rather than left behind as `undefined`.
 */
export function stubGlobals(values: Readonly<Record<string, unknown>>): () => void {
  const previous = Object.keys(values).map((key) => ({
    key,
    existed: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: Reflect.get(globalThis, key) as unknown,
  }));
  for (const [key, value] of Object.entries(values)) {
    Reflect.set(globalThis, key, value);
  }
  return () => {
    for (const { key, existed, value } of previous) {
      if (existed) {
        Reflect.set(globalThis, key, value);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

/** A `ResizeObserver` that never reports: jsdom implements none, and layout is stubbed per test. */
export class InertResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

export interface InstalledJsdom {
  readonly dom: JSDOM;
  /** Closes the window and restores every global the install replaced. */
  readonly restore: () => void;
}

export interface InstallJsdomOptions {
  readonly url?: string;
  /** Expose `window` as well as `document` (default `true`). */
  readonly exposeWindow?: boolean;
  /** Names of jsdom window properties to expose as globals, e.g. `MutationObserver`. */
  readonly windowGlobals?: readonly string[];
  /** Further globals to set for the test, e.g. `ResizeObserver`. */
  readonly extraGlobals?: Readonly<Record<string, unknown>>;
}

/** Creates a JSDOM and exposes its `document` (and `window`) as globals. */
export function installJsdomGlobals(options: InstallJsdomOptions = {}): InstalledJsdom {
  const dom = options.url === undefined ? new JSDOM() : new JSDOM('', { url: options.url });
  const windowGlobals = Object.fromEntries(
    (options.windowGlobals ?? []).map((name) => [name, Reflect.get(dom.window, name) as unknown]),
  );
  const restoreGlobals = stubGlobals({
    document: dom.window.document,
    ...(options.exposeWindow === false ? {} : { window: dom.window }),
    ...windowGlobals,
    ...options.extraGlobals,
  });
  return {
    dom,
    restore: () => {
      dom.window.close();
      restoreGlobals();
    },
  };
}
