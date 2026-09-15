import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The app's own local UI protocol (implementation-plan.md step 05;
 * requirements-decisions.md section 3: serve the app's own UI from a custom
 * `app://` scheme rather than `file://`).
 *
 * `file://` was rejected for two reasons neither of which is cosmetic:
 *
 *  1. `file://` is Chromium's "universal" scheme for CSP purposes - responses
 *     served from it are not subject to `Content-Security-Policy` the same
 *     way `http(s)`-family/standard custom schemes are, which is exactly the
 *     mechanism `csp.ts` relies on to lock the app UI down. A scheme
 *     registered with `standard: true, secure: true` behaves like a normal
 *     origin for CSP/CORS/fetch purposes, so `installContentSecurityPolicy`'s
 *     header actually applies to it.
 *  2. `file://` navigation has no origin boundary at all between "the app's
 *     own packaged files" and "an arbitrary path on disk" - `isAllowedAppNavigation`
 *     already worked around this by string-prefix-checking every `file://`
 *     URL against `rendererDistDir`, which this module's own path-containment
 *     check (below) still does, but a registered scheme makes "this is our
 *     own origin" a property Chromium itself understands (e.g. for
 *     `webContents.getURL().startsWith("app://")` checks elsewhere), not just
 *     an ad hoc string comparison.
 *
 * `protocol.registerSchemesAsPrivileged` MUST run before `app.whenReady()` -
 * Electron ignores it once Chromium has already started up
 * (see `src/main/index.ts`, which calls {@link registerAppProtocolPrivileges}
 * at module load time, ahead of every `app.setPath` call).
 */
export const APP_PROTOCOL_SCHEME = 'app';

/**
 * The fixed authority segment of every `app://` URL this app serves, e.g.
 * `app://daisy/index.html`. A fixed, checked host (rather than accepting
 * any host under the scheme) means a maliciously crafted `app://other-host/../..`
 * URL cannot even reach the path-containment check below with a host that
 * was never meant to resolve into `rendererDistDir` at all.
 */
export const APP_PROTOCOL_HOST = 'daisy';

/** Must be called at module load time, before `app.whenReady()`. See this module's own doc comment for why. */
export function registerAppProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Builds the `app://` URL for one file under the renderer's dist output, e.g. `index.html` or `settings.html`. */
export function buildAppUrl(relativePath: string): string {
  return `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/${relativePath}`;
}

/**
 * Resolves an `app://` request path to a real file under `rendererDistDir`,
 * refusing to resolve outside it. Exported separately from
 * {@link installAppProtocolHandler} so the path-containment logic itself -
 * the one security-relevant decision in this module - has a direct unit
 * test with no real `protocol.handle`/`net.fetch` involved.
 */
export function resolveAppProtocolFile(
  requestUrl: string,
  rendererDistDir: string,
): { readonly ok: true; readonly filePath: string } | { readonly ok: false } {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== `${APP_PROTOCOL_SCHEME}:` || url.hostname !== APP_PROTOCOL_HOST) {
    return { ok: false };
  }

  const requestedPath = decodeURIComponent(url.pathname);
  const relativePath =
    requestedPath === '/' || requestedPath === '' ? '/index.html' : requestedPath;

  const root = path.resolve(rendererDistDir);
  // `path.join` (not string concatenation) collapses "..", then `path.resolve`
  // makes the result absolute so the startsWith check below cannot be
  // defeated by a relative segment that never got normalized.
  const resolved = path.resolve(root, `.${relativePath}`);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    return { ok: false };
  }
  return { ok: true, filePath: resolved };
}

/**
 * Installs the `app://` request handler. Must be called after
 * `app.whenReady()` (like every other `protocol.handle` call), serving files
 * from `rendererDistDir` (`out/renderer`) - the same directory
 * `isAllowedAppNavigation` already trusted for `file://` loads.
 */
export function installAppProtocolHandler(rendererDistDir: string): void {
  protocol.handle(APP_PROTOCOL_SCHEME, async (request) => {
    const resolved = resolveAppProtocolFile(request.url, rendererDistDir);
    if (!resolved.ok) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved.filePath).toString());
  });
}
