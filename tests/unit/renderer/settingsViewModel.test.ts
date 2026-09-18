import { describe, expect, it } from 'vitest';
import {
  describeProxySnapshot,
  resolveHostLabelInput,
  validateHostColorInput,
  validateOriginInput,
} from '../../../src/renderer/src/settings/viewModel';
import type { AemProxySnapshot, CopilotProxySnapshot } from '../../../src/shared';

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

describe('describeProxySnapshot', () => {
  it('reports direct connection when no proxy is configured', () => {
    expect(describeProxySnapshot(undefined)).toBe('Not configured (direct connection)');
  });

  it('reports the proxy address when there are no credentials', () => {
    const proxy: AemProxySnapshot = { url: 'https://proxy.example:8080' };
    expect(describeProxySnapshot(proxy)).toBe('https://proxy.example:8080 (no proxy credentials)');
  });

  it('reports the username and that a password is stored', () => {
    const proxy: CopilotProxySnapshot = {
      url: 'https://proxy.example:8080',
      credentials: { username: 'alice', hasPassword: true },
    };
    expect(describeProxySnapshot(proxy)).toBe(
      'https://proxy.example:8080 - user "alice" (password stored)',
    );
  });

  it('reports when no password is stored', () => {
    const proxy: AemProxySnapshot = {
      url: 'https://proxy.example:8080',
      credentials: { username: 'alice', hasPassword: false },
    };
    expect(describeProxySnapshot(proxy)).toBe(
      'https://proxy.example:8080 - user "alice" (no password stored)',
    );
  });
});
