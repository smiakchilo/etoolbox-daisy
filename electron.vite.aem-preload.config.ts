import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import path from 'node:path';
import { assertSelfContainedPreloads } from './scripts/assertSelfContainedPreloads';

/**
 * The second preload build pass.
 *
 * `electron.vite.config.ts` explains why this file exists: a sandboxed
 * preload cannot `require()` a sibling chunk, and Rollup has no option that
 * makes two entry points duplicate shared code instead of sharing a chunk.
 * Building each preload as the sole entry of its own pass is what keeps both
 * outputs self-contained, and `assertSelfContainedPreloads` fails the build
 * if that ever stops being true.
 *
 * `emptyOutDir: false` is load-bearing: this pass writes into the same
 * `out/preload` directory the first pass has just populated, and clearing it
 * would delete `app-preload.js` instead of joining it.
 */
export default defineConfig({
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] }), assertSelfContainedPreloads()],
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: {
          'aem-preload': path.resolve(__dirname, 'src/preload/aem-preload.ts'),
        },
      },
    },
  },
});
