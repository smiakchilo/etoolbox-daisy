import type { AppSettingsSnapshot, SettingsIpcError } from '../../../shared';

/**
 * Outcome of loading the settings snapshot for display. Distinct from
 * `GetSettingsSnapshotResult` only in that a thrown/rejected IPC call (e.g.
 * the preload's Zod validation failing on a malformed response) is folded
 * into the same shape instead of being a second failure mode the UI has to
 * handle separately.
 */
export type SettingsSnapshotLoad =
  | { readonly ok: true; readonly snapshot: AppSettingsSnapshot }
  | { readonly ok: false; readonly error: SettingsIpcError };

/**
 * Loads the current settings snapshot through `window.daisy.settings`
 * (implementation-plan.md step 04/05). Both the main-window shell (server
 * selector, insecure marker) and the Settings window read through this one
 * function so a transport failure is reported identically in both places.
 */
export async function loadSettingsSnapshot(): Promise<SettingsSnapshotLoad> {
  try {
    const result = await window.daisy.settings.getSnapshot();
    if (result.ok) {
      return { ok: true, snapshot: result.snapshot };
    }
    return { ok: false, error: result.error };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'storage_error',
        message: error instanceof Error ? error.message : 'failed to load settings',
      },
    };
  }
}
