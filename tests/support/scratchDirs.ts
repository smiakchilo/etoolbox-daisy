import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

export interface ScratchDirs {
  /** Creates a fresh directory, remembered so `cleanup` can remove it. */
  readonly create: () => string;
  /** Removes every directory created so far (call from `afterEach`). */
  readonly cleanup: () => void;
}

/**
 * Scratch directories live under the project's own `test-results/<group>/`
 * (already gitignored), never an OS temp directory.
 */
export function createScratchDirs(group: string, prefix: string): ScratchDirs {
  const created: string[] = [];
  return {
    create: () => {
      const base = path.join(process.cwd(), 'test-results', group);
      mkdirSync(base, { recursive: true });
      const dir = mkdtempSync(path.join(base, prefix));
      created.push(dir);
      return dir;
    },
    cleanup: () => {
      for (const dir of created.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
