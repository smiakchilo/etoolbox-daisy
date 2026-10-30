import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddonContributions } from '../../shared';
import { ADDON_DESCRIPTOR_FILE, type AddonDescriptor, addonDescriptorSchema } from './manifest';

/**
 * The add-ons this installation carries, read once at startup.
 *
 * `scripts/build-addons.mjs` writes `<root>/<id>/addon.json` for every add-on
 * of this repository, and the same build ships them with the application, so
 * what is on disk is exactly what this version offers: no catalogue, no
 * download and no pin. An unusable folder is skipped and reported, never fatal.
 */

export interface AddonsDirectoryOptions {
  /** The directory holding the built main bundle (`out/main`). */
  readonly mainDirectory: string;
  /** `process.resourcesPath`. */
  readonly resourcesPath: string;
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
}

/**
 * `<resources>/addons` for an installation (`scripts/app-build.mjs` copies the
 * built add-ons there, beside the archive), `out/addons` for an unpackaged
 * build (`npm run addons:build` writes it next to the main bundle).
 */
export function addonsDirectory(options: AddonsDirectoryOptions): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, 'addons')
    : path.join(options.mainDirectory, '..', 'addons');
}

export interface ScannedAddon {
  readonly id: string;
  /** The built folder holding the entry point and the skills. */
  readonly directory: string;
  readonly descriptor: AddonDescriptor;
  readonly contributions: AddonContributions;
}

export function scanAddons(
  root: string,
  onRejected: (folder: string, reason: string) => void = () => undefined,
): readonly ScannedAddon[] {
  let folders: string[];
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const found: ScannedAddon[] = [];
  for (const folder of folders) {
    const directory = path.join(root, folder);
    try {
      const parsed = addonDescriptorSchema.safeParse(
        JSON.parse(readFileSync(path.join(directory, ADDON_DESCRIPTOR_FILE), 'utf8')),
      );
      if (!parsed.success) {
        onRejected(folder, 'the descriptor is not valid');
        continue;
      }
      if (parsed.data.id !== folder) {
        onRejected(folder, 'the descriptor names another add-on');
        continue;
      }
      found.push({
        id: folder,
        directory,
        descriptor: parsed.data,
        contributions: parsed.data.contributes ?? { tools: [], skills: [] },
      });
    } catch {
      onRejected(folder, 'the descriptor could not be read');
    }
  }
  return found;
}
