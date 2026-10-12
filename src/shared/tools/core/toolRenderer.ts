import type { JsonValue } from '../../contracts';

/**
 * What a tool contributes to the transcript. Pure data - never DOM, never
 * HTML: the renderer turns it into elements with `textContent` only, because
 * these strings are model-authored (or AEM-authored) and cross a process
 * boundary.
 *
 * A tool supplies these from `src/tools/<name>/renderer/index.ts`; the
 * renderer discovers them by glob (`src/renderer/src/chat/toolRegistry.ts`),
 * so a tool folder can be deleted without touching the transcript code.
 */

export interface ToolCallParameter {
  readonly label: string;
  readonly value: string;
}

export interface ToolCallDetails {
  /**
   * A short summary of the request shown beside the tool name while the billet
   * is collapsed (a path, a query string, a host URL). `undefined` when the
   * call is already fully described by its name alone.
   */
  readonly summary: string | undefined;
  /**
   * The rows revealed on expansion. This is the **one** shape every tool uses -
   * the pattern `aem_query`'s renderer established: an ordered list of
   * Title-cased `label`/`value` rows, the identifying value first, with an
   * optional row omitted (not left blank) when its value is absent. It is never
   * a raw argument dump and never any other shape. Build it with
   * {@link parameterRows} so every renderer agrees; it is never empty (a tool
   * that cannot describe a call falls back to {@link describeGenericArgs}).
   */
  readonly parameters: readonly ToolCallParameter[];
}

/** A tabular result the transcript can render as a table plus a status line. */
export interface ToolResultTable {
  readonly columns: readonly string[];
  /** One entry per row, aligned to `columns`; a missing value renders as `""`. */
  readonly rows: readonly (readonly string[])[];
  /** One sentence stating what was shown, out of how many, and whether more exist. */
  readonly status: string;
  /** True when this page is not known to be the whole result set. */
  readonly mayHaveMore: boolean;
}

/**
 * A whole table the transcript paints as an assistant **message** (in place of
 * a billet), optionally over a one-line total. This is what a
 * `presentation: 'message'` tool returns: `format_table` accumulates its rows
 * across a search run and the transcript renders one such message for the run.
 */
export interface ToolTableMessage {
  /** Whether this call starts a new run or appends to the current one. */
  readonly mode: 'new' | 'append';
  /** The total line shown beneath the table, or `undefined` for no total. */
  readonly total: string | undefined;
  readonly table: ToolResultTable;
}

/**
 * How the transcript presents a tool's calls. `'billet'` - the default - is the
 * standard icon-led, expandable line every read tool uses. `'conversation'` is
 * for a tool whose call is really a message exchange with the user
 * (`ask_user`): the transcript renders the question and answer as ordinary
 * messages, with no billet at all. `'message'` is for a tool whose call renders
 * its own assistant message rather than a call line (`format_table`): the
 * transcript hides the billet and paints the returned message instead.
 */
export type ToolPresentation = 'billet' | 'conversation' | 'message';

/**
 * The question/answer pair a `presentation: 'conversation'` tool paints into
 * the transcript in place of a billet. Pure strings, like everything else here.
 */
export interface ToolConversationItem {
  /** The text shown as the agent's own message. */
  readonly question: string;
  /** The user's answer, or `undefined` while the question is still unanswered. */
  readonly answer: string | undefined;
}

export interface ToolRendererModule {
  /** Must equal the tool's `name`. */
  readonly toolName: string;
  /**
   * How this tool's calls appear in the transcript. Omitted means `'billet'`.
   * A `'conversation'` tool must also supply {@link readConversation}; the view
   * falls back to a billet if it does not.
   */
  readonly presentation?: ToolPresentation;
  /**
   * The deliberate `getDetails()` composition for this tool's calls - what the
   * user sees collapsed and expanded. Designed by hand with the user (AGENTS.md
   * section 5), not the generic fallback.
   *
   * `data` is the succeeded call's payload (`{ textResultForLlm, resultType }`
   * for most tools, or the tool's own structured fields when it supplies a
   * `toPayload`), so a tool whose interesting detail lives in its *result*
   * rather than its arguments can still fill the collapsed summary and the
   * expansion rows. It is `undefined` while the call is pending or when it
   * failed; on failure the error is rendered outside the disclosure anyway.
   *
   * A `presentation: 'conversation'` tool is never rendered as a billet, so its
   * `describeCall` is only a safety net; {@link readConversation} is the one
   * the transcript actually uses.
   */
  readonly describeCall: (
    args: Readonly<Record<string, JsonValue>>,
    data?: JsonValue,
  ) => ToolCallDetails;
  /**
   * Required for a `presentation: 'conversation'` tool: composes the question
   * and answer pair from the call's arguments and (once it succeeded) result.
   * Returns `undefined` when this build does not recognise the call, in which
   * case the view shows nothing rather than guessing.
   */
  readonly readConversation?: (
    args: Readonly<Record<string, JsonValue>>,
    data?: JsonValue,
  ) => ToolConversationItem | undefined;
  /**
   * Required for a `presentation: 'message'` tool: composes the assistant
   * message to paint from the call's own arguments (and optionally its result).
   * Returns `undefined` when this build does not recognise the call, in which
   * case the view shows nothing for that call.
   */
  readonly readTableMessage?: (
    args: Readonly<Record<string, JsonValue>>,
    data?: JsonValue,
  ) => ToolTableMessage | undefined;
}

/**
 * Builds the standard expansion rows from `[label, value]` pairs, dropping any
 * pair whose value is `undefined`. This is the single permitted way to render a
 * tool's arguments/details into {@link ToolCallDetails.parameters} - the
 * `summary` plus ordered Title-cased label/value rows pattern `aem_query`'s
 * renderer established. A value that is present but empty (e.g. `''`) is kept;
 * pass `undefined` to omit a row the call did not use.
 */
export function parameterRows(
  entries: readonly (readonly [label: string, value: string | undefined])[],
): ToolCallParameter[] {
  const rows: ToolCallParameter[] = [];
  for (const [label, value] of entries) {
    if (value !== undefined) rows.push({ label, value });
  }
  return rows;
}

/** Reads a string array defensively out of a `JsonValue` argument. */
export function asStringArray(value: JsonValue | undefined): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** One argument value as display text; objects and arrays are JSON-stringified rather than dropped. */
export function renderArgValue(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // `JsonValue` excludes the values for which `JSON.stringify` returns
  // `undefined`, so the stringified form is always a string here.
  return JSON.stringify(value);
}

/** The universal fallback: every argument, verbatim. It exists so a tool is never invisible. */
export function describeGenericArgs(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return { summary: undefined, parameters: parameterRows([['Arguments', '(none)']]) };
  }
  return {
    summary: undefined,
    parameters: parameterRows(entries.map(([key, value]) => [key, renderArgValue(value)] as const)),
  };
}
