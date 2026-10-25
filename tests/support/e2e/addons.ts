import { TEST_ADDONS_GLOBAL_KEY } from '../../../src/main/addons';
import type { ElectronApp } from './app';

/** What the add-on test probe answers. */
export type AddonProbeResult =
  | {
      readonly ok: true;
      readonly dir: string;
      readonly version: string;
      readonly apiVersion: number;
      readonly progress: readonly number[];
    }
  | { readonly ok: false; readonly reason: string; readonly progress: readonly number[] };

/** Runs the real add-on manager's `ensure` inside the launched app's main process. */
export async function ensureAddon(
  app: ElectronApp,
  id: string,
  timeoutMs = 20_000,
): Promise<AddonProbeResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The probe is published part-way through main's startup, which can still be
    // running when Playwright has the window; wait for it rather than racing it.
    const result = await app.evaluate(
      (_electronNamespace, arg: { readonly globalKey: string; readonly id: string }) => {
        const probe = (globalThis as Record<string, unknown>)[arg.globalKey] as
          { readonly ensure: (id: string) => Promise<AddonProbeResult> } | undefined;
        if (probe === undefined) return undefined;
        return probe.ensure(arg.id);
      },
      { globalKey: TEST_ADDONS_GLOBAL_KEY, id },
    );
    if (result !== undefined) return result;
    if (Date.now() > deadline) {
      throw new Error('the add-on test probe is not exposed');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
