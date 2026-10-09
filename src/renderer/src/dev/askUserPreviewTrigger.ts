import type {
  AgentEvent,
  ChatId,
  JsonValue,
  ToolCallId,
  UserInputAnswer,
  UserInputRequest,
} from '../../../shared';
import { parseAskUserPreview } from './askUserPreview';

/**
 * The stateful half of the dev-only ask-user preview (Tier 1).
 *
 * `askUserPreview.ts` is the pure parser; this owns the one piece of state the
 * preview needs (which synthetic tool call is on screen) and turns a parsed
 * request / a submitted answer into the synthetic `AgentEvent`s the pane feeds
 * its transcript store. Everything specific to the preview therefore lives in
 * this `dev/` directory: the pane only wires the factory and paints what it
 * returns, so retiring the preview is deleting this directory and its single
 * wiring block.
 *
 * It deliberately produces the *same* event shapes the real pipeline does
 * (`tool.call.requested` for `ask_user`, then its `tool.result`), so the
 * composer and transcript render a preview exactly as they render the real
 * thing - the only pretend part is that nothing is sent anywhere.
 */

/**
 * Placeholder chat id for the synthetic events. The transcript store routes by
 * the events it is handed and never reads `chatId`; the preview is not part of
 * any real conversation.
 */
const PREVIEW_CHAT_ID = 'preview' as ChatId;

export interface AskUserPreviewStart {
  readonly request: UserInputRequest;
  /** The synthetic `ask_user` tool call to paint into the transcript. */
  readonly toolCall: AgentEvent;
}

export interface AskUserPreviewTrigger {
  /**
   * Consumes a composer input as a preview command. Returns the question to
   * show and the tool call to paint, or `undefined` when the input is not a
   * preview command (so ordinary prompts pass through untouched).
   */
  start(input: string): AskUserPreviewStart | undefined;
  /**
   * If a preview is active, returns the synthetic `tool.result` for `answer` -
   * the local stand-in for the round trip - or `undefined` when no preview is
   * active (so a real answer proceeds to `respondToInput`).
   */
  answer(answer: UserInputAnswer): AgentEvent | undefined;
  /** Whether a preview question is currently on screen. */
  active(): boolean;
  /** Forgets any active preview. */
  reset(): void;
}

export function createAskUserPreviewTrigger(): AskUserPreviewTrigger {
  let sequence = 0;
  let activeToolCallId: ToolCallId | undefined;

  return {
    start(input) {
      const request = parseAskUserPreview(input);
      if (request === undefined) return undefined;

      const toolCallId = `preview-${String(sequence++)}` as ToolCallId;
      activeToolCallId = toolCallId;
      const args: Record<string, JsonValue> = {
        ...(request.question !== undefined ? { question: request.question } : {}),
        ...(request.options !== undefined ? { options: [...request.options] } : {}),
        ...(request.actions !== undefined ? { actions: [...request.actions] } : {}),
        multiple: request.multiple,
        freeInput: request.freeInput,
      };
      return {
        request,
        toolCall: {
          type: 'tool.call.requested',
          chatId: PREVIEW_CHAT_ID,
          sequence: 0,
          toolCallId,
          toolName: 'ask_user',
          arguments: args,
        },
      };
    },
    answer(answer) {
      const toolCallId = activeToolCallId;
      if (toolCallId === undefined) return undefined;
      activeToolCallId = undefined;
      return {
        type: 'tool.result',
        chatId: PREVIEW_CHAT_ID,
        sequence: 0,
        toolCallId,
        outcome: {
          ok: true,
          data: {
            operation: 'ask_user',
            selections: [...answer.selections],
            freeform: answer.freeform,
          },
        },
      };
    },
    active() {
      return activeToolCallId !== undefined;
    },
    reset() {
      activeToolCallId = undefined;
    },
  };
}
