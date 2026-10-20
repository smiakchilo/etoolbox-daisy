import { z } from 'zod';

/**
 * The updater's status, shared by main (which owns it) and the renderer (the
 * Settings "Updates" tab, the chat pane's notice and the home screen's link).
 * `available` carries the version of a pending update; `installerRequired`
 * means a newer version exists but needs a full installer (the Electron or
 * runtime generation changed), so it cannot be applied in place.
 */
export const updateStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }).strict(),
  z.object({ kind: z.literal('checking') }).strict(),
  z.object({ kind: z.literal('upToDate') }).strict(),
  z
    .object({
      kind: z.literal('available'),
      version: z.string().min(1).max(64),
      notes: z.string().max(2000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('installerRequired'), version: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('applying') }).strict(),
  z.object({ kind: z.literal('failed'), phase: z.enum(['check', 'apply']) }).strict(),
]);

export type UpdateStatus = Readonly<z.infer<typeof updateStatusSchema>>;

export const updatesErrorCodeSchema = z.enum(['untrusted_sender', 'invalid_payload']);

export type UpdatesErrorCode = z.infer<typeof updatesErrorCodeSchema>;

/** Result of `updates:get-status`, `updates:check` and `updates:apply`. */
export const updatesIpcResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: updateStatusSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: updatesErrorCodeSchema, message: z.string().max(500) }).strict(),
    })
    .strict(),
]);

export type UpdatesIpcResult = Readonly<z.infer<typeof updatesIpcResultSchema>>;

export function parseUpdatesIpcResult(candidate: unknown): UpdatesIpcResult {
  return updatesIpcResultSchema.parse(candidate);
}
