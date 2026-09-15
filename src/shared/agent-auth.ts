import { z } from 'zod';

/**
 * Runtime schema for `agent.getAuthStatus()` / the `session.error`-free path of
 * `agent.login()`. Mirrors the safe, non-secret subset of the SDK's
 * `GetAuthStatusResponse` (see `src/agent/copilotClient.ts`): a login name and
 * host are account identifiers, never a credential, and are safe to display
 * and to cross the IPC boundary.
 */
export const authStatusSchema = z.object({
  apiVersion: z.literal(1),
  isAuthenticated: z.boolean(),
  authType: z.string().optional(),
  host: z.string().optional(),
  login: z.string().optional(),
  statusMessage: z.string().optional(),
});

export type AuthStatus = z.infer<typeof authStatusSchema>;

export function parseAuthStatus(candidate: unknown): AuthStatus {
  return authStatusSchema.parse(candidate);
}

/**
 * Outcome of a `copilot login --web-flow` attempt. `failed.message` is a
 * process exit message (stderr/stdout tail or spawn error) - never a token,
 * since the token is exchanged directly between the CLI and GitHub and is
 * never printed to stdout/stderr by the CLI's web flow.
 */
export const loginOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success') }),
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('failed'), message: z.string() }),
]);

export type LoginOutcome = z.infer<typeof loginOutcomeSchema>;

export function parseLoginOutcome(candidate: unknown): LoginOutcome {
  return loginOutcomeSchema.parse(candidate);
}

/**
 * Result of the app's local sign-out (see `src/agent/auth.ts` for why this is
 * not a full vault-credential logout). `warning` is always populated so the
 * UI can surface the blast-radius caveat verbatim instead of re-deriving it.
 */
export const logoutResultSchema = z.object({
  apiVersion: z.literal(1),
  warning: z.string(),
});

export type LogoutResult = z.infer<typeof logoutResultSchema>;

export function parseLogoutResult(candidate: unknown): LogoutResult {
  return logoutResultSchema.parse(candidate);
}
