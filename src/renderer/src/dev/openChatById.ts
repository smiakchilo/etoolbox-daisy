import { chatIdSchema, type ChatId } from '../../../shared';

/**
 * The dev-only "open a stored conversation by id" trigger (Tier 1): an
 * `!!open <chatId>` cheat code typed into the composer that opens a chat the
 * ordinary startup path can never reach.
 *
 * The app has exactly one way to open a past conversation - the remembered
 * `lastChat` pointer, gated on the page's host matching the pointer's server -
 * and no history list (that is the unbuilt part of plan step 09). This trigger
 * exists to open any journal file on disk by its `ChatId`, for debugging a
 * foreign or orphaned chat whose host is gone. It is reachable only when dev
 * tools are enabled (`window.daisy.devTools`), which a packaged build never
 * sets.
 *
 * Pure and side-effect free: it only parses a string into a command, so the
 * pane can decide what to do. The open itself lives in `chatPane.ts` - this
 * directory plus that one wiring block are all a retirement would delete.
 */

/** The cheat-code prefix. `!!` cannot collide with a `/skillname`. */
export const OPEN_CHAT_BY_ID_PREFIX = '!!open';

export type OpenChatByIdCommand =
  | { readonly kind: 'open'; readonly chatId: ChatId }
  | { readonly kind: 'invalid'; readonly raw: string };

/**
 * Parses an `!!open <chatId>` input into a command, or `undefined` when the
 * input is not an open command at all (so ordinary prompts pass through
 * untouched). A malformed argument is still a command - the pane reports it
 * instead of sending `!!open ...` to the model.
 */
export function parseOpenChatById(input: string): OpenChatByIdCommand | undefined {
  const trimmed = input.trim();
  if (trimmed !== OPEN_CHAT_BY_ID_PREFIX && !trimmed.startsWith(`${OPEN_CHAT_BY_ID_PREFIX} `)) {
    return undefined;
  }
  const raw = trimmed.slice(OPEN_CHAT_BY_ID_PREFIX.length).trim();
  const parsed = chatIdSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', raw };
  return { kind: 'open', chatId: parsed.data };
}
