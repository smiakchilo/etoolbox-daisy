import { describe, expect, it } from 'vitest';
import {
  resolveHostLabelInput,
  validateHostColorInput,
  validateOriginInput,
} from '../../../src/renderer/src/settings/viewModel';

describe('resolveHostLabelInput', () => {
  it('accepts a valid label unchanged', () => {
    expect(resolveHostLabelInput('Production', 'https://author.example')).toEqual({
      ok: true,
      label: 'Production',
    });
  });

  it('defaults a blank label to the host address', () => {
    expect(resolveHostLabelInput('   ', 'https://author.example')).toEqual({
      ok: true,
      label: 'https://author.example',
    });
  });

  it('trims surrounding whitespace from a provided label', () => {
    expect(resolveHostLabelInput(' Production ', 'https://author.example')).toEqual({
      ok: true,
      label: 'Production',
    });
  });

  it('leaves a blank label with a blank address to the address field', () => {
    // The address is the required field; an empty label with no address yet is
    // not an independent error, so this stays "ok" until the address is valid.
    expect(resolveHostLabelInput('', '')).toEqual({ ok: true, label: '' });
  });

  it('rejects an over-long label', () => {
    const result = resolveHostLabelInput('x'.repeat(101), 'https://author.example');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at most 100 characters/);
  });

  it('rejects an over-long address used as the default label', () => {
    const longOrigin = `https://${'a'.repeat(120)}.example`;
    const result = resolveHostLabelInput('', longOrigin);
    expect(result.ok).toBe(false);
  });
});

describe('validateHostColorInput', () => {
  it('accepts a named swatch', () => {
    expect(validateHostColorInput({ kind: 'swatch', swatch: 'blue' })).toEqual({
      ok: true,
      value: { kind: 'swatch', swatch: 'blue' },
    });
  });

  it('accepts a custom hex, normalized to lowercase', () => {
    expect(validateHostColorInput({ kind: 'custom', hex: '#ABCDEF' })).toEqual({
      ok: true,
      value: { kind: 'custom', hex: '#abcdef' },
    });
  });

  it('rejects an unknown swatch name', () => {
    const result = validateHostColorInput({ kind: 'swatch', swatch: 'chartreuse' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeDefined();
  });

  it('rejects an invalid custom colour', () => {
    const result = validateHostColorInput({ kind: 'custom', hex: 'not-a-colour' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeDefined();
  });
});

describe('validateOriginInput', () => {
  it('accepts and canonicalizes a valid origin', () => {
    expect(validateOriginInput('HTTPS://Author.Example')).toEqual({
      ok: true,
      origin: 'https://author.example',
    });
  });

  it('rejects a malformed origin with a readable message', () => {
    const result = validateOriginInput('not a url');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeDefined();
  });

  it('rejects an origin carrying a path', () => {
    const result = validateOriginInput('https://author.example/login');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/path/);
  });
});
