import { z } from 'zod';
import { addonContributionDeclarationSchema } from '../../shared';

/**
 * The add-on catalogue the publisher maintains (`addons.json`), and the
 * descriptor every installed add-on folder carries (`addon.json`).
 *
 * An add-on is a folder the application downloads on first use. Its identity is
 * **derived from its own content** by `scripts/build-addons.mjs` and pinned by
 * the running build (`pins.json`), so there is no version for a human to
 * remember, bump or forget: an unchanged add-on keeps its identity (and is
 * never downloaded again), and a changed one gets a new one. A published
 * catalogue may hold many identities at once; this build downloads only the one
 * it names.
 */

/** The catalogue published beside the add-on archives. */
export const ADDON_CATALOG_FILE = 'addons.json';

/** The descriptor inside every installed add-on folder. */
export const ADDON_DESCRIPTOR_FILE = 'addon.json';

/** Upper bound for the catalogue itself. */
export const MAX_ADDON_CATALOG_BYTES = 64 * 1024;

/** Upper bound for one add-on archive. */
export const MAX_ADDON_ARCHIVE_BYTES = 400 * 1024 * 1024;

/** A catalogue entry that applies to every platform. */
export const ADDON_PLATFORM_ANY = 'any';

/**
 * A content identity: the first 16 hex characters of a sha256 over the
 * add-on's own sources (see `identityFor` in `scripts/build-addons.mjs`).
 */
const identitySchema = z.string().regex(/^[0-9a-f]{16}$/);

const addonIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

const addonArchiveSchema = z.object({
  file: z.string().regex(/^[A-Za-z0-9._-]{1,160}$/),
  sha512: z.string().regex(/^[0-9a-fA-F]{128}$/),
  size: z.number().int().positive().max(MAX_ADDON_ARCHIVE_BYTES),
});

/**
 * `addons.json`: every id, every published identity, one archive per
 * `<platform>-<arch>` (or `any`). Deliberately not strict, like `update.json`: a
 * catalogue published by a newer toolchain may carry fields this build does not
 * know, and ignoring them is the forward-compatible reading.
 */
export const addonCatalogSchema = z.object({
  addons: z.record(
    addonIdSchema,
    z.record(
      identitySchema,
      z.object({
        platforms: z.record(z.string(), addonArchiveSchema),
      }),
    ),
  ),
});

export type AddonCatalog = z.infer<typeof addonCatalogSchema>;
export type AddonArchive = z.infer<typeof addonArchiveSchema>;

/** `addon.json`: what an installed add-on folder is. */
export const addonDescriptorSchema = z
  .object({
    id: addonIdSchema,
    identity: identitySchema,
    apiVersion: z.number().int().positive(),
    /** Relative path of the ESM entry point. */
    entry: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/),
    /**
     * The tools this add-on offers, exactly as `addon.json` declared them. The
     * **pins** are the only run-time source (this copy is what the build wrote
     * into the install, for inspection); it is validated here so a hand-edited
     * folder cannot look like an add-on whose contributions the app trusts.
     */
    contributes: addonContributionDeclarationSchema.optional(),
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
 * segment and no drive/root prefix. The archive extractor applies the same rule
 * to every entry, so an add-on can never write outside its own version folder.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split(/[\\/]/).every((segment) => segment !== '' && segment !== '..');
}
