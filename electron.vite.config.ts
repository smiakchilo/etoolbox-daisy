import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import path from 'node:path';
import { assertSelfContainedPreloads } from './build/assertSelfContainedPreloads';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    // Sandboxed preload scripts (webPreferences.sandbox: true) run in
    // Electron's sandbox_bundle, which only lets `require()` resolve
    // Electron's own built-ins - NOT arbitrary node_modules. `zod` must be
    // bundled into the preload output instead of externalized, or the
    // sandboxed preload fails at load time with "module not found: zod".
    // `electron` itself stays externalized: it is one of the few modules
    // the sandbox host provides natively.
    //
    // For the same reason this build declares exactly ONE entry. Rollup
    // extracts any module reachable from two entries into a shared chunk,
    // and each entry then begins `require("./chunks/<name>.js")` - a
    // relative sibling require, which the sandboxed loader can no more
    // resolve than an external package. Electron's own sandbox
    // documentation says so directly: "you will not be able to use CommonJS
    // modules to separate your preload script into multiple files".
    //
    // No Rollup option makes two entries duplicate their shared code rather
    // than share it: `manualChunks` cannot place one module in two chunks,
    // and `experimentalMinChunkSize` declines to merge an entry-shared
    // chunk. Both were tried and both still emitted `chunks/`. So the second
    // preload is built by its own pass, `electron.vite.aem-preload.config.ts`,
    // where it is once again the only entry and is therefore self-contained.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] }), assertSelfContainedPreloads()],
    build: {
      rollupOptions: {
        input: {
          'app-preload': path.resolve(__dirname, 'src/preload/app-preload.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
});
