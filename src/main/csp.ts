import { session } from 'electron';

/**
 * Restrictive Content-Security-Policy for every response served to the app's
 * own renderer session (local files in production, the electron-vite dev
 * server in development). No `unsafe-eval` in either mode.
 *
 * `style-src` allows `unsafe-inline`: Spectrum Web Components (Lit) render
 * per-component styles into each shadow root. Electron 44's Chromium supports
 * Constructable Stylesheets, but Lit's `unsafe-inline` style tags are still
 * used for some dynamic/theme-token custom properties applied via the
 * `:host` attribute style bindings, so removing this presently breaks
 * `sp-theme`/`sp-button` visuals. Scripts are never inline and never `eval`.
 */
function buildCsp(allowDevEval: boolean): string {
  const scriptSrc = allowDevEval ? "'self' 'unsafe-eval'" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Installs the CSP response header on the default session. `allowDevEval`
 * must only be true while running under the electron-vite dev server (its
 * HMR client relies on `eval`'d module updates); packaged builds never set it.
 */
export function installContentSecurityPolicy(allowDevEval: boolean): void {
  const csp = buildCsp(allowDevEval);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}
