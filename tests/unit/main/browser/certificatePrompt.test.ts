import { describe, expect, it } from 'vitest';
import { computeCertificateFingerprintHex } from '../../../../src/main/webview';
import { createCertificateBlockedListener } from '../../../../src/main/browser/certificatePrompt';
import { tlsExceptionSchema } from '../../../../src/shared';
import { issueUntrustedLeafCert } from '../../../integration/support/testCa';

const ERROR_SELF_SIGNED = 'net::ERR_CERT_AUTHORITY_INVALID';

describe('createCertificateBlockedListener', () => {
  it('reports a blocked certificate with origin, fingerprint, error class, and the full blocked URL when there is no matching exception', async () => {
    const leaf = await issueUntrustedLeafCert('blocked.example.test');
    const viewSession = { marker: 'host' };
    const blockedUrl = 'https://blocked.example.test:8443/some/page';
    const blocked: Array<{ info: unknown; url: string }> = [];

    const listener = createCertificateBlockedListener({
      viewSession,
      listExceptions: () => [],
      onBlocked: (info, url) => blocked.push({ info, url }),
    });

    listener(
      { preventDefault: () => undefined },
      { session: viewSession },
      blockedUrl,
      ERROR_SELF_SIGNED,
      { data: leaf.cert },
      () => undefined,
    );

    // The renderer-facing decision payload stays exactly the three
    // `TlsException` fields; the URL is a main-side-only retry target.
    expect(blocked).toEqual([
      {
        info: {
          origin: 'https://blocked.example.test:8443',
          certificateSha256Fingerprint: computeCertificateFingerprintHex(leaf.cert),
          errorClass: ERROR_SELF_SIGNED,
        },
        url: blockedUrl,
      },
    ]);
  });

  it('does not report anything when an approved exception already covers the certificate', async () => {
    const leaf = await issueUntrustedLeafCert('approved.example.test');
    const viewSession = { marker: 'host' };
    const blocked: unknown[] = [];
    const fingerprint = computeCertificateFingerprintHex(leaf.cert);

    const listener = createCertificateBlockedListener({
      viewSession,
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
      { session: viewSession },
      'https://approved.example.test:8443/some/page',
      ERROR_SELF_SIGNED,
      { data: leaf.cert },
      () => undefined,
    );

    expect(blocked).toEqual([]);
  });

  it("ignores certificate errors on a webContents that is not the AEM session, e.g. the app's own local UI", async () => {
    const leaf = await issueUntrustedLeafCert('other-session.example.test');
    const viewSession = { marker: 'host' };
    const otherSession = { marker: 'app-ui' };
    const blocked: unknown[] = [];

    const listener = createCertificateBlockedListener({
      viewSession,
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
    const viewSession = { marker: 'host' };
    let preventDefaultCalls = 0;
    let callbackCalls = 0;

    const listener = createCertificateBlockedListener({
      viewSession,
      listExceptions: () => [],
      onBlocked: () => undefined,
    });

    listener(
      { preventDefault: () => (preventDefaultCalls += 1) },
      { session: viewSession },
      'https://observational.example.test:8443/',
      ERROR_SELF_SIGNED,
      { data: leaf.cert },
      () => (callbackCalls += 1),
    );

    expect(preventDefaultCalls).toBe(0);
    expect(callbackCalls).toBe(0);
  });
});
