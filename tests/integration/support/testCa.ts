import selfsigned from 'selfsigned';

export interface GeneratedCert {
  readonly key: string;
  readonly cert: string;
}

/**
 * Generates a throwaway root CA for the proxy/TLS test matrix (Step 02,
 * requirements-decisions.md §4 "trusted corporate CA"). Only ever used to
 * sign leaf certificates served by our own local MITM test proxy - it is
 * never installed into any real trust store and never leaves this process.
 */
export async function generateTestCa(): Promise<GeneratedCert> {
  const ca = await selfsigned.generate([{ name: 'commonName', value: 'Daisy Test Root CA' }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        cRLSign: true,
        digitalSignature: true,
        critical: true,
      },
    ],
  });
  return { key: ca.private, cert: ca.cert };
}

/** Issues a leaf certificate for `hostname`, signed by `ca` (the "trusted corporate CA" case). */
export async function issueTrustedLeafCert(
  hostname: string,
  ca: GeneratedCert,
): Promise<GeneratedCert> {
  const leaf = await selfsigned.generate([{ name: 'commonName', value: hostname }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    ],
    ca: { key: ca.key, cert: ca.cert },
  });
  return { key: leaf.private, cert: leaf.cert };
}

/**
 * Issues a leaf certificate for `hostname` that is self-signed (NOT chained
 * to any CA supplied via `NODE_EXTRA_CA_CERTS`) - the "untrusted certificate"
 * case that must fail closed.
 */
export async function issueUntrustedLeafCert(hostname: string): Promise<GeneratedCert> {
  const leaf = await selfsigned.generate([{ name: 'commonName', value: hostname }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    ],
  });
  return { key: leaf.private, cert: leaf.cert };
}
