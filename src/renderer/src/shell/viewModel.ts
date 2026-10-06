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
 * The configured host whose origin matches the address currently shown, or
 * `undefined` when the address is empty/unparseable or its origin matches no
 * configured host. The address bar pairs this with a coloured label block
 * (`.address-bar__host-label`) that names the host, so colour is never the
 * only signal.
 */
export function resolveAddressHost(
  address: string,
  hosts: readonly HostOption[],
): HostOption | undefined {
  let origin: string;
  try {
    origin = new URL(address).origin;
  } catch {
    return undefined;
  }
  return hosts.find((host) => host.origin === origin);
}

/**
 * Foreground colour for a host's coloured label block: white on the chromatic
 * swatches, dark gray once the background is light enough that white text
 * would all but vanish (e.g. the `yellow` swatch, or a near-white custom hex).
 *
 * The decision is made by contrast, not a bare "is it nearly white?"
 * luminance threshold: white text wins only while it keeps at least a
 * {@link MIN_LABEL_WHITE_CONTRAST}:1 ratio against the background, which
 * flips the bright-but-not-white swatches (yellow, orange) to dark gray too.
 * An unparseable colour (defensive: `ServerColor` is always a 6-digit hex)
 * falls back to white.
 */
export function resolveHostLabelForeground(colorCss: string): string {
  const rgb = parseHexColor(colorCss);
  if (rgb === undefined) return HOST_LABEL_WHITE_FOREGROUND;
  const backgroundLuminance = relativeLuminance(rgb);
  const contrastWithWhite = 1.05 / (backgroundLuminance + 0.05);
  return contrastWithWhite >= MIN_LABEL_WHITE_CONTRAST
    ? HOST_LABEL_WHITE_FOREGROUND
    : HOST_LABEL_DARK_FOREGROUND;
}

const HOST_LABEL_WHITE_FOREGROUND = '#ffffff';
/** Spectrum gray-800: the readable-on-light counterpart to white. */
const HOST_LABEL_DARK_FOREGROUND = '#2e2e2e';
/** Below this white-on-background contrast ratio, dark gray is the readable choice. */
const MIN_LABEL_WHITE_CONTRAST = 3;

function parseHexColor(
  color: string,
): { readonly r: number; readonly g: number; readonly b: number } | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  const rHex = match?.[1];
  const gHex = match?.[2];
  const bHex = match?.[3];
  if (rHex === undefined || gHex === undefined || bHex === undefined) return undefined;
  return {
    r: Number.parseInt(rHex, 16),
    g: Number.parseInt(gHex, 16),
    b: Number.parseInt(bHex, 16),
  };
}

/** WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). */
function relativeLuminance(rgb: {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * One inline autocompletion of the address field while the user types: the
 * full text to write back, plus the selected range the next keystroke will
 * replace. `value` is the matched host's canonical origin, or - for a label
 * match - `"<label> <origin>"`.
 */
export interface HostAutocomplete {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * The `host[:port]` portion of a canonical http(s) origin - what the user
 * types when they start from the domain name rather than the protocol.
 * Returns `undefined` for anything that is not a canonical http(s) origin.
 */
function originHostPart(origin: string): string | undefined {
  const match = /^https?:\/\/(.+)$/.exec(origin);
  return match?.[1];
}

/**
 * The inline "type-ahead" completion of a partially typed address against the
 * configured hosts (the address bar's Chrome-style autocomplete). Three
 * matches, in priority order:
 *
 * 1. a prefix of a host's full origin (typing from the protocol) - keep the
 *    typed prefix, select the appended remainder;
 * 2. a prefix of a host's `host[:port]` (typing from the domain name) - the
 *    origin is inserted with its protocol, and the part of the host after the
 *    typed prefix is selected, so "micr" becomes "https://micr[osoft.com]";
 * 3. a prefix of a host's *label* - the value becomes `"<label> <origin>"` and
 *    only the text after the typed label prefix is selected, so the user can
 *    keep typing the label without erasing the field (Enter later strips the
 *    label; see `resolveAddressSubmission`).
 *
 * Returns `undefined` when nothing matches, the type is only whitespace, or it
 * already names an origin/host exactly (nothing to append).
 */
export function findHostAutocomplete(
  typed: string,
  hosts: readonly HostOption[],
): HostAutocomplete | undefined {
  if (typed.trim() === '') return undefined;
  const lower = typed.toLowerCase();

  const byOrigin = hosts.find(
    (host) => host.origin.length > typed.length && host.origin.toLowerCase().startsWith(lower),
  );
  if (byOrigin !== undefined) {
    return {
      value: byOrigin.origin,
      selectionStart: typed.length,
      selectionEnd: byOrigin.origin.length,
    };
  }

  const byHost = hosts.find((host) => {
    const hostPart = originHostPart(host.origin);
    return (
      hostPart !== undefined &&
      hostPart.length > typed.length &&
      hostPart.toLowerCase().startsWith(lower)
    );
  });
  if (byHost !== undefined) {
    const hostPart = originHostPart(byHost.origin) ?? '';
    const schemePrefixLength = byHost.origin.length - hostPart.length;
    return {
      value: byHost.origin,
      selectionStart: schemePrefixLength + typed.length,
      selectionEnd: byHost.origin.length,
    };
  }

  const byLabel = hosts.find((host) => host.label.toLowerCase().startsWith(lower));
  if (byLabel !== undefined) {
    // A label does not prefix its URL, so the completion is shown as
    // "label + URL" and only the text *after* the typed label prefix is
    // selected - never the whole field (which would erase the user's typing on
    // the next keystroke). `resolveAddressSubmission` strips the label again on
    // Enter. `value` uses the canonical label, so continuing to type the label
    // re-matches case-insensitively.
    const value = `${byLabel.label} ${byLabel.origin}`;
    return { value, selectionStart: typed.length, selectionEnd: value.length };
  }

  return undefined;
}

/**
 * Completes a scheme-less address with the protocol (and port) of the
 * configured host whose `host[:port]` it names, or `undefined` when no host
 * matches. The host candidate is delimited by whitespace as well as the URL
 * delimiters, so the label half of a combined "label + URL" value can never be
 * mistaken for a host.
 */
function inferSchemeFromHosts(candidate: string, hosts: readonly HostOption[]): string | undefined {
  const match = /^([^/?#\s]+)(.*)$/.exec(candidate);
  const typedHost = match?.[1];
  const rest = match?.[2];
  if (typedHost === undefined || rest === undefined) return undefined;
  const lowerHost = typedHost.toLowerCase();
  const host = hosts.find((entry) => originHostPart(entry.origin)?.toLowerCase() === lowerHost);
  return host === undefined ? undefined : `${host.origin}${rest}`;
}

/**
 * The remainder after a configured host's label prefix (`"<label> "`), or
 * `undefined` when the value does not start with any configured label. The
 * label match is case-insensitive, since the field may carry an edited case.
 */
function stripConfiguredLabelPrefix(
  value: string,
  hosts: readonly HostOption[],
): string | undefined {
  const lower = value.toLowerCase();
  for (const host of hosts) {
    const prefix = `${host.label.toLowerCase()} `;
    if (lower.startsWith(prefix)) {
      const remainder = value.slice(prefix.length).trim();
      if (remainder !== '') return remainder;
    }
  }
  return undefined;
}

/**
 * Resolves what the user submitted from the address bar into a navigable URL.
 *
 * An absolute http(s) address is returned as typed. Otherwise:
 *
 * - a combined "label + URL" value (label autocomplete) has its configured
 *   label prefix stripped and what follows resolved - accepted only when that
 *   remainder is itself navigable, so a random string that merely starts with a
 *   label is left alone;
 * - a scheme-less address is completed with the protocol (and port) of the
 *   configured host whose `host[:port]` it names - "author.example/editor.html"
 *   becomes "https://author.example/editor.html" - the way a modern browser
 *   infers a protocol.
 *
 * Anything else is returned unchanged, so main's `parseNavigationTarget` still
 * refuses it with its own message.
 */
export function resolveAddressSubmission(value: string, hosts: readonly HostOption[]): string {
  const trimmed = value.trim();
  if (trimmed === '' || parseNavigationTarget(trimmed).ok) return trimmed;

  const labelled = stripConfiguredLabelPrefix(trimmed, hosts);
  if (labelled !== undefined) {
    const resolved = inferSchemeFromHosts(labelled, hosts) ?? labelled;
    if (parseNavigationTarget(resolved).ok) return resolved;
  }

  return inferSchemeFromHosts(trimmed, hosts) ?? trimmed;
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
