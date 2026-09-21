import type { ProxyConfig, ServerConfig } from '../../shared';
import { originsMatch, parseNavigationTarget } from '../../shared';
import type { ProxyPlainCredentials } from '../aem';

/**
 * The sequential server-switch state machine (implementation-plan.md step
 * 05; requirements-decisions.md section 4: "AEM server switching is
 * sequential: enter a switching state, stop in-flight operations, close
 * auxiliary windows, apply the new proxy configuration, close previous
 * connections, and then load the new address. Tools remain disabled until
 * the transition completes.").
 *
 * `switching` is a real, checkable field on this object - not an implicit
 * race between "did the proxy finish applying" and "did the load start" -
 * so a caller (an IPC handler gating `browser:switch-server` itself, or a
 * later step's tool-call gate) can ask "are we mid-switch?" as a plain read
 * instead of reconstructing it from timing.
 *
 * This module knows nothing about Electron: `AemSwitchSession`/
 * `SwitchableAemView` are narrowed to exactly the capabilities this state
 * machine calls, so a unit test can pass a plain recorder object instead of
 * a real `WebContentsView`/`AemSession`.
 */

/** The one `AemSession` capability this module needs - already sequential internally (`proxyPolicy.ts`'s `applyProxySwitch`: awaits `setProxy` then `closeAllConnections`). */
export interface AemSwitchSession {
  switchProxy(
    proxy: ProxyConfig | undefined,
    resolveCredentials: () => ProxyPlainCredentials | undefined,
  ): Promise<void>;
}

/** The AEM `WebContentsView`'s `webContents`, narrowed to what a switch needs. */
export interface SwitchableAemView {
  /** Stops any in-flight navigation/load on the *previous* server before anything else happens. */
  stop(): void;
  /** Loads the new server's origin. Called last, only after the proxy switch has fully resolved. */
  loadURL(url: string): Promise<void>;
}

export type ServerSwitchState = 'idle' | 'switching';

/**
 * Every Chromium network error Electron surfaces to JavaScript - a rejected
 * `loadURL`/`setProxy` promise, and the `errorCode` argument of
 * `did-fail-load` - is spelled out of Chromium's own closed `net::Error`
 * vocabulary and always starts with `ERR_` (see
 * `net/base/net_error_list.h`; the real message this project observed is
 * `ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://localhost:53158/nav'`).
 * That fixed vocabulary is what lets `ServerSwitchController.switchTo`'s
 * `catch` block below tell "the network/proxy/certificate failed, in a way
 * Chromium itself names" apart from "something in this process threw for an
 * unrelated
 * reason" - a `TypeError` from a real bug, a plain `Error("boom")` thrown by
 * a broken test double, etc. - without a caller-supplied classifier or an
 * error-code allowlist that would need to be kept in sync with Chromium's
 * own list.
 */
const CHROMIUM_ERROR_CODE_PATTERN = /\bERR_[A-Z0-9_]+\b/;

/**
 * Extracts the Chromium `ERR_*` code embedded in an arbitrary text, if any.
 * Shared by `extractChromiumErrorCode` below (a rejected promise's message)
 * and `aemBrowserView.ts`'s `did-fail-load` handling (Chromium's own
 * `errorDescription` string, e.g. `"ERR_CONNECTION_REFUSED (-102)"`) - both
 * are the same closed `net::Error` vocabulary, just observed at two
 * different call sites.
 */
export function extractChromiumErrorCodeFromText(text: string): string | undefined {
  return CHROMIUM_ERROR_CODE_PATTERN.exec(text)?.[0];
}

/**
 * Extracts the Chromium `ERR_*` code embedded in a rejected `loadURL`/
 * `setProxy` promise's message, if any. Returns `undefined` for anything
 * that is not recognisably a Chromium network error - including a non-Error
 * throw, or an `Error` whose message never mentions an `ERR_*` code - so a
 * caller can use "was a code found?" as the same programmer-error-vs-
 * network-error boundary `switchTo` relies on below.
 */
export function extractChromiumErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return extractChromiumErrorCodeFromText(error.message);
}

export interface ServerSwitchDeps {
  /** Returns the current AEM view, or `undefined` if none exists yet (e.g. window not created). */
  readonly getView: () => SwitchableAemView | undefined;
  /** Closes every open auxiliary window (login popups, SSO windows) - see `auxiliaryWindows.ts`. Must not itself touch the AEM view or session. */
  readonly closeAuxiliaryWindows: () => void;
  readonly aemSession: AemSwitchSession;
  /**
   * Resolves the proxy-library entry (or `undefined` for a direct connection)
   * that applies to `server`, by combining the host's `proxyId` selection with
   * the `browser.proxy` default - see `resolveEffectiveProxy` in
   * `proxyResolution.ts`. Read through a closure (not a snapshot) for the same
   * reason `resolveProxyCredentials` is: the controller holds the value in a
   * cell that the switch itself is what updates.
   */
  readonly resolveProxy: (server: ServerConfig) => ProxyConfig | undefined;
  /** Resolves the plaintext proxy credentials for `server`, if any are configured. Never called eagerly - see `AemSession.switchProxy`'s own doc comment on why the resolver, not a snapshot, is what gets stored. */
  readonly resolveProxyCredentials: (
    server: ServerConfig,
  ) => () => ProxyPlainCredentials | undefined;
  /** Notified on every switching/idle transition, e.g. to push `browser:switch-state-changed`. */
  readonly onStateChange?: (state: ServerSwitchState) => void;
}

export type ServerSwitchOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'already_switching' | 'no_active_view' }
  | {
      readonly ok: false;
      readonly reason: 'network_error';
      /** The Chromium `ERR_*` code extracted from the rejection, e.g. `ERR_CERT_AUTHORITY_INVALID`. */
      readonly errorCode: string;
      /** The underlying rejection's full message, for a caller that wants more than the bare code. */
      readonly message: string;
    };

/**
 * Owns the one piece of state this whole module exists to make explicit:
 * whether a switch is currently in progress. Exposed as a plain getter
 * (`getState`), not inferred by callers from whether a promise is pending.
 */
export class ServerSwitchController {
  private state: ServerSwitchState = 'idle';

  constructor(private readonly deps: ServerSwitchDeps) {}

  getState(): ServerSwitchState {
    return this.state;
  }

  private setState(next: ServerSwitchState): void {
    this.state = next;
    this.deps.onStateChange?.(next);
  }

  /**
   * Performs the switch to `server`, in the exact order
   * requirements-decisions.md section 4 mandates. Rejects immediately
   * (`already_switching`) rather than queuing or interleaving a second
   * switch on top of one already in progress - "tools remain disabled until
   * the transition completes" is meaningless if a second switch could start
   * before the first one finished stopping/closing/re-proxying.
   *
   * `targetUrl` lets the caller land on a specific page of `server` (an
   * address-bar deep link) instead of its root. It is re-checked against
   * `server.origin` here rather than trusted: this class is what actually
   * performs the load, so a future caller that resolved the server from one
   * string and the URL from another cannot make it navigate off-origin.
   */
  async switchTo(server: ServerConfig, targetUrl?: string): Promise<ServerSwitchOutcome> {
    if (this.state === 'switching') {
      return { ok: false, reason: 'already_switching' };
    }

    if (targetUrl !== undefined) {
      const target = parseNavigationTarget(targetUrl);
      if (!target.ok || !originsMatch(server.origin, target.origin)) {
        throw new Error(`refusing to load ${targetUrl} as ${server.origin}`);
      }
    }

    const view = this.deps.getView();
    if (!view) {
      return { ok: false, reason: 'no_active_view' };
    }

    this.setState('switching');
    try {
      // 1. Stop whatever the previous server's view was doing in-flight -
      //    before touching the proxy or any window, so nothing from the old
      //    server keeps running underneath the switch.
      view.stop();

      // 2. Close every auxiliary window (login popups, SSO windows) tied to
      //    the previous server. These share the AEM session/proxy, so they
      //    must not survive into the new server's context.
      this.deps.closeAuxiliaryWindows();

      // 3. Apply the new proxy configuration and close previous connections
      //    - `AemSession.switchProxy` itself awaits `setProxy` then
      //    `closeAllConnections`, in that order (proxyPolicy.ts), and this
      //    step does not return until both have resolved.
      await this.deps.aemSession.switchProxy(
        this.deps.resolveProxy(server),
        this.deps.resolveProxyCredentials(server),
      );

      // 4. Only now load the new address - never before the proxy switch
      //    above has fully resolved, so no request for the new server can
      //    race ahead of its own proxy configuration.
      await view.loadURL(targetUrl ?? server.origin);
    } catch (error) {
      // `switchProxy`/`loadURL` reject constantly in real use - a down AEM
      // server, a mistyped address, a bad proxy, an untrusted certificate
      // are all Electron rejecting with a Chromium `ERR_*` message, not an
      // edge case (implementation-plan.md step 05's "network errors are
      // explicit"). Turning *that* into a structured `network_error`
      // outcome, instead of letting it escape as a raw rejection, is what
      // this catch exists for.
      //
      // It deliberately does NOT catch everything indiscriminately:
      // `extractChromiumErrorCode` only recognises Chromium's own `ERR_*`
      // vocabulary, so a genuine programmer error (a `TypeError`, a thrown
      // plain string, a bug in a future step's code running in the same
      // `try`) has no such code and is rethrown unchanged below. That keeps
      // a real bug loud - propagating out of `switchTo` as a rejection,
      // exactly as it did before this change - rather than silently
      // relabelling it as "the network failed".
      const errorCode = extractChromiumErrorCode(error);
      if (errorCode === undefined) {
        throw error;
      }
      return {
        ok: false,
        reason: 'network_error',
        errorCode,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.setState('idle');
    }
    return { ok: true };
  }
}
