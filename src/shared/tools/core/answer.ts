import { err, ok, type Result } from '../../result';

/**
 * The one thing a tool cannot compute itself: a **model verdict** on data the
 * tool reads. A tool that post-filters a page of results (the semantic search)
 * runs in one tool call now, and asks the active agent to answer whether each
 * item on a page matches - the model is never asked to call the tool back with
 * a verdict.
 *
 * The contract is deliberately narrow: an instruction, numbered items, and one
 * true/false per item. It is not a general prompt surface - the provider builds
 * its own hardened, tool-less request around {@link renderAnswerPrompt}. The
 * prompt/answer format is shared so Copilot, OpenRouter and the fake ask and
 * parse exactly the same question.
 */
export interface AnswerItem {
  /** Stable id, echoed in the verdict; the prompt numbers the items with it. */
  readonly id: string;
  /** Everything the model needs to see for this item (path and excerpts). */
  readonly text: string;
}

export interface AnswerRequest {
  /** What counts as a match, in the user's own meaning (the semantic context). */
  readonly instruction: string;
  readonly items: readonly AnswerItem[];
}

export interface AnswerVerdict {
  readonly id: string;
  readonly match: boolean;
}

export interface AnswerFailure {
  /** Application-authored text safe to log or show; never remote content. */
  readonly message: string;
  /**
   * True when the turn was aborted first. The caller must not retry an aborted
   * call - it reports cancellation instead.
   */
  readonly cancelled?: boolean;
}

export type AnswerResult = Result<readonly AnswerVerdict[], AnswerFailure>;

/**
 * One answer call is made, then retried up to **two** times when the agent
 * fails or answers with something unusable - three attempts in total. Bounded
 * so a broken provider cannot bill the user indefinitely.
 */
export const ANSWER_MAX_ATTEMPTS = 3;

/** Per-attempt deadline for a answer call, in milliseconds. */
export const ANSWER_TIMEOUT_MS = 120_000;

/**
 * The system instruction of the one-shot answer session. Kept short: the whole
 * task and output format ride on the user prompt, which {@link renderAnswerPrompt}
 * builds from the tool's own request.
 */
export const ANSWER_SESSION_INSTRUCTIONS =
  'You classify search candidates. Follow the requested JSON format exactly, and answer with ' +
  'JSON only - no prose, no markdown.';

const ANSWER_HEADER = [
  'Decide which candidates match the instruction.',
  'A candidate matches only when its text asserts or clearly supports the instruction. A passing',
  'or unrelated mention does not match; empty, unreadable or unintelligible text does not match.',
  'Answer only from the candidate text given here.',
  '',
  'Instruction:',
].join('\n');

const ANSWER_FOOTER = [
  '',
  'Reply with JSON only, exactly in the form {"matches":[1,4]} - the numbers of the candidates',
  'that match. Use {"matches":[]} when none match. Add no other text and no markdown.',
].join('\n');

/** The user prompt for one answer call: the instruction and every numbered item. */
export function renderAnswerPrompt(request: AnswerRequest): string {
  const items = request.items.map((item) => `[${item.id}] ${item.text}`);
  return [ANSWER_HEADER, request.instruction, '', 'Candidates:', ...items, '', ANSWER_FOOTER].join(
    '\n',
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first parseable JSON value in `text`, tolerating a code fence or surrounding prose. */
function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const attempts = [trimmed];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      // Try the next form.
    }
  }
  return undefined;
}

/** One entry of `matches` as an item id: a JSON number or a numeric string. */
function toItemId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

/**
 * Parses the model's answer into one verdict per item, in item order. An answer
 * that is not exactly one known id list is a failure, never a silent "none
 * matched": the caller retries and then reports the search failed.
 */
export function parseAnswer(
  text: string,
  items: readonly AnswerItem[],
): Result<readonly AnswerVerdict[], AnswerFailure> {
  const parsed = extractJson(text);
  if (!isRecord(parsed) || !Array.isArray(parsed['matches'])) {
    return err({ message: 'The model did not answer with a JSON match list' });
  }
  const known = new Set(items.map((item) => item.id));
  const matched = new Set<string>();
  for (const raw of parsed['matches']) {
    const id = toItemId(raw);
    if (id === undefined || !known.has(id)) {
      return err({ message: 'The answer named a candidate that does not exist' });
    }
    matched.add(id);
  }
  return ok(items.map((item) => ({ id: item.id, match: matched.has(item.id) })));
}
