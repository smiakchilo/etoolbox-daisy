import { z } from 'zod';
import { memoIdSchema } from './memos';

/**
 * The memo IPC surface:
 * - `memos:open-folder` - the Settings "Skills" tab's **Memos folder** link. No
 *   payload: main opens the one fixed folder (`appPaths.memos`), creating it.
 * - `memos:reveal` - the chat pane's "Memo was stored" notice: its **Open**
 *   action reveals the memo's file in the OS file manager. The request names a
 *   memo by its store-relative id only; main derives the path and keeps it
 *   inside the memos folder.
 */
export const memosErrorCodeSchema = z.enum([
  'untrusted_sender',
  'invalid_payload',
  'open_failed',
  'not_found',
]);

export type MemosErrorCode = z.infer<typeof memosErrorCodeSchema>;

export const memosIpcResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: memosErrorCodeSchema, message: z.string().max(500) }).strict(),
    })
    .strict(),
]);

export type MemosIpcResult = Readonly<z.infer<typeof memosIpcResultSchema>>;

export function parseMemosIpcResult(candidate: unknown): MemosIpcResult {
  return memosIpcResultSchema.parse(candidate);
}

/** `memos:reveal` request: the memo's store-relative id. */
export const memoFileRequestSchema = z.object({ id: memoIdSchema }).strict();

export type MemoFileRequest = Readonly<z.infer<typeof memoFileRequestSchema>>;
