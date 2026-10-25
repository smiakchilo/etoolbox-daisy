import { z } from 'zod';

/**
 * The add-on catalogue the publisher maintains (`addons.json`), and the
 * descriptor every installed add-on folder carries (`addon.json`).
 *
 * An add-on is a folder the application downloads on first use. Its version and
 * `apiVersion` are pinned by the running build (`pins.json`), so a published
 * catalogue may hold many versions at once and this build downloads only the one
 * it names.
 */

/** The catalogue published beside the add-on archives. */
export const ADDON_CATALOG_FILE = 'addons.json';

/** The descriptor inside every installed add-on folder. */
export const ADDON_DESCRIPTOR_FILE = 'addon.json';

/** Upper bound for the catalogue itself. */
export const MAX_ADDON_CATALOG_BYTES = 64 * 1024;

/** Upper bound for one add-on archive (the Copilot CLI payload is the largest). */
export const MAX_ADDON_ARCHIVE_BYTES = 400 * 1024 * 1024;

/** A catalogue entry that applies to every platform. */
export const ADDON_PLATFORM_ANY = 'any';

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

const addonIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

const addonArchiveSchema = z.object({
  file: z.string().regex(/^[A-Za-z0-9._-]{1,160}$/),
  sha512: z.string().regex(/^[0-9a-fA-F]{128}$/),
  size: z.number().int().positive().max(MAX_ADDON_ARCHIVE_BYTES),
});

/**
 * `addons.json`: every id, every published version, one archive per
 * `<platform>-<arch>` (or `any`). Deliberately not strict, like `update.json`: a
 * catalogue published by a newer toolchain may carry fields this build does not
 * know, and ignoring them is the forward-compatible reading.
 */
export const addonCatalogSchema = z.object({
  addons: z.record(
    addonIdSchema,
    z.record(
      versionSchema,
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
    version: versionSchema,
    kind: z.enum(['js', 'binary']),
    apiVersion: z.number().int().positive(),
    /** Relative path of the ESM entry point; required for a `js` add-on. */
    entry: z
      .string()
      .regex(/^[A-Za-z0-9._/-]{1,200}$/)
      .optional(),
    /** Named files a `binary` add-on provides, as relative paths. */
    files: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), z.string()).optional(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.kind === 'js' && descriptor.entry === undefined) {
      context.addIssue({ code: 'custom', message: 'a js add-on needs an entry' });
    }
    if (descriptor.kind === 'binary' && Object.keys(descriptor.files ?? {}).length === 0) {
      context.addIssue({ code: 'custom', message: 'a binary add-on needs files' });
    }
    for (const value of [descriptor.entry, ...Object.values(descriptor.files ?? {})]) {
      if (value !== undefined && !isSafeRelativePath(value)) {
        context.addIssue({ code: 'custom', message: `unsafe path: ${value}` });
      }
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
