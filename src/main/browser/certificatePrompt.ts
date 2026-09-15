import {
  computeCertificateFingerprintHex,
  decideCertificateTrust,
  type CertificateExceptionRecord,
} from '../aem/certificateExceptions';
import type { CertificateBlockedInfo } from '../../shared/browser-ipc';

/**
 * The TLS-exception-approval flow's *detection* half
 * (implementation-plan.md step 05; requirements-decisions.md section 4: "a
 * human can approve an exception after inspecting the origin and
 * certificate"). The *approval* half (`approveCertificateException`/
 * `revokeCertificateException`) already exists on `AemSession` and is called
 * directly from the browser IPC handler - nothing new is needed there.
 *
 * This module registers a second, purely *observational* `app.on(
 * "certificate-error", ...)` listener alongside the AEM session's own
 * decisive one (`createAemSession`, `certificateExceptions.ts`). It never
 * calls `event.preventDefault()` or the trust `callback` - Electron passes
 * every registered listener the same callback for one event, and only the
 * AEM session's own listener is meant to actually resolve it; this listener
 * exists purely to notice a *denied* certificate and forward enough detail
 * for a human to review it, which is not something the existing decisive
 * listener's job (deciding trust) has any reason to also do.
 *
 * Reusing {@link decideCertificateTrust} (rather than re-deriving "was this
 * denied" from some other signal) means this listener's notion of "blocked"
 * is always in lockstep with the AEM session's actual decision - both read
 * the same `listCertificateExceptions()` snapshot for the same request.
 */
export interface CertificateBlockedEventLike {
  preventDefault(): void;
}
export interface CertificateBlockedWebContentsLike {
  readonly session: unknown;
}
export interface CertificateBlockedCertificateLike {
  readonly data: string;
}

export type CertificateBlockedListener = (
  event: CertificateBlockedEventLike,
  webContents: CertificateBlockedWebContentsLike,
  url: string,
  error: string,
  certificate: CertificateBlockedCertificateLike,
  callback: (isTrusted: boolean) => void,
) => void;

export interface CertificateBlockedListenerDeps {
  readonly aemSession: unknown;
  readonly listExceptions: () => readonly CertificateExceptionRecord[];
  readonly onBlocked: (info: CertificateBlockedInfo) => void;
}

/**
 * Builds the observational listener. Silently ignores anything not on the
 * AEM session, anything the certificate data cannot be fingerprinted from
 * (mirrors the decisive listener's own failure handling - there is nothing
 * meaningful to show a human for an unparseable certificate), and anything
 * already trusted; calls `onBlocked` exactly once per denied request, with
 * exactly the three fields a `TlsException` needs so the renderer's approval
 * prompt and the eventual `browser:approve-certificate-exception` call see
 * identical data.
 */
export function createCertificateBlockedListener(
  deps: CertificateBlockedListenerDeps,
): CertificateBlockedListener {
  return (_event, webContents, url, error, certificate) => {
    if (webContents.session !== deps.aemSession) {
      return;
    }
    const decision = decideCertificateTrust(
      { url, error, certificatePem: certificate.data },
      deps.listExceptions(),
    );
    if (decision.allow) {
      return;
    }
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    let fingerprint: string;
    try {
      fingerprint = computeCertificateFingerprintHex(certificate.data);
    } catch {
      return;
    }
    deps.onBlocked({ origin, certificateSha256Fingerprint: fingerprint, errorClass: error });
  };
}
