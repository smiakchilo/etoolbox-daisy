import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  addonFolders,
  appToolNames,
  bundledSkillNames,
  contributionsFor,
  loadAppParsers,
} from '../../scripts/build-addons.mjs';

import type { AddonContributionsEntry } from '../../src/shared';

/**
 * What the build derives for every add-on in `src/addons/`, read through the
 * build's own functions - the same contributions a built install describes in
 * its `addon.json`, so a test never hand-copies a declaration.
 */
export async function builtAddonContributions(): Promise<readonly AddonContributionsEntry[]> {
  const parsers = await loadAppParsers();
  const taken = {
    tools: new Map(appToolNames().map((name) => [name, 'the application'] as const)),
    skills: new Map(bundledSkillNames().map((name) => [name, 'the application'] as const)),
  };
  const entries: AddonContributionsEntry[] = [];
  for (const directory of addonFolders()) {
    const descriptor = JSON.parse(readFileSync(path.join(directory, 'addon.json'), 'utf8')) as {
      id: string;
      contributes?: unknown;
    };
    const derived = contributionsFor(directory, descriptor, parsers, taken);
    if (derived.problem !== undefined || derived.contributions === undefined) {
      throw new Error(`add-on ${descriptor.id}: ${derived.problem ?? 'no contributions'}`);
    }
    entries.push({
      id: descriptor.id,
      contributions: derived.contributions,
    } as AddonContributionsEntry);
  }
  return entries;
}
