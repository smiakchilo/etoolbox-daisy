import type { AuthPresence, AuthStatus } from '../../shared';

/**
 * OpenRouter's authentication is a single API key: there is no interactive
 * flow, so the sign-in status is a pure projection of whether a key is stored.
 * A key is never validated here (the app deliberately does not call the
 * provider to check credentials); the first real request reports a bad key.
 */

/** True when `token` is a non-empty key. The secret store may yield `''`. */
function hasKey(token: string | undefined): boolean {
  return token !== undefined && token !== '';
}

export function authStatusFromToken(token: string | undefined): AuthStatus {
  return hasKey(token)
    ? { apiVersion: 1, isAuthenticated: true, authType: 'token' }
    : { apiVersion: 1, isAuthenticated: false, statusMessage: 'No API key is set.' };
}

export function authPresenceFromToken(token: string | undefined): AuthPresence {
  return { present: hasKey(token) };
}
