import { buildSync } from 'esbuild';
import path from 'node:path';
import { createScratchDirs } from './scratchDirs';

const WORKER_SOURCE = path.join(
  process.cwd(),
  'src',
  'main',
  'skills',
  'sandbox',
  'scriptWorker.ts',
);

export interface BuiltScriptWorker {
  /** Absolute path of the bundled worker, usable as `runSkillScript`'s `workerPath`. */
  readonly workerPath: string;
  readonly cleanup: () => void;
}

/**
 * Plain Node cannot import the electron-vite `?modulePath` worker, so tests
 * bundle the very same worker source into a scratch directory instead.
 */
export function buildScriptWorker(): BuiltScriptWorker {
  const scratch = createScratchDirs('script-worker', 'worker-');
  const outfile = path.join(scratch.create(), 'scriptWorker.cjs');
  buildSync({
    entryPoints: [WORKER_SOURCE],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  });
  return { workerPath: outfile, cleanup: scratch.cleanup };
}
