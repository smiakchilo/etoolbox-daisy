import { parseNavigationTarget, type ServerId, type ServerSnapshot } from '../../../shared';
import { BANNER_ACTION_MARKER } from '../lib/alertBanner';
import { resolveServerColorCss } from '../lib/serverColor';

/**
 * Derives a default server label from a canonical origin, for the browser
 * toolbar's "add this unknown origin as a server" flow. Uses `URL.host`
 * (host name plus the port only when it is non-default), so two local AEM
 * instances on different ports produce distinguishable labels instead of
 * both collapsing to "localhost". Falls back to the origin itself when the
 * host cannot be read (defensive - `parseOrigin` already guarantees a host).
 */
export function deriveServerLabelFromOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** One entry the hosts panel (`hostsPanel.ts`) renders. */
export interface HostOption {
  readonly id: ServerId;
  readonly label: string;
  readonly origin: string;
  /** CSS colour for the paired swatch dot - never the only signal, see `resolveServerColorCss`. */
  readonly colorCss: string;
}

/** Builds the hosts panel's option list from the settings snapshot. */
export function buildHostOptions(hosts: readonly ServerSnapshot[]): readonly HostOption[] {
  return hosts.map((server) => ({
    id: server.id,
    label: server.label,
    origin: server.origin,
    colorCss: resolveServerColorCss(server.color),
  }));
}

/**
 * The address bar's paired colour swatch: the CSS colour of the configured
 * host whose origin matches the address currently shown, or `undefined` when
 * the address is empty/unparseable or its origin matches no configured host -
 * the toolbar then lets the swatch fall back to its CSS default (a light
 * gray). Colour is never the only signal: the host's label is the address
 * text itself, and the hosts picker pairs every dot with its label.
 */
export function resolveAddressSwatchColor(
  address: string,
  hosts: readonly HostOption[],
): string | undefined {
  let origin: string;
  try {
    origin = new URL(address).origin;
  } catch {
    return undefined;
  }
  return hosts.find((host) => host.origin === origin)?.colorCss;
}

/**
 * Whether the address bar's current text names a page the "Open in external
 * browser" control may hand to the OS: an absolute http(s) URL with no
 * userinfo and a host - exactly the predicate main's `openExternal`
 * re-validates with (`parseNavigationTarget`). Anything else (empty, a bare
 * host without a scheme, a non-http(s) scheme, embedded credentials) leaves
 * the control disabled, so it never offers an action main would refuse.
 */
export function canOpenInExternalBrowser(address: string): boolean {
  return parseNavigationTarget(address).ok;
}

/**
 * Address-bar text. Always empty: this deliberately does not fall back to
 * the active server's *configured* origin. Until main reports the
 * `WebContentsView`'s live navigated URL (see `browserViewHost.ts`'s TODO),
 * showing the configured origin here would present unnavigated, invented
 * state as if it were the real current page - exactly what an address bar
 * must never do. Takes no arguments (rather than an unused snapshot) so it
 * cannot quietly start reading server data again without a signature change
 * once a live-URL IPC event exists to replace it.
 */
export function computeAddressBarValue(): string {
  return '';
}

/**
 * Builds the copy for the browser pane's untrusted-certificate prompt (the
 * banner row in `browserToolbar.ts`, the `browser:certificate-blocked` push).
 * Takes no arguments so it cannot quietly re-insert the origin or fingerprint
 * into the copy: both are already visible in the address bar above the banner
 * (and fingerprint-level detail was never something a decision-free row should
 * restate). The acting affordance is a single "OK" `sp-action-button` that
 * allows the certificate for the already-created managed server; cancel is the
 * banner's dismiss cross.
 */
export function describeBlockedCertificate(): string {
  return `Untrusted certificate. Press ${BANNER_ACTION_MARKER} to allow`;
}

/**
 * Builds the copy for the browser pane's unknown-origin prompt (the banner
 * row in `browserToolbar.ts`, `browser:navigate`'s `unknown_origin` error).
 * Takes no arguments so it cannot quietly re-insert the origin into the copy:
 * the address is already visible in the address bar right above the banner,
 * and citing it again is noise. The acting affordance is a single "OK"
 * `sp-action-button` that adds the host; cancel is the banner's dismiss cross.
 */
export function describeUnknownOrigin(): string {
  return `Unknown host. Press ${BANNER_ACTION_MARKER} to add it`;
}

/** Integer-pixel bounds suitable for `WebContentsView.setBounds()`. */
export interface ReservedRegionBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Rounds a measured `DOMRectReadOnly`-shaped rectangle to the integer pixel
 * bounds `WebContentsView.setBounds()` expects, clamping width/height to
 * non-negative (a rect can report a negative size mid-layout, e.g. while a
 * flex container is collapsing during a resize).
 *
 * Takes a plain `{x,y,width,height}` object rather than `DOMRectReadOnly`
 * itself so it stays callable from a Node-environment unit test with no DOM.
 */
export function computeReservedRegionBounds(rect: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): ReservedRegionBounds {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}
