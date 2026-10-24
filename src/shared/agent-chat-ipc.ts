import { z } from 'zod';
import { authStatusSchema } from './agent-auth';
import {
  type AgentEvent,
  agentEventSchema,
  chatIdSchema,
  chatJournalRecordSchema,
  chatTitleSchema,
  epochMillisecondsSchema,
  requiredActionSchema,
  sessionIdSchema,
  serverIdSchema,
  sessionStreamStateSchema,
  toolErrorCodeSchema,
  turnIdSchema,
  userInputAnswerSchema,
  userInputRequestIdSchema,
} from './contracts';

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
 *
 * `"unavailable"` is terminal for the current build/settings: no agent exists
 * to serve the chat (every agent folder removed or disabled, or the configured
 * one failed to load). It is not "starting" - waiting will not change it - so
 * the pane says so instead of showing "connecting".
 */
export const AGENT_SERVICE_LIFECYCLE_STATES = ['starting', 'ready', 'unavailable'] as const;

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
    /**
     * The SDK session id backing `activeChatId`, or `null` when no
     * conversation is open. Exposed so a caller can persist it for a later
     * genuine resume (the chat journal's header also records it, but only at
     * chat creation - a runtime recycle mints a new session for the same
     * `chatId`, so this live value is the authoritative one).
     */
    sessionId: sessionIdSchema.nullable(),
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
    resume: z.object({ sessionId: sessionIdSchema }).strict().optional(),
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

/** Generous but bounded: a pasted error log or long question, not an upload channel. */
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
// Respond to an interactive question (`agent-chat:respond-to-input`)
// ---------------------------------------------------------------------------

/**
 * Delivers the user's answer to the outstanding ask-user question
 * (`user.input.requested`) identified by `requestId`, so the blocked turn can
 * continue. Main refuses an answer whose `requestId` names no pending question
 * on `chatId` - a stale answer must never resolve a different question.
 */
export const agentChatRespondToInputRequestSchema = z
  .object({
    chatId: chatIdSchema,
    requestId: userInputRequestIdSchema,
    answer: userInputAnswerSchema,
  })
  .strict();

export type AgentChatRespondToInputRequest = Readonly<
  z.infer<typeof agentChatRespondToInputRequestSchema>
>;

export function parseAgentChatRespondToInputRequest(
  candidate: unknown,
): AgentChatRespondToInputRequest {
  return agentChatRespondToInputRequestSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Read journal (`agent-chat:read-journal`)
// ---------------------------------------------------------------------------

/**
 * Reads one chat's append-only journal (`contracts/chatJournal.ts`) so a
 * renderer can repaint a resumed conversation's transcript. The journal is the
 * UI projection of a chat, deliberately separate from the SDK session that
 * `resume` restores; a caller that resumes a chat reads this to show what was
 * said, not to reconstruct the model's context.
 */
export const agentChatReadJournalRequestSchema = z.object({ chatId: chatIdSchema }).strict();

export type AgentChatReadJournalRequest = Readonly<
  z.infer<typeof agentChatReadJournalRequestSchema>
>;

export function parseAgentChatReadJournalRequest(candidate: unknown): AgentChatReadJournalRequest {
  return agentChatReadJournalRequestSchema.parse(candidate);
}

export const agentChatReadJournalResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), records: z.array(chatJournalRecordSchema) }).strict(),
  z.object({ ok: z.literal(false), error: agentChatErrorSchema }).strict(),
]);

export type AgentChatReadJournalResult = Readonly<z.infer<typeof agentChatReadJournalResultSchema>>;

export function parseAgentChatReadJournalResult(candidate: unknown): AgentChatReadJournalResult {
  return agentChatReadJournalResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Conversation history (`agent-chat:list-conversations`, `agent-chat:delete-conversation`)
// ---------------------------------------------------------------------------

/**
 * The `agent-chat:list-conversations` request. A first request carries nothing
 * (or `{}`); a continuation carries the opaque `next` cursor the previous
 * result returned. Main reads the chats directory's journals one small page at
 * a time, so a large or slow history still paints its first rows while the
 * rest loads (the panel shows a blank screen otherwise).
 */
export const agentChatListConversationsRequestSchema = z
  .object({ next: z.string().optional() })
  .strict();

export type AgentChatListConversationsRequest = Readonly<
  z.infer<typeof agentChatListConversationsRequestSchema>
>;

export function parseAgentChatListConversationsRequest(
  candidate: unknown,
): AgentChatListConversationsRequest {
  return agentChatListConversationsRequestSchema.parse(candidate);
}

/**
 * One entry in the chat history list, derived on demand from a chat's journal
 * (`chatJournal.ts`) rather than from a second metadata store. `title` is the
 * beginning of the first user message - produced without a model request - and
 * is absent for a chat whose journal holds no user prompt. `startedAt` and
 * `updatedAt` are epoch milliseconds; `updatedAt` is the newest record's time,
 * so the list can order by "most recently used". `sessionId` is the session
 * the journal's header recorded, offered so a caller can attempt a genuine
 * resume (a runtime recycle minted a later session the journal does not keep,
 * so this may be stale - the resume falls back to a fresh session).
 */
export const agentChatHistoryEntrySchema = z
  .object({
    chatId: chatIdSchema,
    title: chatTitleSchema.optional(),
    startedAt: epochMillisecondsSchema,
    updatedAt: epochMillisecondsSchema,
    serverId: serverIdSchema.optional(),
    sessionId: sessionIdSchema.optional(),
  })
  .strict();

export type AgentChatHistoryEntry = Readonly<z.infer<typeof agentChatHistoryEntrySchema>>;

export function parseAgentChatHistoryEntry(candidate: unknown): AgentChatHistoryEntry {
  return agentChatHistoryEntrySchema.parse(candidate);
}

/**
 * One page of the history list. `next` is present only while more pages
 * remain (main's cursor into its scan of the chats directory): a first request
 * without `next` starts a fresh scan; passing a result's `next` continues it.
 */
export const agentChatHistoryListResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      entries: z.array(agentChatHistoryEntrySchema),
      next: z.string().optional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: agentChatErrorSchema }).strict(),
]);

export type AgentChatHistoryListResult = Readonly<z.infer<typeof agentChatHistoryListResultSchema>>;

export function parseAgentChatHistoryListResult(candidate: unknown): AgentChatHistoryListResult {
  return agentChatHistoryListResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Skill catalogue (`agent-chat:list-skills`)
// ---------------------------------------------------------------------------

/**
 * One bundled skill reduced to what the composer's `/` autocomplete needs: the
 * name it is invoked by and the description shown beside it. Main reads these
 * from the application's own `resources/skills/<name>/SKILL.md` front matter and
 * never sends a skill's body - the renderer only ever re-emits the name in a
 * prompt, and the model loads the body through the runtime's `skill` tool.
 * `tableOnly` (present only when true) tells the transcript that the skill's
 * answer is one application-rendered table, so the model's prose is suppressed.
 */
export const agentChatSkillSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(4000),
    tableOnly: z.boolean().optional(),
  })
  .strict();

export type AgentChatSkill = Readonly<z.infer<typeof agentChatSkillSchema>>;

export const agentChatSkillsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), skills: z.array(agentChatSkillSchema) }).strict(),
  z.object({ ok: z.literal(false), error: agentChatErrorSchema }).strict(),
]);

export type AgentChatSkillsResult = Readonly<z.infer<typeof agentChatSkillsResultSchema>>;

export function parseAgentChatSkillsResult(candidate: unknown): AgentChatSkillsResult {
  return agentChatSkillsResultSchema.parse(candidate);
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
