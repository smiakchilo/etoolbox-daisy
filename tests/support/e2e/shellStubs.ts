import type { ElectronApp } from './app';

/**
 * Main's OS-shell side effects, replaced with recorders so an end-to-end case
 * can prove *what was asked for* without opening a real Explorer window or
 * launching the default browser. Each recorder stores its calls on `globalThis`
 * inside the main process, where the matching reader picks them up; both halves
 * must name the same stub, since a spec that stubs the wrong one silently
 * records nothing.
 */

/** Replaces main's `shell.showItemInFolder` with a recorder. */
export async function stubShowItemInFolder(app: ElectronApp): Promise<void> {
  await app.evaluate(({ shell }) => {
    const scope = globalThis as Record<string, unknown>;
    scope['__revealedPaths'] = [] as string[];
    (shell as unknown as { showItemInFolder: (fullPath: string) => void }).showItemInFolder = (
      fullPath,
    ) => {
      (scope['__revealedPaths'] as string[]).push(fullPath);
    };
  });
}

/** Every path main has asked the OS file manager to reveal, in order. */
export function readRevealedPaths(app: ElectronApp): Promise<string[]> {
  return app.evaluate(
    () => ((globalThis as Record<string, unknown>)['__revealedPaths'] as string[]) ?? [],
  );
}

/** Replaces main's `shell.openExternal` with a recorder, so no browser opens. */
export async function stubOpenExternal(app: ElectronApp): Promise<void> {
  await app.evaluate(({ shell }) => {
    const scope = globalThis as Record<string, unknown>;
    scope['__openedExternalPaths'] = [] as string[];
    (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = (url) => {
      (scope['__openedExternalPaths'] as string[]).push(url);
      return Promise.resolve();
    };
  });
}

/** Every URL main has handed to the OS, in order. */
export function readOpenedExternalPaths(app: ElectronApp): Promise<string[]> {
  return app.evaluate(
    () => ((globalThis as Record<string, unknown>)['__openedExternalPaths'] as string[]) ?? [],
  );
}
