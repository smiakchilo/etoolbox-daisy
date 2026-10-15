import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AuthPresence } from '../../shared';

/**
 * A cheap, *non-starting* sign-in presence probe for Copilot.
 *
 * The runtime's real `getAuthStatus()` starts `copilot-runtime.exe` (the SDK
 * client resolves its account inside the child process). That is far too heavy
 * for the Settings Agents tab, which needs only to decide whether an
 * *inactive* Copilot item may be activated - and must not spawn a runtime the
 * user may never use. This reads the app-owned `COPILOT_HOME/config.json`
 * pointer instead, the exact file the CLI's web-flow login writes and
 * `auth.ts`'s `localSignOut` deletes, so presence tracks the app's own session
 * without touching the vault or the runtime.
 *
 * Deliberately coarse: it reports that a session *pointer* exists, not that
 * the credential behind it still does (another installation could have removed
 * the shared vault entry). That is acceptable because it only gates a
 * control; the precise, authoritative answer still comes from
 * `getAuthStatus()` once the provider is active. It never throws - an
 * unreadable or absent file is simply "no session" - so it is safe on the
 * Settings refresh path.
 */
export async function getCopilotAuthPresence(copilotHomeDir: string): Promise<AuthPresence> {
  try {
    const raw = await readFile(path.join(copilotHomeDir, 'config.json'), 'utf8');
    return { present: hasLoggedInUser(JSON.parse(raw)) };
  } catch {
    // Missing file, unreadable file, or invalid JSON all mean "no session".
    return { present: false };
  }
}

/**
 * Whether a parsed `config.json` names a logged-in account. The CLI writes
 * `lastLoggedInUser` (and/or a `loggedInUsers` collection); either form is
 * accepted, and a token/plaintext scan is deliberately *not* performed here -
 * `auth.ts`'s `assertNoPlaintextCredentials` owns that, at login time.
 */
function hasLoggedInUser(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as Record<string, unknown>;
  const lastLoggedInUser = node['lastLoggedInUser'];
  if (typeof lastLoggedInUser === 'string' && lastLoggedInUser.trim() !== '') return true;
  const loggedInUsers = node['loggedInUsers'];
  return Array.isArray(loggedInUsers) && loggedInUsers.length > 0;
}
