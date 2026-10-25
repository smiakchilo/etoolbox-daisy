import type { AddonManager } from './manager';

/**
 * A same-process probe of the add-on manager, for the E2E suite.
 *
 * The fake agent scripts a tool call's outcome, so it never runs a real tool
 * executor - an installed add-on therefore cannot be reached through a chat
 * turn in an E2E. This probe installs one exactly as a feature would (same
 * manager, same catalogue, same verification) and reports what is on disk, so
 * the download path is provable against the built application.
 *
 * Published on `globalThis` only when `!app.isPackaged` (see `index.ts`): it is
 * not an IPC channel and the renderer cannot reach it.
 */
export const TEST_ADDONS_GLOBAL_KEY = '__etoolboxDaisyTestAddons' as const;

export interface AddonTestProbe {
  ensure(id: string): Promise<
    | {
        readonly ok: true;
        readonly dir: string;
        readonly version: string;
        readonly apiVersion: number;
        readonly progress: readonly number[];
      }
    | { readonly ok: false; readonly reason: string; readonly progress: readonly number[] }
  >;
}

export function createAddonTestProbe(manager: AddonManager): AddonTestProbe {
  return {
    async ensure(id) {
      const progress: number[] = [];
      const result = await manager.ensure(id, {
        onProgress: (fraction) => progress.push(fraction),
      });
      return result.ok
        ? {
            ok: true,
            dir: result.value.dir,
            version: result.value.descriptor.version,
            apiVersion: result.value.descriptor.apiVersion,
            progress,
          }
        : { ok: false, reason: result.error.reason, progress };
    },
  };
}
