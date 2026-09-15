import { z } from 'zod';
import { chatIdSchema, sdkSessionIdSchema, serverIdSchema } from './ids';
import { isStaleRevision, serverRevisionSchema } from './serverConfig';
import { modelIdSchema, reasoningEffortSchema } from './appSettings';

/**
 * Metadata for one chat (implementation-plan.md step 03,
 * requirements-decisions.md section 7).
 *
 * A chat is bound to exactly one server for its whole life: "different
 * servers do not share one Copilot conversation context", and switching
 * servers opens or creates *that server's* chat rather than moving the
 * current one. `serverId` is therefore `readonly` and this module exports no
 * "rebind" operation - there is deliberately no supported way to produce a
 * `ChatMetadata` with a changed `serverId` short of constructing a new chat.
 */

const CHAT_TITLE_MAX_LENGTH = 200;

/** Bounded, and allowed to be absent so the UI can auto-derive one. */
export const chatTitleSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(CHAT_TITLE_MAX_LENGTH, `must be at most ${String(CHAT_TITLE_MAX_LENGTH)} characters`);

/**
 * Epoch milliseconds rather than an ISO-8601 string. An ISO string round-trips
 * through JSON as a plain string, which invites ad-hoc re-parsing (and
 * re-validating timezone/format edge cases) at every read site; a number that
 * is validated once, here, stays a number everywhere it is used.
 */
export const epochMillisecondsSchema = z.number().int().nonnegative();

/**
 * The plan's step 03 also lists a separate `idle/sending/streaming/...`
 * vocabulary, but that describes the *runtime* state machine of an active
 * session (owned by `sessionState.ts`), not the lifecycle of a persisted chat
 * history entry.
 *
 * `active`/`closed` follows requirements-decisions.md section 7: the one chat
 * currently open for a server, versus every other chat retained in history.
 * "Currently open for a server" is also derivable independently, from
 * `AppSettings`/window state pointing at a `chatId` - so `status` is *not*
 * the source of truth for that fact, only a record of whether a chat has
 * been closed by the user. If the two ever disagreed (e.g. after a crash),
 * the pointer in settings/window state wins for "what to show as open now";
 * `status` here is not re-derived from it, to keep this module free of a
 * dependency on `appSettings.ts`'s runtime pointer.
 *
 * `deletionPending`/`deletionFailed` exist because chat deletion spans
 * multiple stores (SDK session, on-disk history, proxy secrets) and is not
 * atomic: implementation-plan.md lines 481-483 requires the deletion
 * operation itself to be recorded and resumed idempotently, and to "report
 * pending/error status for partial failure instead of declaring the data
 * permanently gone". Line 468 similarly forbids showing success for an
 * unfinished deletion. Persisting these as chat statuses (rather than, say,
 * an in-memory-only deletion queue) is what lets that recovery survive an
 * application restart.
 */
export const CHAT_STATUSES = ['active', 'closed', 'deletionPending', 'deletionFailed'] as const;

export type ChatStatus = (typeof CHAT_STATUSES)[number];

export const chatStatusSchema = z.enum(CHAT_STATUSES);

export const chatMetadataSchema = z
  .object({
    chatId: chatIdSchema,
    sdkSessionId: sdkSessionIdSchema,
    serverId: serverIdSchema,
    startedAt: epochMillisecondsSchema,
    title: chatTitleSchema.optional(),
    model: modelIdSchema,
    reasoningEffort: reasoningEffortSchema,
    lastKnownServerRevision: serverRevisionSchema,
    status: chatStatusSchema,
  })
  .strict();

export type ChatMetadata = Readonly<z.infer<typeof chatMetadataSchema>>;

/**
 * True when the server's configuration has moved on since this chat last
 * observed it - for example because the server's origin or proxy changed
 * (`ServerConfig.revision` was bumped) after this chat started or last sent a
 * message.
 *
 * Note this is deliberately *not* the same predicate used to invalidate an
 * in-flight tool call, even though both are called "staleness". This delegates
 * to {@link isStaleRevision}, which is asymmetric (`observed < current`) and
 * documents that observing a revision *greater* than the current one is not
 * staleness. An in-flight tool call instead goes through `classifyStaleness`
 * in `toolContracts.ts`, which compares `serverRevision` and `navigationEpoch`
 * with a symmetric `!==`.
 *
 * The difference is intended, because the two answer different questions:
 *
 * - Here the question is advisory and directional - "has configuration moved
 *   on since this persisted chat last saw it?" - used to decide whether the
 *   chat needs to re-observe the server before it is used again. A chat whose
 *   `lastKnownServerRevision` somehow runs ahead of the live config is not a
 *   chat holding out-of-date targeting, so reporting it as stale would be
 *   meaningless for this purpose.
 * - `classifyStaleness` is a safety gate - "does this result still describe
 *   the world the request was issued against?" A result is only usable if the
 *   targeting matches *exactly*, so any difference at all invalidates it. An
 *   unexpected decrease there is not benign: it means the revision counter
 *   moved backwards (restored storage, a reset counter, a different server
 *   object reusing revision numbers), and handing the model a result gathered
 *   under unknown targeting is precisely the failure the check exists to stop.
 *
 * If these two ever need to agree, change them together and deliberately -
 * do not assume one is a thin wrapper over the other.
 */
export function isChatServerRevisionStale(
  chat: ChatMetadata,
  currentServerRevision: number,
): boolean {
  return isStaleRevision(chat.lastKnownServerRevision, currentServerRevision);
}
