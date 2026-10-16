import {
  assistantText,
  errorEvents,
  type Journal,
  skillCalls,
  toolCalls,
  type ToolCallEntry,
  turnSummaries,
} from './journal';
import { describeToolStatus } from './transcript';

function names(journal: Journal): string {
  const seen = toolCalls(journal).map((call) => `${call.toolName} (${describeToolStatus(call)})`);
  return seen.length === 0 ? 'none' : seen.join(', ');
}

/** The calls to `toolName` that satisfy `predicate`; throws when there is none. */
export function expectToolCalled(
  journal: Journal,
  toolName: string,
  predicate: (call: ToolCallEntry) => boolean = () => true,
): readonly ToolCallEntry[] {
  const matches = toolCalls(journal, toolName).filter(predicate);
  if (matches.length === 0) {
    throw new Error(`Expected a call to tool "${toolName}" but the journal has: ${names(journal)}`);
  }
  return matches;
}

export function expectToolNotCalled(journal: Journal, toolName: string): void {
  const found = toolCalls(journal, toolName);
  if (found.length > 0) {
    throw new Error(`Expected no call to tool "${toolName}" but found ${found.length}`);
  }
}

/** The `skill` call that loaded `skillName`; throws when the model never loaded it. */
export function expectSkillLoaded(journal: Journal, skillName: string): ToolCallEntry {
  const calls = skillCalls(journal).filter((call) => call.skillName === skillName);
  const [first] = calls;
  if (first === undefined) {
    const loaded = skillCalls(journal).map((call) => call.skillName ?? '?');
    throw new Error(
      `Expected skill "${skillName}" to be loaded; loaded: ${loaded.length === 0 ? 'none' : loaded.join(', ')}`,
    );
  }
  return first;
}

/** Every tool call that has a result succeeded. A call with no recorded result is not an error here. */
export function expectNoToolError(journal: Journal, toolName?: string): void {
  const failed = toolCalls(journal, toolName).filter(
    (call) => call.outcome !== undefined && !call.outcome.ok,
  );
  if (failed.length > 0) {
    const detail = failed.map((call) => `${call.toolName}: ${describeToolStatus(call)}`).join('; ');
    throw new Error(`Expected no tool errors but found: ${detail}`);
  }
}

/** The call finished with a successful result (use for "the tool really ran"). */
export function expectToolSucceeded(call: ToolCallEntry): void {
  if (call.outcome === undefined || !call.outcome.ok) {
    throw new Error(
      `Expected tool "${call.toolName}" to succeed but it is: ${describeToolStatus(call)}`,
    );
  }
}

/** The assistant's text contains `needle` (a string, case-insensitively, or a RegExp). */
export function expectAssistantMentions(journal: Journal, needle: string | RegExp): void {
  const text = assistantText(journal);
  const found =
    typeof needle === 'string'
      ? text.toLowerCase().includes(needle.toLowerCase())
      : needle.test(text);
  if (!found) {
    throw new Error(
      `Expected the assistant to mention ${String(needle)}; it said: ${text.slice(0, 500) || '(nothing)'}`,
    );
  }
}

/** The last turn ended `completed`, with no `error` or failed model call recorded. */
export function expectTurnCompleted(journal: Journal): void {
  const last = turnSummaries(journal).at(-1);
  if (last === undefined) throw new Error('Expected a turn summary but the journal has none');
  if (last.outcome !== 'completed') {
    throw new Error(`Expected the last turn to complete but it ended: ${last.outcome}`);
  }
  const errors = errorEvents(journal);
  if (errors.length > 0) {
    throw new Error(
      `Expected no errors but the journal holds ${errors.length}: ${errors[0]?.type}`,
    );
  }
}
