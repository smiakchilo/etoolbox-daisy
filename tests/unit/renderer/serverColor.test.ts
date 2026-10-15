import { describe, expect, it } from 'vitest';
import {
  resolveServerColorCss,
  resolveServerSwatchFromHex,
} from '../../../src/renderer/src/lib/serverColor';
import { SERVER_SWATCHES } from '../../../src/shared';

describe('resolveServerColorCss', () => {
  it('resolves every named swatch to a distinct 6-digit hex colour', () => {
    const resolved = SERVER_SWATCHES.map((swatch) =>
      resolveServerColorCss({ kind: 'swatch', swatch }),
    );
    for (const value of resolved) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(resolved).size).toBe(SERVER_SWATCHES.length);
  });

  it('passes a custom hex colour through unchanged', () => {
    expect(resolveServerColorCss({ kind: 'custom', hex: '#123abc' })).toBe('#123abc');
  });
});

describe('resolveServerSwatchFromHex', () => {
  it('round-trips every named swatch: hex back to the originating swatch', () => {
    for (const swatch of SERVER_SWATCHES) {
      const hex = resolveServerColorCss({ kind: 'swatch', swatch });
      expect(resolveServerSwatchFromHex(hex)).toBe(swatch);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    const blue = resolveServerColorCss({ kind: 'swatch', swatch: 'blue' });
    expect(resolveServerSwatchFromHex(`  ${blue.toUpperCase()} `)).toBe('blue');
    expect(resolveServerSwatchFromHex(blue.toLowerCase())).toBe('blue');
  });

  it('returns undefined for colours outside the closed swatch set', () => {
    expect(resolveServerSwatchFromHex('#123abc')).toBeUndefined();
    expect(resolveServerSwatchFromHex('not-a-hex')).toBeUndefined();
    expect(resolveServerSwatchFromHex('')).toBeUndefined();
  });
});
