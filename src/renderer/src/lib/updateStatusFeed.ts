import type { UpdateStatus } from '../../../shared';

/**
 * The renderer's one way to follow the updater's status: main's push channel
 * plus a local injection point, so the dev-only `!!update` preview
 * (`dev/updatePreview.ts`) can drive every consumer - the chat notice, the Home
 * link and the Settings tab - without a real update. Production code never
 * calls `injectUpdateStatus`.
 *
 * Every delivery also says **where the status came from**, because the same
 * "an update is available" answer must be announced differently: a check the
 * reader ran themselves is answered where they ran it (the Settings tab's own
 * status line, and the Update button beside it), so it must not also raise the
 * chat pane's notice. Only a check nobody asked for - the opt-in startup one -
 * is allowed to raise that fallback notice. The user-run check is marked by the
 * Settings section before it calls `updates.check()`, and the flag is claimed by
 * the check's outcome, so an `available`/`upToDate`/`failed` push that follows it
 * is attributed to the reader rather than to the startup timer.
 */

/** Where one delivered status came from. */
export type UpdateStatusOrigin =
  /** Main reported it on its own (the opt-in startup check, an apply's progress). */
  | 'automatic'
  /** The outcome of a check the reader started from Settings. */
  | 'user'
  /** Injected by the dev-only `!!update` preview. */
  | 'preview';

type Listener = (status: UpdateStatus, origin: UpdateStatusOrigin) => void;

const listeners = new Set<Listener>();

/**
 * Set by the Settings section just before it asks main to check, so the check's
 * outcome is not mistaken for the startup timer's. Single-flight with main's own
 * `busy` guard: only the next terminal check status claims it.
 */
let userCheckInFlight = false;

/** The statuses that end a check - one of these is the outcome the flag belongs to. */
function isCheckOutcome(status: UpdateStatus): boolean {
  return status.kind === 'available' || status.kind === 'upToDate' || status.kind === 'failed';
}

function deliver(status: UpdateStatus, origin: UpdateStatusOrigin): void {
  for (const listener of [...listeners]) listener(status, origin);
}

/** Subscribes to main's status pushes and to injected ones; returns the unsubscribe. */
export function subscribeUpdateStatus(listener: Listener): () => void {
  listeners.add(listener);
  const unsubscribeMain = window.daisy.updates.onStatusChanged((status) => {
    const origin: UpdateStatusOrigin =
      userCheckInFlight && isCheckOutcome(status) ? 'user' : 'automatic';
    if (origin === 'user') userCheckInFlight = false;
    deliver(status, origin);
  });
  return () => {
    listeners.delete(listener);
    unsubscribeMain();
  };
}

/**
 * Marks the check the caller is about to start as the reader's own, so its
 * outcome raises no chat notice. Called by the Settings tab's **Check for
 * updates** button only.
 */
export function markUserRequestedUpdateCheck(): void {
  userCheckInFlight = true;
}

/** Delivers `status` to every subscriber as if main had pushed it (the dev preview). */
export function injectUpdateStatus(status: UpdateStatus): void {
  deliver(status, 'preview');
}

export interface UpdateNoticeDecision {
  readonly origin: UpdateStatusOrigin;
  /**
   * True while a blue **Update** button is already on screen - the Home
   * screen's, or the Settings Updates tab's.
   */
  readonly offerOnScreen: boolean;
}

/**
 * Whether a newly available update should raise the chat pane's fallback
 * notice. It exists for exactly one case: an automatic check found an update
 * while nothing on screen offered to install it. A check the reader ran is
 * answered where they ran it, and a visible Update button is the offer itself -
 * a second notification beside it is noise.
 */
export function shouldAnnounceUpdate(decision: UpdateNoticeDecision): boolean {
  return decision.origin !== 'user' && !decision.offerOnScreen;
}
