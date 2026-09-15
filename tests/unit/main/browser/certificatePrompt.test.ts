import { describe, expect, it } from 'vitest';
import { computeCertificateFingerprintHex } from '../../../../src/main/aem/certificateExceptions';
import { createCertificateBlockedListener } from '../../../../src/main/browser/certificatePrompt';
import { tlsExceptionSchema } from '../../../../src/shared/contracts/serverConfig';
import { issueUntrustedLeafCert } from '../../../integration/support/testCa';

const ERROR_SELF_SIGNED = 'net::ERR_CERT_AUTHORITY_INVALID';

describe('createCertificateBlockedListener', () => {
  it('reports a blocked certificate with origin, fingerprint, and error class when there is no matching exception', async () => {
    const leaf = await issueUntrustedLeafCert('blocked.example.test');
    const aemSession = { marker: 'aem' };
    const blocked: unknown[] = [];

    const listener = createCertificateBlockedListener({
      aemSession,
      listExceptions: () => [],
      onBlocked: (info) => blocked.push(info),
    });

    listener(
      { preventDefault: () => undefined },
      { session: aemSession },
      'https://blocked.example.test:8443/some/page',
      ERROR_SELF_SIGNED,
      { data: leaf.cert },
      () => undefined,
    );

    expect(blocked).toEqual([
      {
        origin: 'https://blocked.example.test:8443',
        certificateSha256Fingerprint: computeCertificateFingerprintHex(leaf.cert),
        errorClass: ERROR_SELF_SIGNED,
      },
    ]);
  });

  it('does not report anything when an approved exception already covers the certificate', async () => {
    const leaf = await issueUntrustedLeafCert('approved.example.test');
    const aemSession = { marker: 'aem' };
    const blocked: unknown[] = [];
    const fingerprint = computeCertificateFingerprintHex(leaf.cert);

    const listener = createCertificateBlockedListener({
      aemSession,
      listExceptions: () => [
        tlsExceptionSchema.parse({
          origin: 'https://approved.example.test:8443',
          certificateSha256Fingerprint: fingerprint,
          errorClass: ERROR_SELF_SIGNED,
        }),
      ],
      onBlocked: (info) => blocked.push(info),
    });

    listener(
      { preventDefault: () => undefined },
      { session: aemSession },
      'https://approved.example.test:8443/some/page',
      ERROR_SELF_SIGNED,
      { data: leaf.cert },
      () => undefined,
    );

    expect(blocked).toEqual([]);
  });

  it("ignores certificate errors on a webContents that is not the AEM session, e.g. the app's own local UI", async () => {
    const leaf = await issueUntrustedLeafCert('other-session.example.test');
    const aemSession = { marker: 'aem' };
    const otherSession = { marker: 'app-ui' };
    const blocked: unknown[] = [];

    const listener = createCertificateBlockedListener({
      aemSession,
      listExceptions: () => [],
      onBlocked: (info) => blocked.push(info),
    });

    listener(
      { preventDefault: () => undefined },
      { session: otherSession },
      'https://other-session.example.test:8443/',
      ERROR_SELF_SIGNED,
      { data: leaf.cert },
      () => undefined,
    );

    expect(blocked).toEqual([]);
  });

  it('never calls preventDefault or the trust callback - it is purely observational', async () => {
    const leaf = await issueUntrustedLeafCert('observational.example.test');
    const aemSession = { marker: 'aem' };
    let preventDefaultCalls = 0;
    let callbackCalls = 0;

    const listener = createCertificateBlockedListener({
      aemSession,
      listExceptions: () => [],
      onBlocked: () => undefined,
    });

    listener(
      { preventDefault: () => (preventDefaultCalls += 1) },
      { session: aemSession },
      'https://observational.example.test:8443/',
      ERROR_SELF_SIGNED,
      { data: leaf.cert },
      () => (callbackCalls += 1),
    );

    expect(preventDefaultCalls).toBe(0);
    expect(callbackCalls).toBe(0);
  });
});
