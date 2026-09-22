import type { Result } from '../shared';
import type { AgentEvent } from '../shared';
import type { ChatId, SdkSessionId, TurnId } from '../shared';
import type { RequiredAction, ToolErrorCode } from '../shared';
import type { AuthStatus } from '../shared';

/**
 * The application-owned agent boundary (implementation-plan.md step 07:
 * "Expose an application-owned `AgentService` implemented by the SDK adapter
 * and a deterministic fake. Electron IPC calls the service; the UI receives
 * only DTOs.").
 *
 * This interface exists so that neither Electron main nor the renderer ever
 * touches `@github/copilot-sdk` directly. Two implementations satisfy it:
 * a real adapter built on top of `copilotClient.ts`/`toolPolicy.ts` (a later
 * file in `src/agent`), and `fakeAgentService.ts`'s fully deterministic,
 * scriptable fake, used to drive the deterministic E2E suite the plan
 * requires ("Deterministic E2E uses the fake AgentService. A separate manual
 * smoke test with real Copilot proves the live integration. Neither test
 * replaces the other."). Both must be swappable behind this one surface with
 * no caller-visible difference beyond which one happens to be wired up.
 *
 * Every value that crosses this boundary is either a branded id
 * (`src/shared/contracts/ids.ts`), a normalized `AgentEvent`
 * (`src/shared/contracts/agentEvents.ts`), or a small DTO defined in this
 * file - never an SDK type, not even as a type-only import. That is what
 * makes "the UI receives only DTOs" a property the compiler enforces rather
 * than a convention someone has to remember: this file, deliberately, has no
 * import of `@github/copilot-sdk` anywhere in it.
 */

/** Cancels a subscription registered with `onEvent`/`onAuthStateChanged`. */
export type Unsubscribe = () => void;

/**
 * Sign-in status only, per the plan's explicit scope for this DTO ("should
 * describe sign-in status only"). Reused verbatim from
 * `src/shared/agent-auth.ts` rather than re-declared here: `AuthStatus` is
 * already the exact normalized, IPC-safe projection of the SDK's
 * `GetAuthStatusResponse` (see `src/agent/copilotClient.ts`'s `toAuthStatus`,
 * which performs that projection at the SDK boundary, and the current
 * diagnostic IPC handler in `src/main/ipc/agent.ts`, which reuses it).
 * Introducing a second, differently-shaped "auth state" type here would give
 * the adapter two incompatible ideas of what "signed in" means to reconcile
 * at the IPC boundary; aliasing it instead means a projected `AuthStatus`
 * plus a `parseAuthStatus` call is already a complete, schema-validated
 * implementation of `getAuthState()` for the real adapter.
 */
export type AgentAuthState = AuthStatus;

/**
 * An agent-service-level failure.
 *
 * `code` reuses {@link ToolErrorCode} (`src/shared/contracts/errors.ts`)
 * rather than a second, parallel error vocabulary - the plan's instruction
 * for this file is explicit about that. What this type does NOT reuse is
 * `ToolError` itself: every `ToolError` is bound to a `RequestId`
 * ("`One application-issued AEM request, used end to end for correlation`",
 * per `src/shared/contracts/ids.ts`), and a failure at this level - "you
 * already have an open conversation", "a turn is in flight", "Copilot is not
 * signed in" - has no AEM request to correlate against; inventing one only
 * to satisfy `ToolError`'s shape would be a fictitious id serving no actual
 * correlation purpose. `AgentServiceError` is therefore the minimal
 * projection of `ToolError` that still fits this boundary: the same `code`
 * vocabulary, an application-authored `message`, and the same optional
 * `requiredAction` describing what the user would have to do next - just
 * without the field that does not apply here.
 */
export interface AgentServiceError {
  readonly code: ToolErrorCode;
  /** Safe, application-authored text - never raw SDK or remote content (see `ToolError.message`). */
  readonly message: string;
  readonly requiredAction?: RequiredAction;
}

/**
 * Builds an {@link AgentServiceError}, omitting `requiredAction` entirely
 * when not supplied rather than setting it to `undefined` - required under
 * this project's `exactOptionalPropertyTypes: true`, where the two are not
 * interchangeable.
 */
export function createAgentServiceError(
  code: ToolErrorCode,
  message: string,
  requiredAction?: RequiredAction,
): AgentServiceError {
  return requiredAction === undefined ? { code, message } : { code, message, requiredAction };
}

/**
 * Request to open (or re-open) the one conversation this service maintains
 * for `chatId`.
 *
 * ONE-ACTIVE-CONVERSATION RULE (implementation-plan.md step 07: "Maintain one
 * active conversation"): at most one `chatId` is open at a time.
 * - Calling `openConversation` for the chat that is already open is a no-op
 *   success: it does not restart the conversation or emit any events.
 * - Calling `openConversation` for a *different* `chatId` while one is open
 *   implicitly tears down the previous one first - aborting its in-flight
 *   turn if it has one (the same path `abort()` takes) and then closing it -
 *   before the new conversation opens. This mirrors
 *   requirements-decisions.md's own description of the equivalent UI action
 *   ("Selecting another chat/server or New chat stops the current response
 *   and cancels application-side AEM requests"): switching conversations is
 *   defined to cancel, not to fail. A caller that wants the previous
 *   conversation's turn to run to completion first must not call
 *   `openConversation` again until it does.
 */
export interface OpenConversationRequest {
  readonly chatId: ChatId;
  /**
   * When present, resume the SDK session this chat was previously backed by
   * (persisted as `ChatMetadata.sdkSessionId`) instead of starting a fresh
   * one. Absent for a chat that has never had an SDK session.
   */
  readonly resume?: { readonly sdkSessionId: SdkSessionId };
}

/**
 * Request to send one prompt on the currently open conversation.
 *
 * `turnId` is minted by the caller (main), not by this service, and supplied
 * up front rather than returned once the turn starts: every `AgentEvent`
 * this service emits for the resulting turn - starting with the very first
 * one - already carries `turnId`, so whoever is about to start listening for
 * those events needs the id before the first event can arrive, not after.
 * Compare `src/shared/contracts/ids.ts`'s `IdGenerator` pattern, which puts
 * minting under the caller's control for exactly this kind of
 * before-the-fact correlation need.
 */
export interface SendPromptRequest {
  readonly chatId: ChatId;
  readonly turnId: TurnId;
  readonly prompt: string;
  /**
   * The text to show in the conversation timeline in place of `prompt`, when
   * the application prepends context (the current AEM page) the user did not
   * type. `prompt` is always what the model reads; `displayPrompt` only
   * affects what the SDK records/shows as the user's own message. Omitted when
   * the two are identical.
   */
  readonly displayPrompt?: string;
}

export interface AgentService {
  /**
   * Prepares the service for use (starting the underlying runtime for a real
   * adapter; a no-op success for the fake). Must be called, and must
   * succeed, before any other method is used.
   */
  initialize(): Promise<Result<void, AgentServiceError>>;

  /** The most recently known sign-in status. Never blocks on the network. */
  getAuthState(): AgentAuthState;

  /**
   * The SDK session id backing the currently open conversation, or `undefined`
   * when no conversation is open. Read after a successful `openConversation` to
   * correlate the application's own `ChatId` with the SDK's session - the chat
   * journal records it in its header (implementation-plan.md step 09). Never
   * blocks.
   */
  getOpenSessionId(): SdkSessionId | undefined;

  /** Notifies `listener` on every subsequent change to `getAuthState()`. */
  onAuthStateChanged(listener: (state: AgentAuthState) => void): Unsubscribe;

  /**
   * Notifies `listener` of every normalized `AgentEvent` this service
   * produces, for every conversation it has ever opened (there is at most
   * one open at a time - see {@link OpenConversationRequest} - but events for
   * a conversation being torn down by an implicit `openConversation`
   * replacement, or by `closeConversation`, still arrive here before that
   * conversation's own final `session.state.changed` "closed" event).
   */
  onEvent(listener: (event: AgentEvent) => void): Unsubscribe;

  /** Opens the conversation for `request.chatId`. See {@link OpenConversationRequest}. */
  openConversation(request: OpenConversationRequest): Promise<Result<ChatId, AgentServiceError>>;

  /**
   * Sends one prompt on the currently open conversation. Refused (not
   * queued) if `request.chatId` is not the currently open conversation, if
   * the user is not signed in, or if a previous turn on this conversation
   * has not yet reached `idle` - "Do not send a second prompt over an
   * unfinished turn" (implementation-plan.md step 07) is enforced here, not
   * left to the caller to remember.
   */
  sendPrompt(request: SendPromptRequest): Promise<Result<void, AgentServiceError>>;

  /**
   * Cancels the in-flight turn on `chatId`, if any, and returns it to
   * `idle`. A no-op success if `chatId` is the open conversation but has no
   * turn in flight. Refused if `chatId` is not the currently open
   * conversation.
   */
  abort(chatId: ChatId): Promise<Result<void, AgentServiceError>>;

  /**
   * Aborts any in-flight turn on `chatId` (per `abort()`) and then closes
   * it. Refused if `chatId` is not the currently open conversation - closing
   * a conversation that already is not open is not this method's job to
   * silently ignore, since it usually indicates the caller's own bookkeeping
   * has drifted from this service's.
   */
  closeConversation(chatId: ChatId): Promise<Result<void, AgentServiceError>>;

  /**
   * Releases everything this service owns (open conversation, subscriptions,
   * underlying runtime). The service must not be used afterward.
   */
  dispose(): Promise<void>;
}
