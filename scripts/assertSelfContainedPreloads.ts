import type { Plugin } from 'vite';

/**
 * Fails the build if a preload bundle would need `require()` to reach another
 * emitted file.
 *
 * This exists because the failure it catches is completely silent. A
 * sandboxed preload that cannot resolve its own sibling chunk does not crash
 * the app: Electron reports a `preload-error` on the WebContents and then
 * carries on, so the window opens, the page renders, and only the preload's
 * APIs are missing. Every unit test still passes, because unit tests import
 * TypeScript sources and never see the bundle at all.
 *
 * That is exactly how adding a second preload entry once broke both preloads
 * here - taking the whole application UI with them - without a single red
 * test. Turning it into a build error is what makes the guarantee durable:
 * "each preload is one self-contained file" is now checked by the build
 * rather than remembered by whoever edits the config next.
 */
export function assertSelfContainedPreloads(): Plugin {
  return {
    name: 'daisy:assert-self-contained-preloads',
    apply: 'build',
    generateBundle(_options, bundle) {
      const emitted = new Set(Object.keys(bundle));
      const offenders: string[] = [];

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const imported of [...output.imports, ...output.dynamicImports]) {
          // `imports` lists external ids (e.g. "electron") alongside emitted
          // files; only the emitted ones are unreachable from the sandbox.
          if (emitted.has(imported)) {
            offenders.push(`${fileName} -> ${imported}`);
          }
        }
      }

      if (offenders.length > 0) {
        throw new Error(
          [
            'Preload bundles must be self-contained, but these reference sibling files:',
            ...offenders.map((entry) => `  ${entry}`),
            '',
            'A sandboxed preload cannot require() a relative file, so the preload',
            'would fail to load at runtime and the app would silently lose its',
            'preload APIs. Give each preload its own build pass so it is the only',
            'entry, rather than letting Rollup share a chunk between entries.',
          ].join('\n'),
        );
      }
    },
  };
}
