import { z } from 'zod';
import { authStatusSchema } from './agent-auth';
import { agentEventSchema, sessionStreamStateSchema, type AgentEvent } from './contracts';
import { chatIdSchema, sdkSessionIdSchema, turnIdSchema } from './contracts';
import { requiredActionSchema, toolErrorCodeSchema } from './contracts';

/**
 * Wire contracts for the `agent-chat:*` IPC surface (implementation-plan.md
 * step 07). Mirrors `browser-ipc.ts`'s placement and shape: request/response
 * DTOs for one IPC surface live directly under `src/shared`, separate from
 * the domain contracts in `src/shared/contracts` (which this file only
 * imports from, never re-declares).
 *
 * Distinct from the `agent:*` sign-in/out surface (`src/shared/agent-auth.ts`).
 * This is the durable surface a renderer chat pane is built against.
 *
 * Main owns exactly one active conversation at a time (`agentService.ts`'s
 * `OpenConversationRequest` doc). `AgentEvent` (reused verbatim, not
 * re-declared - it is already the exact DTO shape this boundary requires)
 * is pushed only for that conversation's current turn; a stale event from an
 * abandoned turn is dropped by `agentChatController.ts` before it ever
 * reaches the `agent-chat:event` channel.
 */

// ---------------------------------------------------------------------------
// Errors / void result
// ---------------------------------------------------------------------------

/**
 * Structurally identical to `src/agent/agentService.ts`'s `AgentServiceError`
 * - same `code`/`message`/`requiredAction` - but independently declared here
 * rather than imported: `src/shared` must not import `src/agent` (only
 * `src/agent/**` may import the Copilot SDK, and shared code must stay
 * usable from the preload/renderer, which never see `src/agent` at all).
 */
export const agentChatErrorSchema = z
  .object({
    code: toolErrorCodeSchema,
    message: z.string().min(1).max(500),
    requiredAction: requiredActionSchema.optional(),
  })
  .strict();

export type AgentChatError = Readonly<z.infer<typeof agentChatErrorSchema>>;

export const agentChatVoidResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: agentChatErrorSchema }).strict(),
]);

export type AgentChatVoidResult = Readonly<z.infer<typeof agentChatVoidResultSchema>>;

export function parseAgentChatVoidResult(candidate: unknown): AgentChatVoidResult {
  return agentChatVoidResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Status (`agent-chat:get-status`)
// ---------------------------------------------------------------------------

/**
 * Whether the application-owned `AgentService` behind this whole surface has
 * finished the (potentially several-seconds-long, real-Copilot-runtime-
 * backed) startup work main kicks off in the background - never on the
 * critical path to the window becoming visible or interactive. `"starting"`
 * is a deliberately distinct value from `AuthStatus.isAuthenticated: false`:
 * before the real `AgentService` exists there is no meaningful answer to
 * "is the user signed in" at all, and reporting a bare `false` for that
 * window would be indistinguishable from "signed out", which is not true -
 * the user may well be signed in and merely a few seconds early. A chat pane
 * must be able to render "connecting to agent..." for `"starting"`,
 * distinct from whatever `auth`/`sessionState` say once `"ready"`.
 */
export const AGENT_SERVICE_LIFECYCLE_STATES = ['starting', 'ready'] as const;

export type AgentServiceLifecycleState = (typeof AGENT_SERVICE_LIFECYCLE_STATES)[number];

export const agentServiceLifecycleStateSchema = z.enum(AGENT_SERVICE_LIFECYCLE_STATES);

/**
 * Enough for a chat pane to render its initial state: sign-in status, which
 * conversation (if any) main currently owns, and that conversation's
 * streaming state. `activeChatId` is `null`, not omitted, when no
 * conversation is open - the app's convention for "there is currently none"
 * is an explicit `null` rather than an optional field. While
 * `serviceState` is `"starting"`, `auth`/`activeChatId`/`sessionState` are
 * placeholder values (no real `AgentService` has been asked yet) - a caller
 * must check `serviceState` first, never infer readiness from those fields.
 */
export const agentChatStatusSchema = z
  .object({
    apiVersion: z.literal(1),
    auth: authStatusSchema,
    activeChatId: chatIdSchema.nullable(),
    sessionState: sessionStreamStateSchema,
    serviceState: agentServiceLifecycleStateSchema,
  })
  .strict();

export type AgentChatStatus = Readonly<z.infer<typeof agentChatStatusSchema>>;

export function parseAgentChatStatus(candidate: unknown): AgentChatStatus {
  return agentChatStatusSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Open conversation (`agent-chat:open-conversation`)
// ---------------------------------------------------------------------------

/** Mirrors `agentService.ts`'s `OpenConversationRequest` field for field. */
export const agentChatOpenConversationRequestSchema = z
  .object({
    chatId: chatIdSchema,
    resume: z.object({ sdkSessionId: sdkSessionIdSchema }).strict().optional(),
  })
  .strict();

export type AgentChatOpenConversationRequest = Readonly<
  z.infer<typeof agentChatOpenConversationRequestSchema>
>;

export function parseAgentChatOpenConversationRequest(
  candidate: unknown,
): AgentChatOpenConversationRequest {
  return agentChatOpenConversationRequestSchema.parse(candidate);
}

export const agentChatOpenResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), chatId: chatIdSchema }).strict(),
  z.object({ ok: z.literal(false), error: agentChatErrorSchema }).strict(),
]);

export type AgentChatOpenResult = Readonly<z.infer<typeof agentChatOpenResultSchema>>;

export function parseAgentChatOpenResult(candidate: unknown): AgentChatOpenResult {
  return agentChatOpenResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Send message (`agent-chat:send-message`)
// ---------------------------------------------------------------------------

/** Generous but bounded: a pasted AEM error log or long question, not an upload channel. */
const PROMPT_MAX_LENGTH = 50_000;

/**
 * `turnId` is not part of this request: unlike `agentService.ts`'s
 * `SendPromptRequest` (whose caller is *this* controller), the renderer must
 * not choose or supply a `TurnId` - `agentChatController.ts` mints it, so
 * only main ever decides what the "current turn" is. The renderer learns the
 * new `turnId` from this call's result, before the first event for it can
 * arrive.
 */
export const agentChatSendMessageRequestSchema = z
  .object({
    chatId: chatIdSchema,
    prompt: z.string().min(1).max(PROMPT_MAX_LENGTH),
  })
  .strict();

export type AgentChatSendMessageRequest = Readonly<
  z.infer<typeof agentChatSendMessageRequestSchema>
>;

export function parseAgentChatSendMessageRequest(candidate: unknown): AgentChatSendMessageRequest {
  return agentChatSendMessageRequestSchema.parse(candidate);
}

export const agentChatSendResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), turnId: turnIdSchema }).strict(),
  z.object({ ok: z.literal(false), error: agentChatErrorSchema }).strict(),
]);

export type AgentChatSendResult = Readonly<z.infer<typeof agentChatSendResultSchema>>;

export function parseAgentChatSendResult(candidate: unknown): AgentChatSendResult {
  return agentChatSendResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Abort / close (`agent-chat:abort`, `agent-chat:close-conversation`)
// ---------------------------------------------------------------------------

export const agentChatByIdRequestSchema = z.object({ chatId: chatIdSchema }).strict();

export type AgentChatByIdRequest = Readonly<z.infer<typeof agentChatByIdRequestSchema>>;

export function parseAgentChatByIdRequest(candidate: unknown): AgentChatByIdRequest {
  return agentChatByIdRequestSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Push channel (`agent-chat:event`)
// ---------------------------------------------------------------------------

/**
 * `AgentEvent` already carries `chatId`/`sequence` and is `.strict()`, so the
 * push channel needs no envelope wrapper here - just a `parseX` using the
 * existing schema. Not re-exported from this module (only imported): the
 * `src/shared` barrel already exports `AgentEvent`/`agentEventSchema` from
 * `contracts/agentEvents.ts`, and re-exporting it a second time here would
 * collide with that in `src/shared/index.ts`.
 */
export function parseAgentChatEvent(candidate: unknown): AgentEvent {
  return agentEventSchema.parse(candidate);
}
