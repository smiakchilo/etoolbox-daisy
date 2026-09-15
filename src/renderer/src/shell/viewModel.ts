import { isInsecureOrigin, type ServerId, type ServerSnapshot } from '../../../shared';
import { resolveServerColorCss } from '../lib/serverColor';

/** One entry the address bar's server picker button (`sp-action-menu`) renders. */
export interface ServerOption {
  readonly id: ServerId;
  readonly label: string;
  readonly origin: string;
  /** CSS colour for the paired swatch dot - never the only signal, see `resolveServerColorCss`. */
  readonly colorCss: string;
  readonly selected: boolean;
}

/** Builds the server-selector's option list from the settings snapshot. */
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
