import { describe, expect, it } from 'vitest';
import {
  describeProxySnapshot,
  describeTlsException,
  validateEditServerForm,
  validateNewServerForm,
  validateOriginInput,
  type NewServerFormInput,
} from '../../../src/renderer/src/settings/viewModel';
import type { AemProxySnapshot, CopilotProxySnapshot, TlsException } from '../../../src/shared';

function baseInput(overrides: Partial<NewServerFormInput> = {}): NewServerFormInput {
  return {
    label: 'Production',
    origin: 'https://author.example',
    color: { kind: 'swatch', swatch: 'blue' },
    proxyOrigin: '',
    proxyUsername: '',
    allowInsecureHttp: false,
    ...overrides,
  };
}

describe('validateNewServerForm', () => {
  it('accepts a minimal valid server with no proxy', () => {
    const result = validateNewServerForm(baseInput());
    expect(result).toEqual({
      ok: true,
      value: {
        label: 'Production',
        origin: 'https://author.example',
        color: { kind: 'swatch', swatch: 'blue' },
      },
    });
  });

  it('accepts a valid server with a proxy address and username', () => {
    const result = validateNewServerForm(
      baseInput({ proxyOrigin: ' https://proxy.example:8080 ', proxyUsername: ' alice ' }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        label: 'Production',
        origin: 'https://author.example',
        color: { kind: 'swatch', swatch: 'blue' },
        proxy: { origin: 'https://proxy.example:8080', username: 'alice' },
      },
    });
  });

  it('accepts a custom hex colour, normalized to lowercase', () => {
    const result = validateNewServerForm(baseInput({ color: { kind: 'custom', hex: '#ABCDEF' } }));
    expect(result).toEqual({
      ok: true,
      value: {
        label: 'Production',
        origin: 'https://author.example',
        color: { kind: 'custom', hex: '#abcdef' },
      },
    });
  });

  it('accepts plain HTTP when explicitly allowed', () => {
    const result = validateNewServerForm(
      baseInput({ origin: 'http://internal.example', allowInsecureHttp: true }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        label: 'Production',
        origin: 'http://internal.example',
        color: { kind: 'swatch', swatch: 'blue' },
        allowInsecureHttp: true,
      },
    });
  });

  it('rejects plain HTTP when not explicitly allowed', () => {
    const result = validateNewServerForm(baseInput({ origin: 'http://internal.example' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.allowInsecureHttp).toBeDefined();
  });

  it('ignores allowInsecureHttp for an HTTPS origin', () => {
    const result = validateNewServerForm(baseInput({ allowInsecureHttp: true }));
    expect(result).toEqual({
      ok: true,
      value: {
        label: 'Production',
        origin: 'https://author.example',
        color: { kind: 'swatch', swatch: 'blue' },
      },
    });
  });

  it('rejects an empty label', () => {
    const result = validateNewServerForm(baseInput({ label: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.label).toBeDefined();
  });

  it('rejects a label with leading/trailing whitespace', () => {
    const result = validateNewServerForm(baseInput({ label: ' Production ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.label).toBeDefined();
  });

  it('rejects an origin carrying a path', () => {
    const result = validateNewServerForm(baseInput({ origin: 'https://author.example/login' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.origin).toMatch(/path/);
  });

  it('rejects an origin carrying userinfo', () => {
    const result = validateNewServerForm(baseInput({ origin: 'https://user:pass@author.example' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.origin).toMatch(/username or password/);
  });

  it('rejects an unsupported scheme', () => {
    const result = validateNewServerForm(baseInput({ origin: 'ftp://author.example' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.origin).toMatch(/http/);
  });

  it('rejects an invalid custom hex colour', () => {
    const result = validateNewServerForm(baseInput({ color: { kind: 'custom', hex: 'blue' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.color).toBeDefined();
  });

  it('rejects an invalid proxy origin', () => {
    const result = validateNewServerForm(baseInput({ proxyOrigin: 'not a url' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.proxyOrigin).toBeDefined();
  });

  it('rejects a proxy username with no proxy address', () => {
    const result = validateNewServerForm(baseInput({ proxyUsername: 'alice' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.proxyUsername).toBeDefined();
  });

  it("reports every field's error at once rather than stopping at the first", () => {
    const result = validateNewServerForm(
      baseInput({ label: '', origin: 'not a url', color: { kind: 'custom', hex: 'blue' } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.label).toBeDefined();
      expect(result.errors.origin).toBeDefined();
      expect(result.errors.color).toBeDefined();
    }
  });
});

describe('validateEditServerForm', () => {
  it('accepts a valid label and colour', () => {
    const result = validateEditServerForm({
      label: 'Staging',
      color: { kind: 'swatch', swatch: 'blue' },
    });
    expect(result).toEqual({
      ok: true,
      value: { label: 'Staging', color: { kind: 'swatch', swatch: 'blue' } },
    });
  });

  it('rejects an empty label', () => {
    const result = validateEditServerForm({ label: '', color: { kind: 'swatch', swatch: 'blue' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.label).toBeDefined();
  });

  it('rejects an invalid custom hex colour', () => {
    const result = validateEditServerForm({
      label: 'Staging',
      color: { kind: 'custom', hex: 'not-a-colour' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.color).toBeDefined();
  });

  it('reports both errors at once', () => {
    const result = validateEditServerForm({ label: '', color: { kind: 'custom', hex: 'nope' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.label).toBeDefined();
      expect(result.errors.color).toBeDefined();
    }
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

describe('describeTlsException', () => {
  it('reports no exception recorded', () => {
    expect(describeTlsException(undefined)).toBe('No certificate exception recorded.');
  });

  it('reports the origin and fingerprint', () => {
    const tlsException: TlsException = {
      origin: 'https://author.example',
      certificateSha256Fingerprint: 'a'.repeat(64),
      errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
    };
    expect(describeTlsException(tlsException)).toBe(
      `https://author.example - SHA-256 ${'a'.repeat(64)}`,
    );
  });
});
