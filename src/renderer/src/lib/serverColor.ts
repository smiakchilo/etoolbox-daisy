import type { ServerColor, ServerSwatch } from '../../../shared';

/**
 * Concrete CSS colour for each named swatch (requirements-decisions.md
 * section 8: colour must always be paired with the server's text label, never
 * the only signal - this module only ever supplies the *value* for that
 * paired swatch dot, never a replacement for the label).
 *
 * These are Adobe Spectrum's published "600"-scale chromatic values. They are
 * hard-coded rather than read from a CSS custom property because this
 * component subset does not expose one: `sp-status-light`'s colour variants
 * only cover part of {@link ServerSwatch} (no `red`/`orange`/`green`/`blue`
 * entries - those names are reserved for its semantic negative/notice/
 * positive/info variants instead), so it cannot render this closed set.
 */
const SWATCH_HEX: Readonly<Record<ServerSwatch, string>> = {
  red: '#e34850',
  orange: '#e68619',
  yellow: '#dfbf00',
  green: '#2d9d78',
  seafoam: '#1b959a',
  blue: '#2680eb',
  indigo: '#6767ec',
  purple: '#9256d9',
  fuchsia: '#c038cc',
  magenta: '#d83790',
};

/** Resolves a {@link ServerColor} to a CSS colour value for the swatch dot. */
export function resolveServerColorCss(color: ServerColor): string {
  return color.kind === 'swatch' ? SWATCH_HEX[color.swatch] : color.hex;
}

/**
 * Reverse of {@link resolveServerColorCss}: which named swatch a 6-digit hex
 * belongs to, if any. The settings colour picker's field always holds a hex
 * (a picked swatch writes its concrete `#rrggbb`, never its name), so a known
 * swatch hex must round-trip back to the swatch when the form is read, instead
 * of silently degrading a `blue` pick to a stored `custom` value.
 */
const SWATCH_BY_HEX: ReadonlyMap<string, ServerSwatch> = new Map(
  (Object.entries(SWATCH_HEX) as ReadonlyArray<[ServerSwatch, string]>).map(([swatch, hex]) => [
    hex.toLowerCase(),
    swatch,
  ]),
);

/** Returns the named swatch for `hex`, or `undefined` when it is not one of the closed set. */
export function resolveServerSwatchFromHex(hex: string): ServerSwatch | undefined {
  return SWATCH_BY_HEX.get(hex.trim().toLowerCase());
}
