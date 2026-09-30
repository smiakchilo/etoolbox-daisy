import os from 'node:os';
import path from 'node:path';

/**
 * Root of the app-owned `etoolbox-daisy` directory under the current user's
 * home (docs/requirements-decisions.md section 8). Only the `copilot-home`
 * subdirectory is needed by this step; the rest of the layout (settings,
 * history, browser data) is built out in step 04's storage module, which
 * should reuse this same root rather than inventing a second one.
 */
export function getAppDataRoot(): string {
  return path.join(os.homedir(), 'etoolbox-daisy');
}

/**
 * App-owned `COPILOT_HOME`. Isolated from the user's personal `~/.copilot` so
 * this app's Copilot session state, config, and active-account pointer never
 * mix with another Copilot installation's data (see
 * docs/requirements-decisions.md section 5 and the logout blast-radius notes
 * in `src/agent/auth.ts`).
 */
export function getCopilotHomeDir(): string {
  return path.join(getAppDataRoot(), 'copilot-home');
}
