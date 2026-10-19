import type { ProxyConfig, ServerConfig } from '../../shared';
import { originsMatch, parseNavigationTarget } from '../../shared';
import type { ProxyPlainCredentials } from '../webview';

/**
 * The server-switch state machine (implementation-plan.md step
 * 05; requirements-decisions.md section 4: "host switching is
 * sequential: enter a switching state, stop in-flight operations, close
 * auxiliary windows, apply the new proxy configuration, close previous
 * connections, and then load the new address."). "Auxiliary windows" here
 * are the popups this app still opens for SSO/login dialogs - `closePopups`
 * below.
 *
 * The *proxy* sequence stays strictly sequential - two `setProxy`/
 * `closeAllConnections` pairs must never interleave on the one session-wide
 * proxy - but a switch requested while another is in flight is no longer
 * rejected. It supersedes the older one: the pane is stopped immediately so
 * the older load settles, the older procedure unwinds without loading its
 * target or resetting state, and only then does the newer switch apply its
 * proxy and load. This is what lets a user retype an address or pick another
 * host while a flaky page is still loading - the newer navigation wins.
 *
 * `switching` is a real, checkable field on this object - not an implicit
 * race between "did the proxy finish applying" and "did the load start" -
 * so a caller (an IPC handler gating `browser:switch-server` itself, or a
 * later step's tool-call gate) can ask "are we mid-switch?" as a plain read
 * instead of reconstructing it from timing.
 *
 * This module knows nothing about Electron: `SwitchableSession`/
 * `SwitchableView` are narrowed to exactly the capabilities this state
 * machine calls, so a unit test can pass a plain recorder object instead of
 * a real `WebContentsView`/`ViewSession`.
 */

/** The one `ViewSession` capability this module needs - already sequential internally (`proxyPolicy.ts`'s `applyProxySwitch`: awaits `setProxy` then `closeAllConnections`). */
export interface SwitchableSession {
  switchProxy(
    proxy: ProxyConfig | undefined,
    resolveCredentials: () => ProxyPlainCredentials | undefined,
  ): Promise<void>;
}

/** The browser `WebContentsView`'s `webContents`, narrowed to what a switch needs. */
export interface SwitchableView {
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
 * and `hostView.ts`'s `did-fail-load` handling (Chromium's own
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
  /** Returns the current browser view, or `undefined` if none exists yet (e.g. window not created). */
  readonly getView: () => SwitchableView | undefined;
  /** Closes every open popup window (login/SSO dialogs) - see `windowOpenRouter.ts`. Must not itself touch the pane view or session. */
  readonly closePopups: () => void;
  readonly viewSession: SwitchableSession;
  /**
   * Resolves the proxy-library entry (or `undefined` for a direct connection)
   * that applies to `server`, by combining the host's `proxyId` selection with
   * the `browser.proxy` default - see `resolveEffectiveProxy` in
   * `proxyResolution.ts`. Read through a closure (not a snapshot) for the same
   * reason `resolveProxyCredentials` is: the controller holds the value in a
   * cell that the switch itself is what updates.
   */
  readonly resolveProxy: (server: ServerConfig) => ProxyConfig | undefined;
  /** Resolves the plaintext proxy credentials for `server`, if any are configured. Never called eagerly - see `ViewSession.switchProxy`'s own doc comment on why the resolver, not a snapshot, is what gets stored. */
  readonly resolveProxyCredentials: (
    server: ServerConfig,
  ) => () => ProxyPlainCredentials | undefined;
  /** Notified on every switching/idle transition, e.g. to push `browser:switch-state-changed`. */
  readonly onStateChange?: (state: ServerSwitchState) => void;
}

export type ServerSwitchOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no_active_view' | 'superseded' }
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
  /**
   * Monotonic switch generation. Every `switchTo` bumps it; a running
   * procedure compares its own captured value before each side effect that
   * must not happen for a superseded switch (notably `loadURL`), and before
   * resetting `switching` to `idle`. This is what makes "latest wins" exact
   * without an `AbortController` - `view.stop()` aborts the pane's load, and
   * the generation check stops an older procedure from doing anything after
   * it has been overtaken.
   */
  private generation = 0;
  /**
   * Resolves once the currently-scheduled procedure has fully unwound. A
   * superseding `switchTo` awaits it before touching the session-wide proxy,
   * so two `setProxy`/`closeAllConnections` pairs can never interleave.
   */
  private inFlight: Promise<void> = Promise.resolve();

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
   * requirements-decisions.md section 4 mandates. A switch requested while
   * another is still running supersedes it: the pane is stopped at once (so
   * the older `loadURL`, if any, settles), the older procedure unwinds
   * without loading or resetting state, and this one then runs the full
   * sequence. The superseded call resolves with `{ ok: false, reason:
   * "superseded" }` - a benign outcome, because the navigation it stood for
   * was replaced by the newer one, which owns the final result.
   *
   * `targetUrl` lets the caller land on a specific page of `server` (an
   * address-bar deep link) instead of its root. It is re-checked against
   * `server.origin` here rather than trusted: this class is what actually
   * performs the load, so a future caller that resolved the server from one
   * string and the URL from another cannot make it navigate off-origin.
   */
  async switchTo(server: ServerConfig, targetUrl?: string): Promise<ServerSwitchOutcome> {
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

    const myGeneration = ++this.generation;

    // Supersede whatever is running: stop the pane immediately so the older
    // procedure's in-flight `loadURL` (if it reached one) rejects promptly
    // and its generation check bails instead of loading on top of us.
    if (this.state === 'switching') {
      view.stop();
    }

    const previous = this.inFlight;
    const outcome = this.run(server, targetUrl, view, myGeneration, previous);
    // Swallow rejections in the chain so a programmer error propagating out
    // of one switch never wedges a later switch's `await previous`.
    this.inFlight = outcome.then(
      () => undefined,
      () => undefined,
    );
    return outcome;
  }

  private async run(
    server: ServerConfig,
    targetUrl: string | undefined,
    view: SwitchableView,
    myGeneration: number,
    previous: Promise<void>,
  ): Promise<ServerSwitchOutcome> {
    // Serialize the proxy sequence: never begin until the prior procedure has
    // fully unwound (its `setProxy`/`closeAllConnections` can still be
    // running when a very rapid second request arrives).
    await previous;

    // Overtaken while we waited: the newer switch owns the outcome.
    if (myGeneration !== this.generation) {
      return { ok: false, reason: 'superseded' };
    }

    this.setState('switching');
    try {
      // 1. Stop whatever the previous server's view was doing in-flight -
      //    before touching the proxy or any window, so nothing from the old
      //    server keeps running underneath the switch.
      view.stop();

      // 2. Close every open popup window (login/SSO dialogs) tied to the
      //    previous server. These share the pane's session/proxy, so they must
      //    not survive into the new server's context. In-place "tab" requests
      //    never had a separate window to close - they load in the view.
      this.deps.closePopups();

      // 3. Apply the new proxy configuration and close previous connections
      //    - `ViewSession.switchProxy` itself awaits `setProxy` then
      //    `closeAllConnections`, in that order (proxyPolicy.ts), and this
      //    step does not return until both have resolved.
      await this.deps.viewSession.switchProxy(
        this.deps.resolveProxy(server),
        this.deps.resolveProxyCredentials(server),
      );

      // A newer switch may have superseded us during the proxy switch. Loading
      // the old target now would race the new switch's load in either
      // direction, so bail before the load.
      if (myGeneration !== this.generation) {
        return { ok: false, reason: 'superseded' };
      }

      // 4. Only now load the new address - never before the proxy switch
      //    above has fully resolved, so no request for the new server can
      //    race ahead of its own proxy configuration.
      await view.loadURL(targetUrl ?? server.origin);

      // A newer switch may have superseded us while this load was settling
      // (its own `view.stop()` normally aborts it, but a load that completed
      // in the same window must still not claim success for a superseded
      // navigation).
      if (myGeneration !== this.generation) {
        return { ok: false, reason: 'superseded' };
      }
    } catch (error) {
      // A superseded switch's `view.stop()` aborts its own load; that
      // rejection must not be reported as a network failure by the older call.
      if (myGeneration !== this.generation) {
        return { ok: false, reason: 'superseded' };
      }
      // `switchProxy`/`loadURL` reject constantly in real use - a down host
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
      // Only the current generation owns the state: a superseded procedure
      // must not flip a newer switch back to `idle`.
      if (myGeneration === this.generation) {
        this.setState('idle');
      }
    }
    return { ok: true };
  }
}
