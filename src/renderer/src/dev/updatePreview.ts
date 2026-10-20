import { updateStatusSchema, type UpdateStatus } from '../../../shared';

/**
 * The dev-only "pretend an update is pending" trigger: `!!update <version>`
 * typed into the composer makes every update surface behave as if main had
 * reported that version available - the chat pane's notice (with its Details
 * action), the Home screen's link and the Settings → Updates tab's Update
 * button and status. `!!update off` returns them to idle. Reachable only when
 * dev tools are enabled (`window.daisy.devTools`), which a packaged build never
 * sets.
 *
 * Pure and side-effect free: it only parses a string into a status. The pane
 * injects it through `lib/updateStatusFeed.ts`, so no real update, network or
 * main-process state is involved - which also means the Update button's own
 * click (a real `apply`) finds nothing to install and reports so.
 */

/** The command prefix. `!!` cannot collide with a `/skillname`. */
export const UPDATE_PREVIEW_PREFIX = '!!update';

/** The `!!update` forms as `[form, description]`; `!!update ?` prints them (see `devCommands.ts`). */
export const UPDATE_PREVIEW_HELP: ReadonlyArray<readonly [string, string]> = [
  ['!!update <version>', 'preview a pending update: chat notice, Home link, Settings button'],
  ['!!update off', 'clear the preview'],
];

export type UpdatePreviewCommand =
  | { readonly kind: 'set'; readonly status: UpdateStatus }
  | { readonly kind: 'invalid'; readonly raw: string };

/**
 * Parses an `!!update ...` input into a command, or `undefined` when the input
 * is not one (so ordinary prompts pass through untouched). A malformed argument
 * is still a command - the pane reports it instead of sending it to the model.
 */
export function parseUpdatePreview(input: string): UpdatePreviewCommand | undefined {
  const trimmed = input.trim();
  if (trimmed !== UPDATE_PREVIEW_PREFIX && !trimmed.startsWith(`${UPDATE_PREVIEW_PREFIX} `)) {
    return undefined;
  }
  const raw = trimmed.slice(UPDATE_PREVIEW_PREFIX.length).trim();
  if (raw.toLowerCase() === 'off') return { kind: 'set', status: { kind: 'idle' } };
  const parsed = updateStatusSchema.safeParse({ kind: 'available', version: raw });
  if (!parsed.success) return { kind: 'invalid', raw };
  return { kind: 'set', status: parsed.data };
}
