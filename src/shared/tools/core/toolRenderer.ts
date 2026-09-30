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
   * is collapsed (a path, a query string). `undefined` when the call is
   * already fully described by its name alone.
   */
  readonly summary: string | undefined;
  /** The rows revealed on expansion. Never empty. */
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

export interface ToolRendererModule {
  /** Must equal the tool's `name`. */
  readonly toolName: string;
  /**
   * The deliberate `getDetails()` composition for this tool's calls - what the
   * user sees collapsed and expanded. Designed by hand with the user (AGENTS.md
   * section 5), not the generic fallback.
   */
  readonly describeCall: (args: Readonly<Record<string, JsonValue>>) => ToolCallDetails;
  /** Optional: turns a succeeded call's payload into a table; `undefined` means "no table". */
  readonly readResultTable?: (data: JsonValue | undefined) => ToolResultTable | undefined;
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
    return { summary: undefined, parameters: [{ label: 'Arguments', value: '(none)' }] };
  }
  return {
    summary: undefined,
    parameters: entries.map(([key, value]) => ({ label: key, value: renderArgValue(value) })),
  };
}
