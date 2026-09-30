import type { RequiredAction } from '../../../shared';
import type { ToolCallStatus } from './transcriptStore';

/**
 * Short label for a tool call's current lifecycle status. `"FAILED"` is
 * deliberately upper-case: implementation-plan.md step 07 calls for a failed
 * tool call to be "visually and structurally distinguishable" from a
 * completed one, and this is the literal text a failed call renders.
 */
export function describeToolCallStatus(status: ToolCallStatus): string {
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
    case 'sign_in_to_aem':
      return 'Sign in to AEM in the browser pane, then try again.';
    case 'sign_in_to_agent':
      return 'Sign in to Copilot, then try again.';
    case 'add_server':
      return 'Add an AEM server in Settings.';
    case 'select_server':
      return 'Select an AEM server first.';
    case 'review_certificate':
      return 'Approve the untrusted certificate in the banner above the browser pane, then try again.';
    case 'check_proxy_settings':
      return 'Check the proxy settings in Settings.';
    case 'reduce_result_size':
      return 'Ask a narrower question so the result is smaller.';
    case 'start_new_chat':
      return 'Start a new chat and try again.';
    default: {
      return action;
    }
  }
}
