import { describe, expect, it } from 'vitest';
import { resolveServerColorCss } from '../../../src/renderer/src/lib/serverColor';
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
