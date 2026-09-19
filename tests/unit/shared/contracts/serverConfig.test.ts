import { describe, expect, it } from 'vitest';
import { newProxyId, newServerId } from '../../../../src/shared';
import {
  SERVER_SWATCHES,
  aemProxyConfigSchema,
  bumpRevision,
  customHexColorSchema,
  isStaleRevision,
  serverColorSchema,
  serverConfigSchema,
  sha256FingerprintSchema,
  tlsExceptionSchema,
  updatePresentation,
} from '../../../../src/shared';

const serverId = newServerId(() => 'server-1');

function validConfig() {
  return {
    id: serverId,
    label: 'Production',
    origin: 'https://author.example',
    color: { kind: 'swatch' as const, swatch: 'blue' as const },
    revision: 0,
  };
}

describe('serverConfigSchema', () => {
  it('round-trips a valid config: parsing and re-serializing produces the same value', () => {
    const input = validConfig();
    const parsed = serverConfigSchema.parse(input);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
  });

  describe('origin rejection', () => {
    it('rejects an origin containing userinfo', () => {
      expect(() =>
        serverConfigSchema.parse({ ...validConfig(), origin: 'https://user:pass@author.example' }),
      ).toThrow();
    });

    it('rejects an origin containing a path', () => {
      expect(() =>
        serverConfigSchema.parse({ ...validConfig(), origin: 'https://author.example/some/path' }),
      ).toThrow();
    });

    it('rejects an origin containing a query', () => {
      expect(() =>
        serverConfigSchema.parse({ ...validConfig(), origin: 'https://author.example?x=1' }),
      ).toThrow();
    });

    it('rejects an origin containing a fragment', () => {
      expect(() =>
        serverConfigSchema.parse({ ...validConfig(), origin: 'https://author.example#section' }),
      ).toThrow();
    });

    it('rejects an origin with an unsupported scheme', () => {
      expect(() =>
        serverConfigSchema.parse({ ...validConfig(), origin: 'ftp://author.example' }),
      ).toThrow();
    });

    it('rejects a malformed origin', () => {
      expect(() => serverConfigSchema.parse({ ...validConfig(), origin: 'not a url' })).toThrow();
    });
  });

  describe('color', () => {
    it.each(SERVER_SWATCHES)('accepts the %s swatch', (swatch) => {
      const result = serverColorSchema.parse({ kind: 'swatch', swatch });
      expect(result).toEqual({ kind: 'swatch', swatch });
    });

    it('normalizes a valid custom hex colour to lowercase', () => {
      expect(customHexColorSchema.parse('#ABCDEF')).toBe('#abcdef');
    });

    it('rejects 3-digit shorthand hex', () => {
      expect(() => customHexColorSchema.parse('#abc')).toThrow();
    });

    it('rejects 8-digit hex with an alpha channel', () => {
      expect(() => customHexColorSchema.parse('#aabbccdd')).toThrow();
    });

    it('rejects hex missing the leading #', () => {
      expect(() => customHexColorSchema.parse('aabbcc')).toThrow();
    });

    it('rejects non-hex characters', () => {
      expect(() => customHexColorSchema.parse('#zzzzzz')).toThrow();
    });

    it('accepts a custom colour through the discriminated union', () => {
      expect(serverColorSchema.parse({ kind: 'custom', hex: '#112233' })).toEqual({
        kind: 'custom',
        hex: '#112233',
      });
    });
  });

  describe('strictness', () => {
    it('rejects an unknown top-level key', () => {
      expect(() => serverConfigSchema.parse({ ...validConfig(), extraneous: 'nope' })).toThrow();
    });

    it('rejects a config carrying a password field', () => {
      expect(() => serverConfigSchema.parse({ ...validConfig(), password: 'hunter2' })).toThrow();
    });

    it('rejects proxy credentials carrying a password field', () => {
      expect(() =>
        aemProxyConfigSchema.parse({
          url: 'https://proxy.example:8080',
          credentials: { username: 'alice', secretRef: 'vault://proxy/alice', password: 'hunter2' },
        }),
      ).toThrow();
    });

    it('rejects a proxy config carrying a bare secret field', () => {
      expect(() =>
        aemProxyConfigSchema.parse({ url: 'https://proxy.example:8080', secret: 'hunter2' }),
      ).toThrow();
    });
  });

  describe('proxy and TLS exception', () => {
    it('accepts a proxy with credentials', () => {
      const proxy = {
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', secretRef: 'vault://proxy/alice' },
      };
      expect(aemProxyConfigSchema.parse(proxy)).toEqual(proxy);
    });

    it('accepts a server with a TLS exception and no proxy configured (direct HTTPS)', () => {
      const config = {
        ...validConfig(),
        tlsException: {
          origin: 'https://author.example',
          certificateSha256Fingerprint: 'a'.repeat(64),
          errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
        },
      };
      expect(serverConfigSchema.parse(config)).toEqual(config);
    });

    it("clears a TLS exception when the server's origin changes, rather than transferring or orphaning it", () => {
      const config = serverConfigSchema.parse({
        ...validConfig(),
        tlsException: {
          origin: 'https://author.example',
          certificateSha256Fingerprint: 'a'.repeat(64),
          errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
        },
      });
      const bumped = bumpRevision(config, { origin: 'https://author2.example' });
      expect(bumped.tlsException).toBeUndefined();
    });

    it('does not silently resurrect an old TLS exception when the origin is changed back to its original value', () => {
      const original = serverConfigSchema.parse({
        ...validConfig(),
        tlsException: {
          origin: 'https://author.example',
          certificateSha256Fingerprint: 'a'.repeat(64),
          errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
        },
      });
      const changedAway = bumpRevision(original, { origin: 'https://author2.example' });
      const changedBack = bumpRevision(changedAway, { origin: 'https://author.example' });
      expect(changedBack.origin).toBe('https://author.example');
      expect(changedBack.tlsException).toBeUndefined();
    });

    it('keeps a replacement TLS exception supplied in the same call that changes the origin', () => {
      const config = serverConfigSchema.parse({
        ...validConfig(),
        tlsException: {
          origin: 'https://author.example',
          certificateSha256Fingerprint: 'a'.repeat(64),
          errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
        },
      });
      const bumped = bumpRevision(config, {
        origin: 'https://author2.example',
        tlsException: {
          origin: 'https://author2.example',
          certificateSha256Fingerprint: 'b'.repeat(64),
          errorClass: 'net::ERR_CERT_DATE_INVALID',
        },
      });
      expect(bumped.tlsException?.origin).toBe('https://author2.example');
      expect(bumped.tlsException?.certificateSha256Fingerprint).toBe('b'.repeat(64));
      expect(bumped.tlsException?.errorClass).toBe('net::ERR_CERT_DATE_INVALID');
    });

    it('normalizes a colon-separated fingerprint to the same value as its bare-hex form', () => {
      const bare = sha256FingerprintSchema.parse('AB'.repeat(32));
      const colonSeparated = sha256FingerprintSchema.parse(Array(32).fill('AB').join(':'));
      expect(colonSeparated).toBe(bare);
      expect(bare).toBe('ab'.repeat(32));
    });

    it('rejects a fingerprint of the wrong length', () => {
      expect(() => sha256FingerprintSchema.parse('a'.repeat(40))).toThrow();
    });

    it('rejects a fingerprint using a non-colon separator', () => {
      expect(() => sha256FingerprintSchema.parse(Array(32).fill('ab').join('-'))).toThrow();
    });

    it('rejects a fingerprint containing non-hex characters', () => {
      expect(() => sha256FingerprintSchema.parse('g'.repeat(64))).toThrow();
    });

    it('rejects a TLS exception with an invalid origin', () => {
      expect(() =>
        tlsExceptionSchema.parse({
          origin: 'https://author.example/path',
          certificateSha256Fingerprint: 'a'.repeat(64),
          errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
        }),
      ).toThrow();
    });

    it('rejects a TLS exception missing the required error class', () => {
      expect(() =>
        tlsExceptionSchema.parse({
          origin: 'https://author.example',
          certificateSha256Fingerprint: 'a'.repeat(64),
        }),
      ).toThrow();
    });
  });

  describe('presentation vs. targeting changes', () => {
    it('does not bump the revision when only the label changes', () => {
      const config = serverConfigSchema.parse(validConfig());
      const updated = updatePresentation(config, { label: 'Renamed' });
      expect(updated.label).toBe('Renamed');
      expect(updated.revision).toBe(config.revision);
    });

    it('does not bump the revision when only the colour changes', () => {
      const config = serverConfigSchema.parse(validConfig());
      const updated = updatePresentation(config, {
        color: { kind: 'swatch', swatch: 'orange' },
      });
      expect(updated.color).toEqual({ kind: 'swatch', swatch: 'orange' });
      expect(updated.revision).toBe(config.revision);
    });

    it('bumps the revision when the origin changes', () => {
      const config = serverConfigSchema.parse(validConfig());
      const bumped = bumpRevision(config, { origin: 'https://author2.example' });
      expect(bumped.revision).toBe(config.revision + 1);
    });

    it('bumps the revision when a proxy is added', () => {
      const config = serverConfigSchema.parse(validConfig());
      const bumped = bumpRevision(config, {
        proxy: { url: 'https://proxy.example:8080' },
      });
      expect(bumped.proxy).toEqual({ url: 'https://proxy.example:8080' });
      expect(bumped.revision).toBe(config.revision + 1);
    });

    it('bumps the revision when a proxy-library reference is set', () => {
      const config = serverConfigSchema.parse(validConfig());
      const proxyId = newProxyId(() => 'proxy-1');
      const bumped = bumpRevision(config, { proxyId });
      expect(bumped.proxyId).toBe(proxyId);
      expect(bumped.revision).toBe(config.revision + 1);
    });
  });

  describe('removing an optional targeting field', () => {
    it('removes a configured proxy when bumpRevision is called with proxy: null, and still bumps the revision', () => {
      const config = serverConfigSchema.parse({
        ...validConfig(),
        proxy: { url: 'https://proxy.example:8080' },
      });
      const bumped = bumpRevision(config, { proxy: null });
      expect(bumped.proxy).toBeUndefined();
      expect(bumped.revision).toBe(config.revision + 1);
    });

    it('removes a configured TLS exception when bumpRevision is called with tlsException: null', () => {
      const config = serverConfigSchema.parse({
        ...validConfig(),
        tlsException: {
          origin: 'https://author.example',
          certificateSha256Fingerprint: 'a'.repeat(64),
          errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
        },
      });
      const bumped = bumpRevision(config, { tlsException: null });
      expect(bumped.tlsException).toBeUndefined();
    });

    it('leaves an existing proxy untouched when bumpRevision is called without mentioning proxy', () => {
      const config = serverConfigSchema.parse({
        ...validConfig(),
        proxy: { url: 'https://proxy.example:8080' },
      });
      const bumped = bumpRevision(config, { origin: 'https://author2.example' });
      expect(bumped.proxy).toEqual({ url: 'https://proxy.example:8080' });
    });

    it('removes a proxy-library reference when bumpRevision is called with proxyId: null', () => {
      const config = serverConfigSchema.parse({
        ...validConfig(),
        proxyId: newProxyId(() => 'proxy-1'),
      });
      const bumped = bumpRevision(config, { proxyId: null });
      expect(bumped.proxyId).toBeUndefined();
      expect(bumped.revision).toBe(config.revision + 1);
    });

    it('keeps the proxy-library reference across an origin change', () => {
      const proxyId = newProxyId(() => 'proxy-1');
      const config = serverConfigSchema.parse({ ...validConfig(), proxyId });
      const bumped = bumpRevision(config, { origin: 'https://author2.example' });
      expect(bumped.proxyId).toBe(proxyId);
    });
  });

  describe('revision', () => {
    it('increments on bumpRevision', () => {
      const config = serverConfigSchema.parse(validConfig());
      const bumped = bumpRevision(config);
      expect(bumped.revision).toBe(config.revision + 1);
    });

    it('bumps the revision when the origin changes', () => {
      const config = serverConfigSchema.parse(validConfig());
      const bumped = bumpRevision(config, { origin: 'https://author2.example' });
      expect(bumped.origin).toBe('https://author2.example');
      expect(bumped.revision).toBe(config.revision + 1);
      expect(bumped.id).toBe(config.id);
    });

    it('never decreases across repeated targeting bumps', () => {
      let config = serverConfigSchema.parse(validConfig());
      let previousRevision = config.revision;
      for (let i = 0; i < 5; i += 1) {
        config = bumpRevision(config, { origin: `https://author${String(i)}.example` });
        expect(config.revision).toBeGreaterThan(previousRevision);
        previousRevision = config.revision;
      }
    });

    it('never changes across repeated presentation-only updates', () => {
      let config = serverConfigSchema.parse(validConfig());
      const startingRevision = config.revision;
      for (let i = 0; i < 5; i += 1) {
        config = updatePresentation(config, { label: `Label ${String(i)}` });
      }
      expect(config.revision).toBe(startingRevision);
    });

    it('treats an observed revision equal to the current one as not stale', () => {
      expect(isStaleRevision(3, 3)).toBe(false);
    });

    it('treats an observed revision older than the current one as stale', () => {
      expect(isStaleRevision(2, 3)).toBe(true);
    });

    it('treats an observed revision newer than the current one as not stale', () => {
      expect(isStaleRevision(4, 3)).toBe(false);
    });
  });
});
