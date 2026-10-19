import { createHash } from 'node:crypto';
import { tlsExceptionSchema, type TlsException } from '../../shared';

/**
 * Certificate-exception policy for the browser session (implementation-plan.md
 * step 05; requirements-decisions.md section 4;
 * docs/verification.md "Step 05 prerequisite - technical gate G3").
 *
 * G3 was proven against a real Electron process, not merely against the
 * documentation, and it settled two design questions this module encodes:
 *
 * 1. `session.setCertificateVerifyProc()` cannot express this policy at all -
 *    its request object exposes `hostname` with no port, so two servers on
 *    the same hostname differing only by port are indistinguishable to it.
 *    The `certificate-error` event carries the full request URL (port
 *    included) and - the decisive finding - fires for `fetch()`, not only
 *    top-level navigation. This module is written against that event; see
 *    `createCertificateErrorListener` below for the Electron-facing side.
 * 2. Chromium caches an ALLOW decision for a (host, port, certificate) tuple.
 *    Replacing an exception does nothing on its own -
 *    `clearHostResolverCache()` does not touch it either - only
 *    `session.closeAllConnections()` does. Every mutation in
 *    {@link createCertificateExceptionStore} therefore closes connections
 *    through the injected {@link ConnectionCloser}. (There is deliberately no
 *    in-app revoke path: exceptions are only ever *added* here, and removed
 *    by editing the persisted `settings.json` with the app closed - a fresh
 *    Chromium session has no cached decisions to clear. See the certificate-
 *    prompt deviation note in `docs/verification.md`, "Deviation record —
 *    certificate-exception approvals moved into the browser pane".)
 *
 * Matching requires an exact origin (scheme + host + port) AND the
 * certificate's SHA-256 fingerprint AND the reported error class (e.g.
 * `net::ERR_CERT_AUTHORITY_INVALID`) - all three are now first-class fields
 * of the persisted `ServerConfig.tlsException` contract itself
 * (`src/shared/contracts/serverConfig.ts`'s `tlsExceptionSchema`), so an
 * exception approved in one session still pins its error class after an
 * application restart; see that schema's doc comment for *why* the pin
 * exists (a revoked or expired certificate changes neither origin nor
 * fingerprint). There is no wildcard matching and no hostname-only entry:
 * every exception is validated with `tlsExceptionSchema` itself, so one can
 * never be recorded from partial or malformed input.
 *
 * `CertificateExceptionRecord` is a plain alias for `TlsException` - the
 * exact persisted shape - rather than a parallel type: an earlier version of
 * this module kept a separate runtime-only record type because the
 * persisted contract had no room for `errorClass`, but now that
 * `tlsExceptionSchema` carries it directly there is nothing left for a
 * second type to add.
 */
export type CertificateExceptionRecord = TlsException;

const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/;

/**
 * Computes the SHA-256 fingerprint of a PEM-encoded certificate, normalized
 * to the bare 64-lowercase-hex-digit form `sha256FingerprintSchema` expects.
 *
 * Electron's own `Certificate.fingerprint` is NOT that format: observed
 * against the real installed `electron@44.3.0`, it is
 * `"sha256/<base64 of the hash>"` (docs/verification.md). Trusting it
 * directly would either fail `sha256FingerprintSchema` outright or - worse -
 * silently compare the wrong representation. This function instead starts
 * from `certificate.data` (the PEM Electron actually provides), decodes it
 * back to the raw DER bytes the PEM encodes, and hashes those bytes itself -
 * the same input a hex fingerprint from a certificate viewer describes.
 */
export function computeCertificateFingerprintHex(pemData: string): string {
  const match = PEM_CERTIFICATE_PATTERN.exec(pemData);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error('Certificate data is not a PEM-encoded certificate');
  }
  const der = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  return createHash('sha256').update(der).digest('hex');
}

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

/** What a `certificate-error` event reports, reduced to what the decision needs. */
export interface CertificateDecisionInput {
  /** The full request URL, port included - this is what makes port-scoped pinning possible at all. */
  readonly url: string;
  /** Chromium's error class for this failure, e.g. `net::ERR_CERT_AUTHORITY_INVALID`. */
  readonly error: string;
  /** The certificate's PEM data (`Certificate.data`), not its `.fingerprint` string - see {@link computeCertificateFingerprintHex}. */
  readonly certificatePem: string;
}

export type CertificateDecision =
  { readonly allow: true } | { readonly allow: false; readonly reason: string };

/**
 * Decides whether `input` is covered by an already-approved exception.
 * Pure and Electron-free, so the security-relevant matching logic - exact
 * origin AND fingerprint AND error class, never any one alone - is directly
 * unit-testable without a running Electron process.
 */
export function decideCertificateTrust(
  input: CertificateDecisionInput,
  exceptions: readonly CertificateExceptionRecord[],
): CertificateDecision {
  let origin: string;
  try {
    origin = new URL(input.url).origin;
  } catch {
    return { allow: false, reason: 'malformed_url' };
  }

  let fingerprint: string;
  try {
    fingerprint = computeCertificateFingerprintHex(input.certificatePem);
  } catch {
    return { allow: false, reason: 'unparseable_certificate' };
  }

  const matched = exceptions.some(
    (exception) =>
      exception.origin === origin &&
      exception.certificateSha256Fingerprint === fingerprint &&
      exception.errorClass === input.error,
  );
  return matched ? { allow: true } : { allow: false, reason: 'no_matching_exception' };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * The one Electron capability replacing an exception needs - narrowed from
 * `Session` to a single method so this store is constructible and testable
 * with a plain fake, per docs/verification.md constraint 1 ("Chromium caches
 * the ALLOW decision ... `session.closeAllConnections()` DOES [clear it]").
 */
export interface ConnectionCloser {
  closeAllConnections(): Promise<void>;
}

export interface CertificateExceptionStore {
  list(): readonly CertificateExceptionRecord[];
  get(origin: string): CertificateExceptionRecord | undefined;
  /**
   * Adds a new exception, or replaces the existing one for the same origin.
   * Closes all connections on the underlying session whenever this actually
   * changes what is approved for that origin (new origin, or a different
   * fingerprint/error class) - not on a no-op re-approval of an identical
   * record, which has nothing cached to invalidate.
   */
  approve(record: CertificateExceptionRecord): Promise<void>;
  /** Convenience wrapper around {@link decideCertificateTrust} using this store's current exceptions. */
  decide(input: CertificateDecisionInput): CertificateDecision;
}

/** Creates an in-memory exception store bound to one browser session's connection-closing capability. */
export function createCertificateExceptionStore(
  closer: ConnectionCloser,
): CertificateExceptionStore {
  const byOrigin = new Map<string, CertificateExceptionRecord>();

  return {
    list: () => Array.from(byOrigin.values()),
    get: (origin) => byOrigin.get(origin),

    async approve(record) {
      const parsed = tlsExceptionSchema.parse(record);
      const existing = byOrigin.get(parsed.origin);
      const changed =
        existing === undefined ||
        existing.certificateSha256Fingerprint !== parsed.certificateSha256Fingerprint ||
        existing.errorClass !== parsed.errorClass;
      byOrigin.set(parsed.origin, parsed);
      if (changed) {
        await closer.closeAllConnections();
      }
    },

    decide: (input) => decideCertificateTrust(input, Array.from(byOrigin.values())),
  };
}

// ---------------------------------------------------------------------------
// Electron-facing wiring
// ---------------------------------------------------------------------------

/**
 * The narrow shapes below intentionally do NOT import Electron's own
 * `Event`/`WebContents`/`Certificate` types. Each only requires the single
 * member `createCertificateErrorListener` actually reads
 * (`preventDefault()`, `.session`, `.data`), so:
 *
 * - a real `app.on("certificate-error", listener)` registration still
 *   type-checks (Electron's real argument types are strictly *more*
 *   specific than these, and TypeScript's contravariant parameter checking
 *   accepts that), and
 * - a unit test can pass a plain object literal instead of constructing (or
 *   casting to) a full Electron `Certificate`/`WebContents`/`Event`.
 *
 * `viewSession` is typed `unknown` for the same reason: this module never
 * calls anything on it, it only compares it by reference against
 * `webContents.session` to confirm the error belongs to the browser session
 * (never the app's own local UI session).
 */
export interface CertificateErrorEventLike {
  preventDefault(): void;
}
export interface CertificateErrorWebContentsLike {
  readonly session: unknown;
}
export interface CertificateLike {
  readonly data: string;
}

export type CertificateErrorListener = (
  event: CertificateErrorEventLike,
  webContents: CertificateErrorWebContentsLike,
  url: string,
  error: string,
  certificate: CertificateLike,
  callback: (isTrusted: boolean) => void,
) => void;

export interface CertificateErrorListenerDeps {
  readonly viewSession: unknown;
  readonly store: Pick<CertificateExceptionStore, 'decide'>;
}

/**
 * Builds the `app.on("certificate-error", ...)` listener. Only ever *decides*
 * in the approve direction: `event.preventDefault()` + `callback(true)`.
 *
 * Every rejection path - a non-pane session, or a session whose certificate
 * the store denies - simply returns, touching neither `preventDefault()` nor
 * `callback`. Per Electron's documented contract ("to trust the certificate
 * you should prevent the default behavior with `event.preventDefault()` and
 * call `callback(true)`"), the default behaviour already *is* rejection, so
 * a returned-without-decision error is refused exactly as if this listener
 * did not exist.
 *
 * Calling `callback(false)` instead would be observationally identical for a
 * lone listener, but `certificate-error` is an `app`-global event whose
 * `callback` is one-time: if any *other* listener is also registered (a test
 * harness probing Electron's behaviour, a future feature, a library), both
 * would invoke the same one-time callback and Electron throws
 * `TypeError: One-time callback was called more than once` - an uncaught
 * main-process exception, which surfaces as a modal error dialog and wedges
 * the app. Declining to answer unless we are actually overriding the default
 * removes that footgun entirely.
 */
export function createCertificateErrorListener(
  deps: CertificateErrorListenerDeps,
): CertificateErrorListener {
  return (event, webContents, url, error, certificate, callback) => {
    if (webContents.session !== deps.viewSession) {
      return;
    }
    const decision = deps.store.decide({ url, error, certificatePem: certificate.data });
    if (decision.allow) {
      event.preventDefault();
      callback(true);
    }
  };
}
