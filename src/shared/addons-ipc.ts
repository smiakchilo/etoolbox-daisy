import { z } from 'zod';

import { addonContributionsSchema } from './addons';

/**
 * `addons:contributions` - what the add-ons built into this install contribute.
 * The request has **no payload**. Main reads the built add-ons' descriptors once
 * at startup; the renderer only needs the contributions (to paint a contributed
 * tool's billet and report), never a path.
 */
export const addonsErrorCodeSchema = z.enum(['untrusted_sender']);

export type AddonsErrorCode = z.infer<typeof addonsErrorCodeSchema>;

export const addonContributionsEntrySchema = z
  .object({ id: z.string().min(1).max(64), contributions: addonContributionsSchema })
  .strict();

export type AddonContributionsEntry = Readonly<z.infer<typeof addonContributionsEntrySchema>>;

export const addonContributionsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), addons: z.array(addonContributionsEntrySchema) }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: addonsErrorCodeSchema, message: z.string().max(500) }).strict(),
    })
    .strict(),
]);

export type AddonContributionsResult = Readonly<z.infer<typeof addonContributionsResultSchema>>;

export function parseAddonContributionsResult(candidate: unknown): AddonContributionsResult {
  return addonContributionsResultSchema.parse(candidate);
}
