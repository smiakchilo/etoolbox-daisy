import {
  type InterruptionReason,
  type RequiredAction,
  readLeadingSkillToken,
} from '../../../shared';
import type { ToolCallStatus } from './transcriptStore';

/**
 * Short label for a tool call's current lifecycle status, or `undefined` for a
 * status that deliberately shows no status word. `"FAILED"` is deliberately
 * upper-case: implementation-plan.md step 07 calls for a failed tool call to be
 * "visually and structurally distinguishable" from a completed one, and this is
 * the literal text a failed call renders.
 */
export function describeToolCallStatus(status: ToolCallStatus): string | undefined {
  switch (status.kind) {
    case 'requested':
      return 'Requested';
    case 'approved':
      return 'Running';
    case 'rejected':
      return 'Rejected';
    case 'succeeded':
      return 'Completed';
    case 'failed':
      return 'FAILED';
    case 'abandoned':
      // A replayed call the journal never resolved (the app closed mid-turn).
      // It is not running and never will be, so the spinner is gone; the word
      // says why, rather than implying a completion that never happened.
      return 'Interrupted';
    case 'abandonedAwaitingInput':
      // The turn was paused on the user's answer, not interrupted - nothing was
      // in flight. The billet shows the tool name and the settled icon with no
      // status word at all (see `transcriptView.ts`'s header composition).
      return undefined;
    default: {
      return status;
    }
  }
}

/**
 * The one line of reasoning shown beside the "Thinking" label while the
 * billet is collapsed: the last non-empty line of the streamed reasoning text,
 * so the reader sees the model's most recent thought. Reasoning that has not
 * yet produced a line break is a single line. Returns `""` for empty or
 * whitespace-only input, which the view renders as no line at all.
 */
export function latestReasoningLine(reasoning: string): string {
  const lines = reasoning
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? '';
}

/**
 * Human-readable description of what the user would have to do next,
 * independently declared here rather than imported from `src/main` (which
 * the renderer must never import - see `agentChatErrorSchema`'s own doc
 * comment in `agent-chat-ipc.ts` for the same "independently declared, not
 * shared" convention across this exact process boundary). Returns
 * `undefined` for `"none"`: there is nothing to tell the user to do.
 */
export function describeRequiredAction(action: RequiredAction): string | undefined {
  switch (action) {
    case 'none':
      return undefined;
    case 'sign_in_to_host':
      return 'Sign in to the site in the browser pane, then try again';
    case 'sign_in_to_agent':
      return 'Sign in to Copilot, then try again';
    case 'add_server':
      return 'Add a host in Settings';
    case 'select_server':
      return 'Select a host first';
    case 'review_certificate':
      return 'Approve the untrusted certificate in the banner above the browser pane, then try again';
    case 'check_proxy_settings':
      return 'Check the proxy settings in Settings';
    case 'reduce_result_size':
      return 'Ask a narrower question so the result is smaller';
    case 'start_new_chat':
      return 'Start a new chat and try again';
    default: {
      return action;
    }
  }
}

/**
 * The one-line notice shown in the transcript when a turn is interrupted.
 * `"stopped"` is the user's own Stop; `"navigation"` is the app aborting the
 * turn because the AEM context changed (a server switch, a cross-origin
 * navigation, a renderer/view loss). The wording is deliberately distinct so a
 * reader can tell their own action from the application's.
 */
export function describeInterruption(reason: InterruptionReason): string {
  switch (reason) {
    case 'stopped':
      return 'Session stopped';
    case 'navigation':
      return 'Session interrupted by navigation';
    default: {
      return reason;
    }
  }
}

/**
 * The two parts of a user prompt split at a leading `/skillname` reference:
 * the slash-prefixed skill name (rendered bold) and everything after it. When
 * the prompt does not begin with a *known* skill name, `skill` is `false` and
 * `trailing` is the whole prompt, so the caller can render it as plain text.
 *
 * "Known" is the caller's call - the composer's `/` invocation only actually
 * rewrites a prompt whose leading token names a bundled skill (see
 * `resolveSkillPrompt`), so only those should read as a skill in the
 * transcript.
 */
export interface UserPromptSegments {
  readonly leading: string;
  readonly trailing: string;
  readonly skill: boolean;
}

export function splitLeadingSkill(
  prompt: string,
  knownSkillNames: readonly string[],
): UserPromptSegments {
  const token = readLeadingSkillToken(prompt);
  if (token === undefined || !knownSkillNames.includes(token.name)) {
    return { leading: '', trailing: prompt, skill: false };
  }
  const leading = `/${token.name}`;
  return { leading, trailing: prompt.slice(leading.length), skill: true };
}

/**
 * The bundled skills whose answer is a deterministic, application-rendered
 * table rather than the model's own prose. A turn that invokes one of these
 * (`/search`, `/semantic-search`, `/search-component`, `/search-page`) has its assistant text
 * suppressed from the transcript: the `format_table` message is the whole
 * answer, so the model's surrounding prose ("here are the results...", an
 * explanation of the component, ad-hoc Markdown tables) would only duplicate or
 * contradict it.
 *
 * Deliberately a constant, not the live skill catalogue: suppression is decided
 * on send, before the catalogue may have loaded, and must not change with it.
 */
export const DETERMINISTIC_TABLE_SKILLS: readonly string[] = [
  'search',
  'semantic-search',
  'search-page',
  'search-component',
  'search-page',
];

/** Whether `prompt` invokes one of {@link DETERMINISTIC_TABLE_SKILLS}. */
export function isDeterministicTablePrompt(prompt: string): boolean {
  const token = readLeadingSkillToken(prompt);
  return token !== undefined && DETERMINISTIC_TABLE_SKILLS.includes(token.name);
}
