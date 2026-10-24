/**
 * The one routine behind every **secondary agentic turn**: a stateless model
 * call a tool makes on the chat's behalf, outside the conversation - today the
 * semantic search asking the model which extracts match, tomorrow whatever else
 * needs a verdict or a rewrite. It is not a chat turn: no conversation history,
 * no tools, no skills, no transcript events, and it never touches the installed
 * `AgentService`'s session.
 *
 * It exists once, so that what every such call has in common is written once:
 *
 *  - **An agent implements exactly one thing** - {@link OneShotCall}
 *    (`AgentRuntime.complete`): run the request on a fresh session of the same
 *    provider, model, effort and proxy, honour the abort signal, and report
 *    **every model call it made** to the {@link UsageSink} it is handed (a
 *    failed or cancelled attempt too - it spent tokens). It knows nothing of any
 *    tool, prompt or parser, so adding a tool never means touching an agent.
 *  - **The application binds the usage sink in one place**
 *    (`createSecondaryTurns`, `src/main/agentComposition.ts`), so a tool cannot
 *    reach the model without its tokens landing in the chat's gross totals.
 *  - **A tool's capability is a thin function over it**: build a prompt, call the
 *    bound `complete`, parse the text. {@link answerWith} is the first; copy its
 *    shape for the next. Prompt and parser live in `src/shared/tools/core/`.
 *
 * `tests/support/agentOneShotConformance.ts` holds an agent that defines
 * `complete` to the usage rule, and `tests/unit/agents/agentConformance.test.ts`
 * fails the build for one that does not run it.
 */
import { err, type Result } from '../result';
import {
  ANSWER_SESSION_INSTRUCTIONS,
  parseAnswer,
  renderAnswerPrompt,
  type AnswerFailure,
  type AnswerRequest,
  type AnswerResult,
} from '../tools';
import type { UsageSink } from './usageReport';

/** What a secondary turn asks of the model: standing instructions and one prompt. */
export interface OneShotRequest {
  readonly instructions: string;
  readonly prompt: string;
}

/** Application-authored text safe to log or show; `cancelled` when the turn was aborted first. */
export type OneShotFailure = AnswerFailure;

/** The model's reply text, or why there is none. Never throws. */
export type OneShotResult = Result<string, OneShotFailure>;

/** The agent side: see the module doc. `AgentRuntime.complete` has this type. */
export type OneShotCall = (
  request: OneShotRequest,
  signal: AbortSignal | undefined,
  reportUsage: UsageSink,
) => Promise<OneShotResult>;

/** A one-shot call with its signal and usage sink already bound by the application. */
export type BoundOneShot = (request: OneShotRequest) => Promise<OneShotResult>;

/** Per-call deadline for a secondary turn, in milliseconds. */
export const ONE_SHOT_TIMEOUT_MS = 120_000;

/**
 * The semantic search's capability: ask the model which numbered items match an
 * instruction. A reply that is not exactly one known id list is a failure, never
 * a silent "none matched" (the caller retries).
 */
export async function answerWith(
  complete: BoundOneShot,
  request: AnswerRequest,
): Promise<AnswerResult> {
  const reply = await complete({
    instructions: ANSWER_SESSION_INSTRUCTIONS,
    prompt: renderAnswerPrompt(request),
  });
  if (!reply.ok) return err(reply.error);
  return parseAnswer(reply.value, request.items);
}
