import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ADDON_API_VERSION,
  type AddonActivation,
  type AddonModule,
  type Result,
  err,
  ok,
} from '../../shared';
import type { AddonPins } from '../../shared/addons/pins';
import type { AddonManager } from './manager';
import type { AddonHostHandle } from './addonHost';

/**
 * The one way the application loads an add-on: `ensure` its pinned identity,
 * `import()` its entry, check that its `apiVersion` is the one this build
 * speaks, and call `activate(host)` **once**.
 *
 * Loading is single-flight per add-on and only a success is cached: a failed
 * download (or a corrupt add-on) is retried on the next call instead of being
 * remembered forever. Every failure is a typed outcome and never a throw, so a
 * tool call or a skill load reports it in the transcript.
 */

export type AddonLoadFailureKind = 'cancelled' | 'unavailable' | 'apiVersion';

export interface AddonLoadFailure {
  readonly kind: AddonLoadFailureKind;
  /** Already user-facing: it names the add-on and what went wrong, never a path. */
  readonly message: string;
}

/** One successfully activated add-on: what it offers, and where it lives. */
export interface LoadedAddon {
  readonly id: string;
  readonly dir: string;
  readonly activation: AddonActivation;
}

export interface AddonLoadOptions {
  readonly signal?: AbortSignal | undefined;
  /** 0..1 while the archive arrives; the caller renders it on a progress line. */
  readonly onProgress?: ((fraction: number) => void) | undefined;
}

export interface AddonLoader {
  load(id: string, options?: AddonLoadOptions): Promise<Result<LoadedAddon, AddonLoadFailure>>;
  /**
   * The installed folder of an add-on that has loaded successfully, if any.
   * A skill's files are read from here once its add-on has been activated.
   */
  directoryOf(id: string): string | undefined;
  /** The host a loaded add-on was given, for the quit cleanup. */
  hostOf(id: string): AddonHostHandle | undefined;
}

export interface AddonLoaderOptions {
  readonly manager: AddonManager;
  readonly pins: AddonPins;
  /** Creates an add-on's host on first use; called at most once per id. */
  readonly createHost: (id: string) => AddonHostHandle;
  /** A real dynamic import, so a CommonJS main bundle still loads the ESM add-on. */
  readonly importModule?: (specifier: string) => Promise<unknown>;
}

/**
 * `import()` from a bundle that Electron/Vite emits as CommonJS: a plain
 * dynamic import is rewritten into `require()` by the bundler, which cannot load
 * an ES module from outside the archive (the add-on is a downloaded folder with
 * its own `package.json`). The `Function` constructor keeps the import a real
 * run-time `import()`, and this is the one deliberate use in the application.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- a real ESM import(), not eval
const runtimeImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string,
) => Promise<unknown>;

function isAddonModule(value: unknown): value is AddonModule<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['apiVersion'] === 'number' && typeof candidate['activate'] === 'function';
}

export function createAddonLoader(options: AddonLoaderOptions): AddonLoader {
  const loaded = new Map<string, LoadedAddon>();
  const loading = new Map<string, Promise<Result<LoadedAddon, AddonLoadFailure>>>();
  const hosts = new Map<string, AddonHostHandle>();
  const importModule = options.importModule ?? runtimeImport;

  function hostFor(id: string): AddonHostHandle {
    const existing = hosts.get(id);
    if (existing !== undefined) return existing;
    const created = options.createHost(id);
    hosts.set(id, created);
    return created;
  }

  async function activate(
    id: string,
    settings: AddonLoadOptions,
  ): Promise<Result<LoadedAddon, AddonLoadFailure>> {
    const pin = options.pins[id];
    if (pin === undefined) {
      return err({ kind: 'unavailable', message: `The "${id}" add-on is not part of this build` });
    }
    const ensured = await options.manager.ensure(id, {
      ...(settings.onProgress === undefined ? {} : { onProgress: settings.onProgress }),
      ...(settings.signal === undefined ? {} : { signal: settings.signal }),
    });
    if (!ensured.ok) {
      const kind: AddonLoadFailureKind =
        ensured.error.reason === 'cancelled' ? 'cancelled' : 'unavailable';
      return err({
        kind,
        message: `The "${id}" add-on is not available (${ensured.error.reason}). ${ensured.error.message}`,
      });
    }
    const { dir, descriptor } = ensured.value;
    if (descriptor.apiVersion !== pin.apiVersion || pin.apiVersion !== ADDON_API_VERSION) {
      return err({
        kind: 'apiVersion',
        message: `The "${id}" add-on does not work with this version of the application`,
      });
    }

    let module: unknown;
    try {
      module = await importModule(
        pathToFileURL(path.join(dir, ...descriptor.entry.split('/'))).href,
      );
    } catch {
      return err({
        kind: 'unavailable',
        message: `The "${id}" add-on could not be loaded`,
      });
    }
    const addon = (module as { addon?: unknown } | null)?.addon;
    if (!isAddonModule(addon)) {
      return err({
        kind: 'unavailable',
        message: `The "${id}" add-on is not usable`,
      });
    }
    if (addon.apiVersion !== pin.apiVersion || addon.apiVersion !== ADDON_API_VERSION) {
      return err({
        kind: 'apiVersion',
        message: `The "${id}" add-on does not work with this version of the application`,
      });
    }

    let activation: AddonActivation;
    try {
      activation = addon.activate(hostFor(id).host);
    } catch (caught) {
      return err({
        kind: 'unavailable',
        message: `The "${id}" add-on could not be started: ${
          caught instanceof Error ? caught.message.slice(0, 200) : 'unknown error'
        }`,
      });
    }

    // Everything the pins promise must actually be there, or the tool the model
    // was shown would answer with a stack trace instead of a result.
    const offered = (activation as { tools?: unknown } | null)?.tools;
    if (typeof offered !== 'object' || offered === null) {
      return err({ kind: 'unavailable', message: `The "${id}" add-on is not usable` });
    }
    for (const tool of pin.contributions.tools) {
      if (typeof (offered as Record<string, unknown>)[tool.name] !== 'function') {
        return err({
          kind: 'unavailable',
          message: `The "${id}" add-on does not provide its "${tool.name}" tool`,
        });
      }
    }
    return ok({ id, dir, activation: { tools: offered as AddonActivation['tools'] } });
  }

  return {
    load(id, settings = {}) {
      const cached = loaded.get(id);
      if (cached !== undefined) return Promise.resolve(ok(cached));
      const running = loading.get(id);
      if (running !== undefined) return running;
      const run = activate(id, settings).then((result) => {
        if (result.ok) loaded.set(id, result.value);
        return result;
      });
      loading.set(id, run);
      return run.finally(() => {
        loading.delete(id);
      });
    },
    directoryOf: (id) => loaded.get(id)?.dir,
    hostOf: (id) => hosts.get(id),
  };
}
