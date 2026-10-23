import { ipcMain } from 'electron';
import { CREDENTIALS_CAPTURED_CHANNEL, credentialCaptureSchema } from '../../shared';
import { toLoggableUrl, type Logger } from '../logger';
import type { CredentialVault } from './credentialVault';

/**
 * The main half of capture: a submitted sign-in form, reported by the pane's
 * preload, becomes a remembered credential for **the frame's own origin**.
 *
 * Nothing in the payload names an origin, and none is accepted from it even if
 * a future version of the payload offered one: `event.senderFrame.url` is the
 * document that submitted the form, which the page cannot forge. Only a
 * top-level http(s) frame is eligible - a subframe (an embedded widget, an
 * iframe identity provider) is ignored rather than attributed to the page
 * around it.
 *
 * The decision itself is pure ({@link decideCredentialCapture}) and has its own
 * tests; this module is the thin Electron wiring around it, including the
 * dedupe/validation logging. A rejected capture is silent on the page's side:
 * the user's submission already completed, so there is nothing to report to
 * them, and a log line here is the diagnostic.
 */
export interface CaptureFrame {
  readonly url: string;
  readonly isMainFrame: boolean;
}

export type CaptureDecision =
  | {
      readonly kind: 'store';
      readonly origin: string;
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly kind: 'ignore';
      readonly reason: 'not_main_frame' | 'not_http' | 'invalid_payload' | 'no_username';
    };

/**
 * Classifies one `credentials:captured` message. `latestUsernameFor` supplies
 * the origin's most recent username for the identity-provider password step
 * that keeps the name in page state rather than a field.
 */
export function decideCredentialCapture(
  frame: CaptureFrame | undefined,
  payload: unknown,
  latestUsernameFor: (origin: string) => string | undefined,
): CaptureDecision {
  if (frame === undefined || !frame.isMainFrame) {
    return { kind: 'ignore', reason: 'not_main_frame' };
  }
  let origin: string;
  try {
    const parsed = new URL(frame.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { kind: 'ignore', reason: 'not_http' };
    }
    origin = parsed.origin;
  } catch {
    return { kind: 'ignore', reason: 'not_http' };
  }
  const capture = credentialCaptureSchema.safeParse(payload);
  if (!capture.success) return { kind: 'ignore', reason: 'invalid_payload' };
  const username = capture.data.username.trim() || latestUsernameFor(origin) || '';
  if (username.length === 0) return { kind: 'ignore', reason: 'no_username' };
  return { kind: 'store', origin, username, password: capture.data.password };
}

export interface CredentialCaptureDeps {
  readonly vault: Pick<CredentialVault, 'record' | 'latestUsername'>;
  readonly logger: Logger;
}

/** Registers the one-way `credentials:captured` listener. */
export function registerCredentialCaptureIpc(deps: CredentialCaptureDeps): void {
  ipcMain.on(CREDENTIALS_CAPTURED_CHANNEL, (event, payload: unknown) => {
    const frame = event.senderFrame;
    const decision = decideCredentialCapture(
      frame === null ? undefined : { url: frame.url, isMainFrame: frame.top === frame },
      payload,
      (origin) => deps.vault.latestUsername(origin),
    );
    if (decision.kind === 'ignore') {
      if (decision.reason !== 'not_main_frame') {
        deps.logger.warn('CREDENTIAL_CAPTURE_IGNORED', { count: 1 });
      }
      return;
    }
    void deps.vault
      .record({
        origin: decision.origin,
        username: decision.username,
        password: decision.password,
      })
      .then(() => {
        deps.logger.info('CREDENTIAL_CAPTURED', { url: toLoggableUrl(`${decision.origin}/`) });
      })
      .catch(() => {
        // Secure storage unavailable, or a failed index write: the sign-in the
        // user just performed still stands, it simply will not be remembered.
        deps.logger.warn('CREDENTIAL_STORE_FAILED', { count: 1 });
      });
  });
}
