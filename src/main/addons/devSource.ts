import path from 'node:path';
import { ADDON_DESCRIPTOR_FILE } from './manifest';

/**
 * The add-on folder a build from this repository carries, if any.
 *
 * `npm run dev`, an unpackaged build, the E2E runs and a run-from-source
 * installation all use add-ons built from the repository and **never download
 * one** - there is no network step in a developer's loop and none in the
 * build-from-source flow. A packaged release carries no add-on folder, so it
 * downloads the pinned version instead.
 *
 * Two places are checked, in order:
 * - `out/addons/<id>` - `npm run addons:build` writes it next to the built main
 *   bundle (`out/main/index.js`), so it is present for `npm run dev` and the
 *   E2E runs;
 * - `<resources>/addons/<id>` - `scripts/app-build.mjs` copies the built add-ons
 *   beside the packaged application, because electron-builder leaves them out of
 *   the asar.
 */

export interface DevAddonLocationOptions {
  /** The directory holding the built main bundle (`out/main`). */
  readonly mainDirectory: string;
  /** `process.resourcesPath`. */
  readonly resourcesPath: string;
  /** `app.isPackaged`; an unpackaged build always looks beside its own bundle. */
  readonly isPackaged: boolean;
  readonly exists: (filePath: string) => boolean;
}

export function resolveDevAddonDirectory(
  id: string,
  options: DevAddonLocationOptions,
): string | undefined {
  const candidates = [
    path.join(options.mainDirectory, '..', 'addons', id),
    path.join(options.resourcesPath, 'addons', id),
  ];
  for (const [index, directory] of candidates.entries()) {
    // The first candidate is this repository's build output, meaningful only
    // when the app runs unpackaged; the second is the run-from-source copy,
    // which exists exactly when that install was built from source.
    if (index === 0 && options.isPackaged) continue;
    if (options.exists(path.join(directory, ADDON_DESCRIPTOR_FILE))) return directory;
  }
  return undefined;
}
