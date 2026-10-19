import {
  type AgentEvent,
  type ToolCallId,
  type ToolErrorCode,
  type TurnId,
  MEMO_TOOL_NAME,
} from '../../shared';

/** The same model-made tool call (name and arguments) this many times in one turn reads as a loop. */
export const REPEATED_CALL_THRESHOLD = 3;

/** At most this many signals reach the reflection prompt; the rest add nothing the model can use. */
export const MAX_TURN_SIGNALS = 8;

/** A signal's quoted error text is cut to this many characters. */
export const SIGNAL_TEXT_MAX_LENGTH = 300;

/**
 * Failures that say nothing about how the agent worked: the user or the
 * application stopped the call, or the pane moved under it, or the host wants a
 * sign-in. Reflecting on them would teach a lesson about nothing.
 */
const UNINSTRUCTIVE_FAILURES: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'CANCELLED',
  'STALE_CONTEXT',
  'AUTH_REQUIRED',
]);

/**
 * Watches one user turn for the trouble a post-turn reflection is for: a failed
 * tool call, an error, the same call made over and over, or a question the user
 * dismissed and was asked again. Fed every event the controller accepted for
 * that turn; a turn the user stopped, or one in which the agent already wrote a
 * memo, is not reflected on.
 */
export interface TurnSignalCollector {
  readonly turnId: TurnId;
  observe(event: AgentEvent, nested: boolean): void;
  /** The user dismissed the pending question without an answer. */
  noteDismissedInput(): void;
  /** The observed problems, in order, or `[]` when the turn needs no reflection. */
  reflectionSignals(): readonly string[];
}

function clip(text: string): string {
  return text.length > SIGNAL_TEXT_MAX_LENGTH ? `${text.slice(0, SIGNAL_TEXT_MAX_LENGTH)}…` : text;
}

/** JSON with object keys sorted, so two calls with the same arguments compare equal. */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableKey(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function createTurnSignalCollector(turnId: TurnId): TurnSignalCollector {
  const signals: string[] = [];
  const toolNames = new Map<ToolCallId, string>();
  const callCounts = new Map<string, number>();
  let memoWritten = false;
  let cancelled = false;
  let dismissedInput = false;

  function add(signal: string): void {
    if (signals.length < MAX_TURN_SIGNALS) signals.push(signal);
  }

  function observe(event: AgentEvent, nested: boolean): void {
    switch (event.type) {
      case 'tool.call.requested': {
        toolNames.set(event.toolCallId, event.toolName);
        if (event.toolName === MEMO_TOOL_NAME) memoWritten = true;
        // A composite's own nested calls repeat by design (a "Load more" loop
        // asks the same question each page), so only the model's calls count.
        if (nested) return;
        const key = `${event.toolName} ${stableKey(event.arguments)}`;
        const count = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, count);
        if (count === REPEATED_CALL_THRESHOLD) {
          add(
            `The tool "${event.toolName}" was called ${String(count)} times with the same arguments`,
          );
        }
        return;
      }
      case 'tool.result': {
        if (nested || event.outcome.ok) return;
        if (UNINSTRUCTIVE_FAILURES.has(event.outcome.error.code)) return;
        const name = toolNames.get(event.toolCallId) ?? 'unknown';
        add(`The tool "${name}" failed: ${clip(event.outcome.error.message)}`);
        return;
      }
      case 'error':
        if (UNINSTRUCTIVE_FAILURES.has(event.error.code)) return;
        add(`The turn hit an error: ${clip(event.error.message)}`);
        return;
      case 'user.input.requested':
        if (dismissedInput) {
          add('The user dismissed a question without answering and was asked again');
          dismissedInput = false;
        }
        return;
      case 'session.state.changed':
        if (event.state === 'cancelling') cancelled = true;
        return;
      default:
        return;
    }
  }

  return {
    turnId,
    observe,
    noteDismissedInput() {
      dismissedInput = true;
    },
    reflectionSignals() {
      return cancelled || memoWritten ? [] : [...signals];
    },
  };
}
