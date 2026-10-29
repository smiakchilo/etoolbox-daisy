import { BrowserWindow, type Session, session as electronSession } from 'electron';
import type { AddonHost, AddonLogEvent, NetworkTargetVerdict } from '../../shared';
import { defaultResolve, inspectTarget } from '../externalFetch';
import type { Logger } from '../logger';

/**
 * The application's side of {@link AddonHost}: the generic capabilities one
 * add-on receives, and nothing else.
 *
 * The host forces the safety-critical window options - hidden, sandboxed,
 * context-isolated, no Node integration, web security on - and accepts only a
 * session it handed out. Everything else about the window (frame rate,
 * background throttling, window-open denial, permissions, the request filter,
 * navigation guards, the add-on's own deadline) is the add-on's business: this
 * host does not claim to sandbox it.
 */

const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 800;

/** One add-on's host, plus the cleanup the application needs at quit. */
export interface AddonHostHandle {
  readonly host: AddonHost<BrowserWindow, Session>;
  /** Destroys every window this host created that is still open. */
  destroyWindows(): void;
}

export interface AddonHostDeps {
  /** The browser pane's session (a configured host's page loads signed in). */
  readonly paneSession: Session;
  readonly currentUrl: () => string | undefined;
  readonly isConfiguredOrigin: (origin: string) => boolean;
  readonly logger: Pick<Logger, 'warn'>;
}

/** `addon-<id>-<name>`: one add-on's isolated session can never meet another's. */
export function addonPartitionName(id: string, name: string): string {
  return `addon-${id}-${name}`;
}

export function createAddonHost(id: string, deps: AddonHostDeps): AddonHostHandle {
  const handedOut = new Set<Session>();
  const windows = new Set<BrowserWindow>();

  function paneSession(): Session {
    handedOut.add(deps.paneSession);
    return deps.paneSession;
  }

  function isolatedSession(name: string): Session {
    const parted = electronSession.fromPartition(addonPartitionName(id, name));
    handedOut.add(parted);
    return parted;
  }

  const host: AddonHost<BrowserWindow, Session> = {
    id,
    browser: {
      createHiddenWindow(options) {
        if (!handedOut.has(options.session)) {
          throw new Error(`The "${id}" add-on asked for a session this host did not hand out.`);
        }
        const win = new BrowserWindow({
          show: false,
          width: options.width ?? DEFAULT_WINDOW_WIDTH,
          height: options.height ?? DEFAULT_WINDOW_HEIGHT,
          webPreferences: {
            session: options.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            ...(options.offscreen === undefined ? {} : { offscreen: options.offscreen }),
            ...(options.backgroundThrottling === undefined
              ? {}
              : { backgroundThrottling: options.backgroundThrottling }),
          },
        });
        windows.add(win);
        win.once('closed', () => {
          windows.delete(win);
        });
        return win;
      },
    },
    sessions: { pane: paneSession, isolated: isolatedSession },
    network: {
      async inspectTarget(url): Promise<NetworkTargetVerdict> {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return { allowed: false };
        }
        const verdict = await inspectTarget(parsed, defaultResolve);
        return { allowed: verdict.allowed };
      },
    },
    hosts: {
      isConfiguredOrigin: (origin) => deps.isConfiguredOrigin(origin),
    },
    pane: { currentUrl: () => deps.currentUrl() },
    log(event: AddonLogEvent) {
      switch (event.code) {
        case 'runtime-failed':
          deps.logger.warn('ADDON_RUNTIME_FAILED', { outcome: 'failure', addonId: id });
      }
    },
  };

  return {
    host,
    destroyWindows() {
      for (const win of windows) {
        if (!win.isDestroyed()) win.destroy();
      }
      windows.clear();
    },
  };
}
