import { app, session } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { APP_PROTOCOL_HOST, APP_PROTOCOL_SCHEME } from './browser/appProtocol';

/**
 * Returns true when navigating to `targetUrl` should be allowed inside an app
 * BrowserWindow. Only the packaged app's own local UI (the `app://` scheme -
 * step 05 - or, in dev, the electron-vite dev server on localhost) is
 * permitted. Everything else - including remote pages - must open in the
 * system browser via `shell.openExternal`, never inside a window that has our
 * preload attached.
 *
 * `file:` is still recognised for `rendererDistDir` itself so this function
 * stays correct for anything that still resolves a raw `file://` path (e.g. a
 * test fixture); the app's own windows load `app://`, never `file://`,
 * once `windows.ts` is wired to the new protocol.
 */
export function isAllowedAppNavigation(targetUrl: string, rendererDistDir: string): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }

  if (url.protocol === `${APP_PROTOCOL_SCHEME}:`) {
    return url.hostname === APP_PROTOCOL_HOST;
  }

  if (url.protocol === 'file:') {
    const allowedRoot = pathToFileURL(path.join(rendererDistDir, path.sep)).href;
    return url.href.startsWith(allowedRoot);
  }

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    try {
      const devUrl = new URL(devServerUrl);
      return url.origin === devUrl.origin;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Installs the process-wide guard required by the security baseline: block
 * navigation away from the local app UI and deny every `window.open` request
 * by default. Any window that legitimately needs to open a link (e.g. a
 * future "open in browser" action) must do so explicitly through a narrow,
 * reviewed IPC call - not by relaxing this handler.
 *
 * Scoped to `session.defaultSession` webContents only (step 05): the AEM
 * `WebContentsView` deliberately uses a *different* session
 * (`VIEW_SESSION_PARTITION`, `src/main/webview/session.ts`) and has its own,
 * separately reviewed navigation/window-open policy
 * (`src/main/browser/hostView.ts`, `windowOpenRouter.ts`) - reusing
 * *this* deny-everything guard for it would not "extend" that policy, it
 * would replace it, since only one `setWindowOpenHandler` can be active per
 * `WebContents` at a time and this app-wide listener would otherwise
 * overwrite whichever handler was attached second. Checking `.session`
 * (identity, not partition name) is what tells "our own local UI" apart from
 * "remote content" without needing this module to know anything about
 * the browser session's existence beyond importing `session.defaultSession`
 * itself.
 */
export function installWebContentsSecurityGuard(rendererDistDir: string): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.session !== session.defaultSession) {
      return;
    }

    contents.on('will-navigate', (navigationEvent, targetUrl) => {
      if (!isAllowedAppNavigation(targetUrl, rendererDistDir)) {
        navigationEvent.preventDefault();
      }
    });

    contents.setWindowOpenHandler(() => {
      // Deny by default, with no side effects. Handing the URL to
      // `shell.openExternal` here would be exactly the "arbitrary
      // shell.openExternal call" that requirements-decisions.md section 3
      // forbids: a hostile page could otherwise drive the user's OS browser
      // to any address. A legitimate "open in browser" action must be a
      // separate, validated IPC command.
      return { action: 'deny' };
    });
  });
}
