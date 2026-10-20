import type { UpdateStatus } from '../../../shared';

/**
 * The renderer's one way to follow the updater's status: main's push channel
 * plus a local injection point, so the dev-only `!!update` preview
 * (`dev/updatePreview.ts`) can drive every consumer - the chat notice, the Home
 * link and the Settings tab - without a real update. Production code never
 * calls `injectUpdateStatus`.
 */

type Listener = (status: UpdateStatus) => void;

const listeners = new Set<Listener>();

/** Subscribes to main's status pushes and to injected ones; returns the unsubscribe. */
export function subscribeUpdateStatus(listener: Listener): () => void {
  listeners.add(listener);
  const unsubscribeMain = window.daisy.updates.onStatusChanged(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeMain();
  };
}

/** Delivers `status` to every subscriber as if main had pushed it. */
export function injectUpdateStatus(status: UpdateStatus): void {
  for (const listener of [...listeners]) listener(status);
}
