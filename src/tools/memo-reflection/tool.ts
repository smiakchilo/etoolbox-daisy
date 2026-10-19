import {
  type AemToolExecutor,
  type InternalToolModule,
  MEMO_REFLECTION_TOOL_NAME,
  createToolError,
  err,
  newRequestId,
} from '../../shared';

/**
 * The plugin manifest of the reflection marker. Delete this folder to remove
 * the marker's billet (the reflection itself is the chat controller's, keyed by
 * the shared `MEMO_REFLECTION_TOOL_NAME`).
 *
 * `internal`: the model never sees this tool, and nothing invokes it. The chat
 * controller records a call of it, as a nested tool call of the reflection turn,
 * so the transcript shows the application's post-turn reflection as one quiet
 * billet instead of a prompt and a reply. Its executor exists only because the
 * contract requires one, and refuses.
 */
function createMemoReflectionExecutor(
  host: Parameters<InternalToolModule['createExecutor']>[0],
): AemToolExecutor {
  return () =>
    Promise.resolve(
      err(
        createToolError(
          'ACCESS_DENIED',
          'The reflection marker is recorded by the application, never invoked',
          newRequestId(host.idGenerator),
        ),
      ),
    );
}

export const tool: InternalToolModule = {
  name: MEMO_REFLECTION_TOOL_NAME,
  internal: true,
  createExecutor: (host) => createMemoReflectionExecutor(host),
};
