import { z } from 'zod';

/**
 * Wire contract for the transcript table Export surface (`table-export:*`,
 * keep in step with `TABLE_EXPORT_SAVE_CSV_CHANNEL` in `ipc-channels.ts`).
 * Mirrors `browser-ipc.ts`'s placement and shape: this DTO lives directly
 * under `src/shared`, separate from the domain contracts in
 * `src/shared/contracts`, and is validated at both ends of the boundary.
 *
 * The split of responsibility is deliberate: the renderer owns the table's
 * **serialization** (it holds the rendered columns/rows and the CSV rules -
 * `src/renderer/src/chat/tableExport.ts`), main owns the two privileged steps
 * the renderer cannot do - putting up the OS save dialog and writing the file
 * the user chose. So the request carries a *suggested* file name plus the
 * finished CSV text, and nothing here derives a path from the renderer.
 */

/** The longest CSV the renderer may hand over. A search table is far smaller; this is a backstop, not a target. */
const CONTENT_MAX_LENGTH = 16 * 1024 * 1024;

/** The longest suggested file name. */
const FILE_NAME_MAX_LENGTH = 200;

export const TABLE_EXPORT_ERROR_CODES = [
  /** The request payload failed schema validation. */
  'invalid_payload',
  /** The request did not come from the local app's own renderer. */
  'untrusted_sender',
  /** The chosen file could not be written (permissions, a vanished directory, ...). */
  'write_failed',
  /** No export has happened this session, so there is nothing to reveal in the file manager. */
  'nothing_to_reveal',
  /** Handing the exported file to the OS file manager failed. */
  'reveal_failed',
] as const;

export type TableExportErrorCode = (typeof TABLE_EXPORT_ERROR_CODES)[number];

export const tableExportErrorSchema = z
  .object({
    code: z.enum(TABLE_EXPORT_ERROR_CODES),
    message: z.string().min(1).max(500),
  })
  .strict();

export type TableExportError = Readonly<z.infer<typeof tableExportErrorSchema>>;

/** The Windows-reserved characters a file name may not carry. */
const RESERVED_FILE_NAME_CHARACTERS = '\\/:*?"<>|';

/**
 * True for a plain file name: no directory separator, no Windows-reserved
 * character, no control character and no `..` traversal. It only ever seeds the
 * save dialog's default, so the point is that it can never name a directory or
 * climb out of one - the path actually written is the user's own choice.
 */
function isPlainFileName(name: string): boolean {
  if (name.includes('..')) return false;
  for (const character of name) {
    if (character.charCodeAt(0) < 0x20) return false;
    if (RESERVED_FILE_NAME_CHARACTERS.includes(character)) return false;
  }
  return true;
}

/**
 * `table-export:save-csv`. `suggestedFileName` is only ever a *default* for the
 * save dialog - it is validated as a plain file name (no directory separators,
 * no traversal), so it can never steer the dialog somewhere surprising, and the
 * user's chosen path is what is actually written. `content` is the finished CSV
 * text, UTF-8 with a leading BOM.
 */
export const tableExportSaveCsvRequestSchema = z
  .object({
    suggestedFileName: z
      .string()
      .min(1)
      .max(FILE_NAME_MAX_LENGTH)
      // No directory separators, no Windows-reserved characters, no control
      // characters, and no traversal - a plain file name, nothing else.
      .refine(isPlainFileName, 'must be a plain file name'),
    content: z.string().max(CONTENT_MAX_LENGTH),
  })
  .strict();

export type TableExportSaveCsvRequest = Readonly<z.infer<typeof tableExportSaveCsvRequestSchema>>;

/**
 * The result of a save attempt. `saved: false` is the ordinary outcome of the
 * user closing the dialog - deliberately not an error, so the renderer has
 * nothing to report. A successful save carries the written file's **name**
 * (never its path) so the pane can say which file it wrote.
 */
export const tableExportSaveCsvResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      saved: z.literal(true),
      fileName: z.string().min(1).max(255),
    })
    .strict(),
  z.object({ ok: z.literal(true), saved: z.literal(false) }).strict(),
  z.object({ ok: z.literal(false), error: tableExportErrorSchema }).strict(),
]);

export type TableExportSaveCsvResult = Readonly<z.infer<typeof tableExportSaveCsvResultSchema>>;

export function parseTableExportSaveCsvResult(candidate: unknown): TableExportSaveCsvResult {
  return tableExportSaveCsvResultSchema.parse(candidate);
}

/**
 * `table-export:reveal-last` - the result of asking main to show the file the
 * last successful export wrote. The request has **no payload**: main remembers
 * the path it wrote, so the renderer can never steer the reveal at an arbitrary
 * path (the same rule as `agent-chat:reveal-journal`).
 */
export const tableExportRevealResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: tableExportErrorSchema }).strict(),
]);

export type TableExportRevealResult = Readonly<z.infer<typeof tableExportRevealResultSchema>>;

export function parseTableExportRevealResult(candidate: unknown): TableExportRevealResult {
  return tableExportRevealResultSchema.parse(candidate);
}
