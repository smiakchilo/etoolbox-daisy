import { z } from 'zod';
import { agentIdSchema } from './contracts';

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
 * A cheap, *non-starting* sign-in presence probe, distinct from
 * {@link AuthStatus}.
 *
 * {@link AuthStatus} is the full, live status and, for Copilot, is obtained
 * by starting its runtime child process. That is too heavy to answer "could
 * this provider serve if I switched to it?" for a provider that is not active
 * - the Settings Agents tab needs that answer to gate its "Set active"
 * control without spawning a runtime the user may never use.
 *
 * `present` therefore means only "a sign-in artifact is known to exist":
 * for Copilot, the app-owned `COPILOT_HOME` records a logged-in account; for a
 * token provider, a token is stored. It is deliberately coarse - a stale
 * pointer is possible - and is never shown as a signed-in status; it only
 * decides whether activation is offered. The active provider's precise state
 * still comes from {@link AuthStatus}.
 */
export const authPresenceSchema = z.object({ present: z.boolean() }).strict();

export type AuthPresence = z.infer<typeof authPresenceSchema>;

export function parseAuthPresence(candidate: unknown): AuthPresence {
  return authPresenceSchema.parse(candidate);
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
 * A progress note pushed while a sign-in is being prepared - today, while the
 * Copilot CLI add-on downloads on first use. `text` is a short human-readable
 * phrase the Agents tab shows in place of the provider's sign-in status.
 */
export const agentAuthProgressSchema = z
  .object({
    agentId: agentIdSchema,
    text: z.string().min(1).max(200),
  })
  .strict();

export type AgentAuthProgress = z.infer<typeof agentAuthProgressSchema>;

export function parseAgentAuthProgress(candidate: unknown): AgentAuthProgress {
  return agentAuthProgressSchema.parse(candidate);
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

/**
 * The request every `agent:*` auth channel takes. Auth is per agent: the
 * channel does not assume there is only one provider, and an id the registry
 * does not know is answered as "no such agent" rather than routed anywhere.
 */
export const agentAuthRequestSchema = z.object({ agentId: agentIdSchema }).strict();

export type AgentAuthRequest = z.infer<typeof agentAuthRequestSchema>;

export function parseAgentAuthRequest(candidate: unknown): AgentAuthRequest {
  return agentAuthRequestSchema.parse(candidate);
}
