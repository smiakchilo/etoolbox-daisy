import { expect } from '@playwright/test';
import type { ElectronApp } from './app';

/**
 * Helpers for a spec that drives the AEM pane's *separate* `WebContents`.
 *
 * The AEM pane is a `WebContentsView`, so it is not part of the shell `Page`:
 * a spec reaches it through `app.evaluate` (which runs inside the Electron main
 * process) and injects input with `WebContents.sendInputEvent`. That detail is
 * load-bearing for any input test: a Playwright `page.keyboard`/`page.mouse`
 * event is a CDP event and never passes through main's `before-input-event`
 * (see `devtools.spec.ts`), whereas the app's shortcuts are matched exactly
 * there.
 */

/** The AEM view's WebContents id, found by its committed origin. */
export async function findHostViewId(app: ElectronApp, origin: string): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const id = await app.evaluate(({ webContents }, prefix: string) => {
      return webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix))?.id ?? -1;
    }, origin);
    if (id !== -1) return id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('AEM view not found');
}

/** The AEM view's own `isLoading()` flag, read from main. */
export function viewIsLoading(app: ElectronApp, hostViewId: number): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, id: number) => webContents.fromId(id)?.isLoading() ?? false,
    hostViewId,
  );
}

/**
 * Waits until the AEM view has finished loading. The address bar updates on
 * `did-start-navigation`, i.e. *before* the load settles, so a key pressed right
 * after an address assertion can otherwise land mid-load.
 */
export async function waitForViewIdle(app: ElectronApp, hostViewId: number): Promise<void> {
  await expect.poll(() => viewIsLoading(app, hostViewId), { timeout: 30_000 }).toBe(false);
}

/**
 * Injects one keystroke into `target`'s `WebContents` from main, as the real
 * input pipeline would, and returns whether that WebContents took focus.
 */
export function pressOn(
  app: ElectronApp,
  target: 'shell' | 'host',
  hostViewId: number,
  keyCode: string,
  modifiers: ('control' | 'alt' | 'shift' | 'meta')[],
): Promise<boolean> {
  return app.evaluate(
    (
      { BrowserWindow, webContents },
      args: {
        target: string;
        id: number;
        keyCode: string;
        modifiers: ('control' | 'alt' | 'shift' | 'meta')[];
      },
    ) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.focus();
      const contents = args.target === 'shell' ? win?.webContents : webContents.fromId(args.id);
      if (!contents) throw new Error(`no ${args.target} webContents`);
      contents.focus();
      contents.sendInputEvent({
        type: 'keyDown',
        keyCode: args.keyCode,
        modifiers: args.modifiers,
      });
      contents.sendInputEvent({ type: 'keyUp', keyCode: args.keyCode, modifiers: args.modifiers });
      return contents.isFocused();
    },
    { target, id: hostViewId, keyCode, modifiers },
  );
}
