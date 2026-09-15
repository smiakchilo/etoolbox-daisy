import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeCertificateFingerprintHex,
  createCertificateErrorListener,
  createCertificateExceptionStore,
  decideCertificateTrust,
  type CertificateExceptionRecord,
  type ConnectionCloser,
} from '../../../../src/main/aem/certificateExceptions';
import { tlsExceptionSchema } from '../../../../src/shared/contracts/serverConfig';
import { issueUntrustedLeafCert } from '../../../integration/support/testCa';

const ORIGIN_A = 'https://aem.example.test:8443';
const ORIGIN_B = 'https://aem.example.test:9443';
const ERROR_SELF_SIGNED = 'net::ERR_CERT_AUTHORITY_INVALID';
const ERROR_EXPIRED = 'net::ERR_CERT_DATE_INVALID';

function record(overrides: Partial<CertificateExceptionRecord> = {}): CertificateExceptionRecord {
  return tlsExceptionSchema.parse({
    origin: ORIGIN_A,
    certificateSha256Fingerprint: 'a'.repeat(64),
    errorClass: ERROR_SELF_SIGNED,
    ...overrides,
  });
}

/** A closer that just counts calls, so tests can assert exactly when `closeAllConnections` fires. */
function createCountingCloser(): ConnectionCloser & { calls: number } {
  const closer = {
    calls: 0,
    closeAllConnections(): Promise<void> {
      closer.calls += 1;
      return Promise.resolve();
    },
  };
  return closer;
}

describe('computeCertificateFingerprintHex', () => {
  it('matches an independently computed SHA-256 fingerprint of a real certificate', async () => {
    const leaf = await issueUntrustedLeafCert('independent-fingerprint.example.test');

    // Independent verification path: Node's own `X509Certificate` parses the
    // PEM and exposes the raw DER via `.raw`, which this test hashes itself
    // with a *different* code path than `computeCertificateFingerprintHex`'s
    // PEM-stripping regex - so a bug shared between the two would not be
    // masked by comparing a function against itself.
    const x509 = new X509Certificate(leaf.cert);
    const expected = x509.fingerprint256.replace(/:/g, '').toLowerCase();

    expect(computeCertificateFingerprintHex(leaf.cert)).toBe(expected);
  });

  it('produces exactly 64 lowercase hex digits', async () => {
    const leaf = await issueUntrustedLeafCert('hex-shape.example.test');

    const fingerprint = computeCertificateFingerprintHex(leaf.cert);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on input that is not a PEM certificate', () => {
    expect(() => computeCertificateFingerprintHex('not a certificate')).toThrow();
  });
});

describe('decideCertificateTrust', () => {
  it('denies when there are no exceptions at all', () => {
    const decision = decideCertificateTrust(
      { url: ORIGIN_A + '/content/page.html', error: ERROR_SELF_SIGNED, certificatePem: 'pem' },
      [],
    );

    expect(decision.allow).toBe(false);
  });

  it('denies when the certificate PEM is malformed', () => {
    const decision = decideCertificateTrust(
      { url: ORIGIN_A + '/x', error: ERROR_SELF_SIGNED, certificatePem: 'not a pem' },
      [record()],
    );

    expect(decision).toEqual({ allow: false, reason: 'unparseable_certificate' });
  });

  it('allows when origin, fingerprint, and error class all match a real certificate exception', async () => {
    const leaf = await issueUntrustedLeafCert('decide-allow.example.test');
    const fingerprint = computeCertificateFingerprintHex(leaf.cert);
    const exceptions = [record({ certificateSha256Fingerprint: fingerprint })];

    const decision = decideCertificateTrust(
      { url: ORIGIN_A + '/content/page.html', error: ERROR_SELF_SIGNED, certificatePem: leaf.cert },
      exceptions,
    );

    expect(decision).toEqual({ allow: true });
  });

  it('denies when the port differs even though host and scheme match', async () => {
    const leaf = await issueUntrustedLeafCert('port-scope.example.test');
    const fingerprint = computeCertificateFingerprintHex(leaf.cert);
    const exceptions = [record({ origin: ORIGIN_B, certificateSha256Fingerprint: fingerprint })];

    const decision = decideCertificateTrust(
      { url: ORIGIN_A + '/content/page.html', error: ERROR_SELF_SIGNED, certificatePem: leaf.cert },
      exceptions,
    );

    expect(decision.allow).toBe(false);
  });

  it('denies when the certificate fingerprint differs even though origin matches', async () => {
    const leafA = await issueUntrustedLeafCert('fp-a.example.test');
    const leafB = await issueUntrustedLeafCert('fp-b.example.test');
    const exceptions = [
      record({ certificateSha256Fingerprint: computeCertificateFingerprintHex(leafA.cert) }),
    ];

    const decision = decideCertificateTrust(
      {
        url: ORIGIN_A + '/content/page.html',
        error: ERROR_SELF_SIGNED,
        certificatePem: leafB.cert,
      },
      exceptions,
    );

    expect(decision.allow).toBe(false);
  });

  it('denies when the error class differs even though origin and fingerprint match (hardening pin)', async () => {
    const leaf = await issueUntrustedLeafCert('error-class-pin.example.test');
    const fingerprint = computeCertificateFingerprintHex(leaf.cert);
    const exceptions = [
      record({ certificateSha256Fingerprint: fingerprint, errorClass: ERROR_SELF_SIGNED }),
    ];

    const decision = decideCertificateTrust(
      // Same origin, same certificate, but a *different* validation failure
      // (expired rather than self-signed) - approving a self-signed
      // certificate must not silently also cover it going on to expire.
      { url: ORIGIN_A + '/content/page.html', error: ERROR_EXPIRED, certificatePem: leaf.cert },
      exceptions,
    );

    expect(decision.allow).toBe(false);
  });

  it('denies for a malformed URL', () => {
    const decision = decideCertificateTrust(
      { url: 'not a url', error: ERROR_SELF_SIGNED, certificatePem: 'pem' },
      [],
    );

    expect(decision.allow).toBe(false);
  });
});

describe('createCertificateExceptionStore', () => {
  it('closes all connections when a new exception is approved', async () => {
    const closer = createCountingCloser();
    const store = createCertificateExceptionStore(closer);

    await store.approve(record());

    expect(closer.calls).toBe(1);
  });

  it('closes all connections again when an exception is replaced with a different fingerprint', async () => {
    const closer = createCountingCloser();
    const store = createCertificateExceptionStore(closer);
    await store.approve(record());

    await store.approve(record({ certificateSha256Fingerprint: 'c'.repeat(64) }));

    expect(closer.calls).toBe(2);
  });

  it('does not close connections again when the identical exception is re-approved', async () => {
    const closer = createCountingCloser();
    const store = createCertificateExceptionStore(closer);
    await store.approve(record());

    await store.approve(record());

    expect(closer.calls).toBe(1);
  });

  it('closes all connections when an exception is revoked', async () => {
    const closer = createCountingCloser();
    const store = createCertificateExceptionStore(closer);
    await store.approve(record());

    await store.revoke(ORIGIN_A);

    expect(closer.calls).toBe(2);
  });

  it('does not close connections when revoking an origin with no exception', async () => {
    const closer = createCountingCloser();
    const store = createCertificateExceptionStore(closer);

    await store.revoke(ORIGIN_A);

    expect(closer.calls).toBe(0);
  });

  it('lists and gets approved exceptions', async () => {
    const closer = createCountingCloser();
    const store = createCertificateExceptionStore(closer);
    await store.approve(record());

    expect(store.list()).toEqual([record()]);
    expect(store.get(ORIGIN_A)).toEqual(record());
    expect(store.get(ORIGIN_B)).toBeUndefined();
  });

  it("decide() reflects the store's current exceptions", async () => {
    const closer = createCountingCloser();
    const store = createCertificateExceptionStore(closer);
    const leaf = await issueUntrustedLeafCert('store-decide.example.test');
    const fingerprint = computeCertificateFingerprintHex(leaf.cert);

    expect(
      store.decide({ url: ORIGIN_A + '/x', error: ERROR_SELF_SIGNED, certificatePem: leaf.cert })
        .allow,
    ).toBe(false);

    await store.approve(record({ certificateSha256Fingerprint: fingerprint }));

    expect(
      store.decide({ url: ORIGIN_A + '/x', error: ERROR_SELF_SIGNED, certificatePem: leaf.cert })
        .allow,
    ).toBe(true);
  });

  it('rejects an invalid record (defence in depth: no wildcard/partial entries)', async () => {
    const closer = createCountingCloser();
    const store = createCertificateExceptionStore(closer);

    await expect(
      store.approve({ origin: 'not-a-url', certificateSha256Fingerprint: 'x', errorClass: '' }),
    ).rejects.toThrow();
    expect(closer.calls).toBe(0);
  });
});

describe('createCertificateErrorListener', () => {
  const aemSession = { id: 'aem' };
  const otherSession = { id: 'other' };

  function callbackCapture(): { calls: boolean[]; callback: (isTrusted: boolean) => void } {
    const calls: boolean[] = [];
    return { calls, callback: (isTrusted) => calls.push(isTrusted) };
  }

  it('approves and calls preventDefault when the store allows and the session is the AEM session', () => {
    const store = { decide: () => ({ allow: true as const }) };
    const listener = createCertificateErrorListener({ aemSession, store });
    const { calls, callback } = callbackCapture();
    let prevented = false;

    listener(
      { preventDefault: () => (prevented = true) },
      { session: aemSession },
      ORIGIN_A + '/x',
      ERROR_SELF_SIGNED,
      { data: 'pem' },
      callback,
    );

    expect(prevented).toBe(true);
    expect(calls).toEqual([true]);
  });

  it('leaves the default rejection in place when the store denies, without consuming the one-time callback', () => {
    const store = { decide: () => ({ allow: false as const, reason: 'no_matching_exception' }) };
    const listener = createCertificateErrorListener({ aemSession, store });
    const { calls, callback } = callbackCapture();
    let prevented = false;

    listener(
      { preventDefault: () => (prevented = true) },
      { session: aemSession },
      ORIGIN_A + '/x',
      ERROR_SELF_SIGNED,
      { data: 'pem' },
      callback,
    );

    expect(prevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it('leaves a non-AEM session entirely alone, without consulting the store or consuming the callback', () => {
    let decideCalled = false;
    const store = {
      decide: () => {
        decideCalled = true;
        return { allow: true as const };
      },
    };
    const listener = createCertificateErrorListener({ aemSession, store });
    const { calls, callback } = callbackCapture();

    listener(
      { preventDefault: () => undefined },
      { session: otherSession },
      ORIGIN_A + '/x',
      ERROR_SELF_SIGNED,
      { data: 'pem' },
      callback,
    );

    expect(calls).toEqual([]);
    expect(decideCalled).toBe(false);
  });
});
