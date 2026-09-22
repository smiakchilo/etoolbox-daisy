import { z } from 'zod';
import { chatIdSchema, requestIdSchema, serverIdSchema, turnIdSchema } from '../../contracts';
import type { ChatId, RequestId, ServerId, TurnId } from '../../contracts';

/**
 * Generic request-envelope and deadline/staleness contracts shared by every
 * agent tool.
 *
 * Everything in here is tool-agnostic. Per-tool argument schemas and the
 * discriminated envelope union live with the tool that owns them
 * (`../aemGetJson.ts`, `../aemQuery.ts`), and the union is assembled in the
 * registry (`../index.ts`) so adding a tool never edits this file.
 */

/**
 * Total budget for one AEM request, end to end, per requirements-decisions.md
 * section 6.
 */
export const AEM_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Supplies the current time as epoch milliseconds. Kept as an injected
 * function rather than a call to `Date.now()` so deadline arithmetic stays
 * deterministic under test and so `src/shared` never reaches for an ambient
 * global (there is no `Date` ban here, only a project-wide preference for
 * testability - the same pattern as id generation in `../../contracts/ids`).
 */
export type Clock = () => number;

/**
 * The envelope's deadline is an absolute timestamp, not a duration. A
 * duration would restart at every hop the request passes through, so a chain
 * of hops could each individually stay "within timeout" while the overall wait
 * for the agent's answer blew past the intended 90 seconds. Computing the
 * deadline once, here, against a single clock reading is what makes
 * "90 seconds total" actually mean 90 seconds total.
 */
export function computeDeadline(clock: Clock): number {
  return clock() + AEM_REQUEST_TIMEOUT_MS;
}

export function isDeadlineExpired(deadlineMs: number, clock: Clock): boolean {
  return clock() >= deadlineMs;
}

export const envelopeCommonShape = {
  requestId: requestIdSchema,
  chatId: chatIdSchema,
  turnId: turnIdSchema,
  serverId: serverIdSchema,
  serverRevision: z.number().int().nonnegative(),
  navigationEpoch: z.number().int().nonnegative(),
  deadlineMs: z.number().int().positive(),
} as const;

/**
 * Fields the main process attaches to every tool call; the agent never
 * supplies or sees these as tool arguments (implementation-plan.md step 03).
 * Exported as its own type - rather than derived with `Pick` from the envelope
 * union - because `Pick` does not distribute over a union the way this shared
 * shape needs to.
 */
export interface ToolRequestEnvelopeCommon {
  readonly requestId: RequestId;
  readonly chatId: ChatId;
  readonly turnId: TurnId;
  readonly serverId: ServerId;
  readonly serverRevision: number;
  readonly navigationEpoch: number;
  readonly deadlineMs: number;
}

/**
 * The common shape every concrete per-tool request envelope extends, with the
 * operation discriminant and the validated arguments attached.
 */
export interface ToolEnvelopeBase extends ToolRequestEnvelopeCommon {
  readonly operation: string;
  readonly args: unknown;
}

export interface CurrentAemContext {
  readonly serverRevision: number;
  readonly navigationEpoch: number;
}

/**
 * `"fresh"` alongside the two distinct staleness causes, rather than a single
 * boolean, because the two causes are user-facing differently: a revision
 * change means "this server's configuration changed under you", while a
 * navigation-epoch change means "the browser left the page this request was
 * for". Collapsing both into `isStale: boolean` would force the caller to
 * re-derive which happened, from state this function already has.
 */
export type StalenessStatus = 'fresh' | 'stale_server_revision' | 'stale_navigation_epoch';

/**
 * Deliberately symmetric (`!==`, either direction), unlike
 * `../../contracts/serverConfig`'s `isStaleRevision`, which only treats
 * `observed < current` as stale because a chat's cached revision can never
 * legitimately be ahead of the server it describes. This function instead
 * gates whether an in-flight tool call's result may still be delivered - a
 * decision where relying on "can only fall behind" would be actively dangerous
 * if it were ever violated (a revision counter reset, a server removed and
 * re-added). A false `"stale_server_revision"` just makes the caller retry; a
 * false `"fresh"` would hand the model a result against server state that has
 * since changed.
 *
 * Typed structurally on the two fields it reads, not on the envelope union, so
 * this generic module never has to import a concrete tool.
 */
export function classifyStaleness(
  envelope: CurrentAemContext,
  current: CurrentAemContext,
): StalenessStatus {
  if (envelope.serverRevision !== current.serverRevision) return 'stale_server_revision';
  if (envelope.navigationEpoch !== current.navigationEpoch) return 'stale_navigation_epoch';
  return 'fresh';
}
