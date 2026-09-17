import {
  isInsecureOrigin,
  type CertificateBlockedInfo,
  type ServerId,
  type ServerSnapshot,
} from '../../../shared';
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

/** One entry the server picker panel (`serverPickerPanel.ts`) renders. */
export interface ServerOption {
  readonly id: ServerId;
  readonly label: string;
  readonly origin: string;
  /** CSS colour for the paired swatch dot - never the only signal, see `resolveServerColorCss`. */
  readonly colorCss: string;
  readonly selected: boolean;
}

/** Builds the server picker panel's option list from the settings snapshot. */
export function buildServerOptions(
  servers: readonly ServerSnapshot[],
  activeServerId: ServerId | null,
): readonly ServerOption[] {
  return servers.map((server) => ({
    id: server.id,
    label: server.label,
    origin: server.origin,
    colorCss: resolveServerColorCss(server.color),
    selected: server.id === activeServerId,
  }));
}

/** Display state for the persistent insecure-connection marker (requirements-decisions.md sections 4 and 8). */
export interface InsecureMarkerState {
  readonly visible: boolean;
  /** Empty when `visible` is false; always paired with the marker's icon/colour, never shown as colour alone. */
  readonly message: string;
}

const HIDDEN_MARKER: InsecureMarkerState = { visible: false, message: '' };

/**
 * Computes whether the persistent insecure marker should be shown, from the
 * currently active server's configured origin.
 *
 * This is the best available signal until main exposes a live "current
 * displayed URL" event (see `browserViewHost.ts`'s TODO): it reflects the
 * *configured* server, not necessarily the exact page currently rendered by
 * the `WebContentsView`, which can differ during an SSO redirect. Recomputing
 * from the live URL once that event exists would tighten this, not loosen it
 * (a same-origin page navigation cannot change the answer either way).
 */
export function computeInsecureMarker(
  servers: readonly ServerSnapshot[],
  activeServerId: ServerId | null,
): InsecureMarkerState {
  if (activeServerId === null) return HIDDEN_MARKER;
  const active = servers.find((server) => server.id === activeServerId);
  if (!active || !isInsecureOrigin(active.origin)) return HIDDEN_MARKER;
  return {
    visible: true,
    message: `Insecure connection: "${active.label}" (${active.origin}) uses plain HTTP, not HTTPS.`,
  };
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

/** Shrinks a certificate's bare hex SHA-256 fingerprint to a scannable short form: first 8 hex chars' …' last 6. */
export function shortFingerprint(fingerprint: string): string {
  return `${fingerprint.slice(0, 8)}\u2026${fingerprint.slice(-6)}`;
}

/**
 * Builds the copy for the browser pane's untrusted-certificate prompt (the
 * banner row in `browserToolbar.ts`). Pure so the exact wording and the
 * fingerprint short-form are unit-testable without a DOM or Electron. The
 * banner keeps the *decision* (origin, full fingerprint, error class) exactly
 * as main pushed it via `browser:certificate-blocked`; nothing here is
 * re-derived, so what the user is asked to approve is what was blocked.
 */
export function describeBlockedCertificate(info: CertificateBlockedInfo): string {
  return (
    `Untrusted certificate for ${info.origin} ` +
    `(SHA-256 ${shortFingerprint(info.certificateSha256Fingerprint)}, ${info.errorClass}).`
  );
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
  return 'This host is unknown. Press OK to add it to the managed hosts';
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
