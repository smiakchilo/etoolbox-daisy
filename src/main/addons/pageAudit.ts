import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PageAuditOutcome, PageAuditRunner } from '../../shared';
import type { AddonManager } from './manager';

/**
 * Loads the page-audit add-on on first use and exposes it as the
 * `ToolHost.pageAudit` runner the tool already expects.
 *
 * The runner is the typed lazy form of the capability: the tool's executor is
 * built with a function, and nothing Lighthouse-related is touched until an audit
 * is actually requested. On that first call the add-on is ensured (downloaded if
 * the pinned version is not installed), imported with a real ESM `import()`, and
 * asked for its runner. Progress during the download is written to the tool
 * call's own progress line.
 */

/** What the application hands the add-on once it is loaded (its `PageAuditAddonDeps`). */
export interface PageAuditAddonRuntimeDeps {
  readonly paneSession: Session;
  readonly anonymousSession: () => Session;
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly currentUrl: () => string | undefined;
  readonly isConfiguredOrigin: (origin: string) => boolean;
  readonly inspectTarget: (url: URL) => Promise<{ readonly allowed: boolean }>;
  readonly logger: { warn(code: 'PAGE_AUDIT_FAILED'): void };
}

/** The add-on's own module shape; typed here because the application may not import it. */
interface PageAuditAddonModule {
  readonly apiVersion?: unknown;
  readonly createPageAuditRunner?: unknown;
}

export interface PageAuditCapabilityOptions {
  readonly manager: AddonManager;
  readonly createDeps: () => PageAuditAddonRuntimeDeps;
  /** A real dynamic import, so a CommonJS main bundle still loads the ESM add-on. */
  readonly importModule?: (specifier: string) => Promise<unknown>;
}

class AddonUnavailableError extends Error {
  constructor(
    readonly kind: 'cancelled' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'AddonUnavailableError';
  }
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

export function createPageAuditCapability(options: PageAuditCapabilityOptions): PageAuditRunner {
  let loaded: PageAuditRunner | undefined;
  let loading: Promise<PageAuditRunner> | undefined;
  let reportProgress: ((fraction: number) => void) | undefined;
  const importModule = options.importModule ?? runtimeImport;

  async function load(signal: AbortSignal | undefined): Promise<PageAuditRunner> {
    const ensured = await options.manager.ensure('page-audit', {
      ...(signal === undefined ? {} : { signal }),
      onProgress: (fraction) => {
        reportProgress?.(fraction);
      },
    });
    if (!ensured.ok) {
      throw new AddonUnavailableError(
        ensured.error.reason === 'cancelled' ? 'cancelled' : 'unavailable',
        ensured.error.message,
      );
    }
    const { dir, descriptor } = ensured.value;
    if (descriptor.kind !== 'js' || descriptor.entry === undefined) {
      throw new AddonUnavailableError('unavailable', 'The page audit add-on is not usable');
    }
    const module = (await importModule(
      pathToFileURL(path.join(dir, ...descriptor.entry.split('/'))).href,
    )) as PageAuditAddonModule;
    if (typeof module.createPageAuditRunner !== 'function') {
      throw new AddonUnavailableError('unavailable', 'The page audit add-on is not usable');
    }
    return (module.createPageAuditRunner as (deps: PageAuditAddonRuntimeDeps) => PageAuditRunner)(
      options.createDeps(),
    );
  }

  async function runner(signal: AbortSignal | undefined): Promise<PageAuditRunner> {
    if (loaded !== undefined) return loaded;
    loading ??= load(signal);
    try {
      loaded = await loading;
      return loaded;
    } finally {
      loading = undefined;
    }
  }

  return async (request, signal, progress) => {
    if (progress !== undefined) {
      reportProgress = (fraction) =>
        progress(`Downloading page audit add-on ${String(Math.round(fraction * 100))}%`);
    }
    try {
      const run = await runner(signal);
      return await run(request, signal, progress);
    } catch (error) {
      // Only a successful load is cached, so a failed download (or a corrupt
      // add-on) is retried on the next call rather than remembered forever.
      const outcome: PageAuditOutcome =
        error instanceof AddonUnavailableError && error.kind === 'cancelled'
          ? { kind: 'cancelled' }
          : {
              kind: 'unavailable',
              message:
                error instanceof Error ? error.message : 'The page audit add-on is not available',
            };
      return outcome;
    } finally {
      reportProgress = undefined;
    }
  };
}
