import { z } from 'zod';
import { addonContributionsSchema } from '../../shared';

/**
 * The descriptor every built add-on folder carries (`addon.json`).
 *
 * An add-on is built from this repository's own source by
 * `scripts/build-addons.mjs` and ships inside the installation, so the
 * application and its add-ons always come from one commit. The build writes the
 * contributions it derived (the tools as declared, the skills from each
 * `SKILL.md`) into the descriptor, and the application reads them back at
 * startup (`scan.ts`).
 */

/** The descriptor inside every built add-on folder. */
export const ADDON_DESCRIPTOR_FILE = 'addon.json';

export const addonIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

/** `addon.json`: what a built add-on folder is. */
export const addonDescriptorSchema = z
  .object({
    id: addonIdSchema,
    apiVersion: z.number().int().positive(),
    /** Relative path of the ESM entry point. */
    entry: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/),
    /** What the add-on offers, as the build derived it. */
    contributes: addonContributionsSchema.optional(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (!isSafeRelativePath(descriptor.entry)) {
      context.addIssue({ code: 'custom', message: `unsafe path: ${descriptor.entry}` });
    }
  });

export type AddonDescriptor = z.infer<typeof addonDescriptorSchema>;

/**
 * Whether a descriptor's path stays inside its own folder: relative, no `..`
 * segment and no drive/root prefix.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split(/[\\/]/).every((segment) => segment !== '' && segment !== '..');
}
