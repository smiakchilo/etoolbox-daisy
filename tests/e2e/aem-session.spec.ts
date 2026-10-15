import { expect, test } from '@playwright/test';
import path from 'node:path';
import {
  AEM_REMEMBER_COOKIE,
  AEM_SESSION_COOKIE,
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  POPUP_COOKIE,
  startAemOrigin,
  startSsoIdp,
  type AemOrigin,
  type SsoIdp,
} from '../integration/support/testAemServer';
import { launchApp } from '../support/e2e/app';
import { createScratchDirs } from '../support/e2e/profile';

/**
 * Step 05 success criteria, executed against the REAL shipped artefacts:
 * the built `out/main/index.js`, the built `out/preload/aem-preload.js`, and
 * the app's own AEM partition name (`persist:aem`, from
 * `src/main/aem/session.ts`). Nothing here re-implements app logic.
 *
 * The plan requires: "Electron E2E fixtures cover the login form and HttpOnly
 * session, SSO redirection to another origin and back, popup flow, ... and two
 * ports on the same hostname. Cookies survive restart and retain normal
 * shared-profile semantics."
 *
 * Proxy selection/407/CONNECT and certificate rejection/replacement are proven
 * separately, against real proxies and real untrusted certificates, in
 * `g3-proxy-scope.spec.ts` and `g3-cert-scope.spec.ts`; this file deliberately
 * does not duplicate them and instead covers the session/auth/cookie matrix
 * those two do not touch.
 *
 * Run with the BUILT app:
 *   npm run build && npx playwright test tests/e2e/aem-session.spec.ts
 */

const aemPreload = path.resolve(__dirname, '../../out/preload/aem-preload.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'aem-session-scratch');

/** The partition `src/main/aem/session.ts` really uses. A different value here would silently test nothing. */
const AEM_PARTITION = 'persist:aem';

interface EvaluateArgs {
  readonly partition: string;
  readonly preload: string;
  readonly aemOrigin: string;
  readonly ssoAemOrigin: string;
  readonly siblingPortOrigin: string;
  readonly username: string;
  readonly password: string;
  readonly sessionCookieName: string;
  readonly rememberCookieName: string;
  readonly popupCookieName: string;
}

test.describe('Step 05: AEM session, authentication and cookie semantics', () => {
  let aem: AemOrigin | undefined;
  let ssoAem: AemOrigin | undefined;
  let sibling: AemOrigin | undefined;
  let idp: SsoIdp | undefined;

  test.afterAll(async () => {
    const closers = [aem, ssoAem, sibling, idp];
    await Promise.all(closers.map(async (server) => server?.close()));
  });

  test('login form, HttpOnly session, SSO round trip, popup, sibling port, and survival across restart', async () => {
    test.setTimeout(180_000);

    idp = await startSsoIdp({ sharedSecret: 'daisy-step05-secret' });
    aem = await startAemOrigin();
    ssoAem = await startAemOrigin({
      sso: { origin: idp.origin, sharedSecret: 'daisy-step05-secret' },
    });
    sibling = await startAemOrigin();

    const profile = createScratchDirs(scratchBase);
    const args: EvaluateArgs = {
      partition: AEM_PARTITION,
      preload: aemPreload,
      aemOrigin: aem.origin,
      ssoAemOrigin: ssoAem.origin,
      siblingPortOrigin: sibling.origin,
      username: FIXTURE_USERNAME,
      password: FIXTURE_PASSWORD,
      sessionCookieName: AEM_SESSION_COOKIE,
      rememberCookieName: AEM_REMEMBER_COOKIE,
      popupCookieName: POPUP_COOKIE,
    };

    // ---------------------------------------------------------------- launch 1
    const first = await launchApp(profile);
    const report = await first.evaluate(
      async ({ session, BrowserWindow, WebContentsView: View }, input: EvaluateArgs) => {
        const marks: string[] = [];
        /**
         * Every await in this block is bounded and named. Without this a single
         * event that never fires turns the whole spec into an opaque 180s
         * Playwright timeout with no indication of which phase stalled.
         */
        const step = async <T>(label: string, work: Promise<T>, ms = 20_000): Promise<T> => {
          let timer: NodeJS.Timeout | undefined;
          try {
            const result = await Promise.race([
              work,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), ms);
              }),
            ]);
            marks.push(label);
            return result;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        };

        try {
          const aemSession = session.fromPartition(input.partition);

          const host = new BrowserWindow({ show: false, width: 1024, height: 768 });
          const view = new View({
            webPreferences: {
              session: aemSession,
              preload: input.preload,
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
            },
          });
          host.contentView.addChildView(view);
          view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
          const wc = view.webContents;

          const settled = (): Promise<void> =>
            new Promise((resolve) => {
              wc.once('did-finish-load', () => resolve());
            });

          const text = async (selector: string): Promise<string> => {
            const script = `document.querySelector(${JSON.stringify(selector)})?.textContent ?? "(missing)"`;
            const value: unknown = await wc.executeJavaScript(script);
            return typeof value === 'string' ? value : '(non-string)';
          };

          const signIn = async (label: string): Promise<void> => {
            const done = settled();
            // `f.submit()` does NOT work here, and the reason is worth recording:
            // the fixture's submit button has id="submit", and HTML form
            // named-element access makes `form.submit` resolve to that BUTTON
            // rather than to HTMLFormElement.prototype.submit. Calling it throws
            // "f.submit is not a function" - synchronously that surfaces as
            // Electron's opaque "Script failed to execute"; deferred it is
            // swallowed and the navigation simply never happens. Clicking the
            // button is both unambiguous and closer to what a user does.
            const submitted: Promise<unknown> = wc.executeJavaScript(`
            (() => {
              const u = document.getElementById("username");
              const p = document.getElementById("password");
              const f = document.getElementById("login-form");
              if (!u || !p || !f) return "no-form";
              u.value = ${JSON.stringify(input.username)};
              p.value = ${JSON.stringify(input.password)};
              const button = document.getElementById("submit");
              setTimeout(() => {
                if (button) button.click();
                else HTMLFormElement.prototype.submit.call(f);
              }, 0);
              return "submitted";
            })()
          `);
            const outcome = await step(`${label}: fill form`, submitted);
            if (outcome !== 'submitted') {
              throw new Error(
                `${label}: expected a login form, got ${String(outcome)} at ${wc.getURL()}`,
              );
            }
            await step(`${label}: navigation settled`, done);
          };

          // -- A. Protected content redirects to the login form ------------------
          await step('A: load protected content', wc.loadURL(`${input.aemOrigin}/content/site`));
          const loginUrl = wc.getURL();
          const loginHeading = await text('#login-heading');

          // -- B. Signing in mints a session and returns to the requested page ---
          await signIn('B');
          const afterLoginUrl = wc.getURL();
          const afterLoginHeading = await text('#aem-heading');
          const afterLoginPath = await text('#aem-path');

          // -- C. The session cookie is HttpOnly ---------------------------------
          // The fixture page itself reports LEAKED if document.cookie can see it.
          const scriptVisibility = await text('#cookie-visible-to-script');
          const rawDocumentCookie: unknown = await wc.executeJavaScript('document.cookie');
          const cookiesViaPrivilegedApi = await aemSession.cookies.get({
            name: input.sessionCookieName,
          });

          // -- D. The AEM page cannot reach the app's IPC bridge ------------------
          const ipcReach: unknown = await wc.executeJavaScript(`
          JSON.stringify({
            daisy: typeof window.daisy,
            require: typeof window.require,
            process: typeof window.process,
          })
        `);

          // -- E. SSO: redirect to a DIFFERENT origin and back --------------------
          await step(
            'E: load SSO-protected page',
            wc.loadURL(`${input.ssoAemOrigin}/content/sso-page`),
          );
          const atIdpUrl = wc.getURL();
          // The IdP is a *different origin* loaded into the same view, and the
          // plan requires that it too cannot reach app IPC. Probed separately
          // from phase D rather than assumed to follow from it.
          const idpIpcReach: unknown = await wc.executeJavaScript(`
          JSON.stringify({
            daisy: typeof window.daisy,
            require: typeof window.require,
            process: typeof window.process,
          })
        `);
          await signIn('E');
          const afterSsoUrl = wc.getURL();
          const afterSsoHeading = await text('#aem-heading');

          // -- F. Popup flow ------------------------------------------------------
          // This harness creates the popup itself (the app routes bare
          // `window.open`/`target="_blank"` requests into the pane view instead
          // - see `windowOpenRouter.ts`) with no preload, so the assertion
          // below is about what an AEM-opened window in this session can see.
          wc.setWindowOpenHandler(() => ({
            action: 'allow',
            overrideBrowserWindowOptions: {
              show: false,
              webPreferences: {
                session: aemSession,
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
              },
            },
          }));
          const popupAppeared = new Promise<Electron.BrowserWindow>((resolve) => {
            wc.once('did-create-window', (window) => resolve(window));
          });
          await step('F: load popup launcher', wc.loadURL(`${input.aemOrigin}/popup-launcher`));
          await step(
            'F: click open-popup',
            wc.executeJavaScript(`document.getElementById("open-popup").click(); "clicked"`),
          );
          const popupWindow = await step('F: popup window created', popupAppeared);
          if (popupWindow.webContents.isLoading()) {
            await step(
              'F: popup finished loading',
              new Promise<void>((resolve) => {
                popupWindow.webContents.once('did-finish-load', () => resolve());
              }),
            );
          }
          const popupUrl = popupWindow.webContents.getURL();
          const statusValue: unknown = await popupWindow.webContents.executeJavaScript(
            `document.getElementById("popup-status")?.textContent ?? "(missing)"`,
          );
          const popupStatus = typeof statusValue === 'string' ? statusValue : '(non-string)';
          const bridgeValue: unknown =
            await popupWindow.webContents.executeJavaScript(`typeof window.daisy`);
          const popupBridge = typeof bridgeValue === 'string' ? bridgeValue : '(non-string)';
          const popupCookies = await aemSession.cookies.get({ name: input.popupCookieName });
          popupWindow.destroy();

          // -- G. A sibling origin on a DIFFERENT PORT, same hostname -------------
          // Recorded, not assumed: HTTP cookies are host-scoped, not port-scoped.
          await step('G: load sibling port', wc.loadURL(`${input.siblingPortOrigin}/whoami`));
          const siblingWhoami = await text('body');

          // -- H. Same-host cookie collision, measured rather than assumed --------
          // All three fixture origins are `localhost` on different ports, and HTTP
          // cookies are host-scoped, NOT port-scoped. The SSO sign-in in E
          // therefore overwrote the shared login-token that B had minted for the
          // primary origin. That is genuine "normal shared-profile semantics" and
          // is exactly what an AEM author would hit running two instances on one
          // host, so it is asserted instead of engineered away. The primary
          // session is then re-established so the restart check below has an
          // unambiguous origin to verify.
          await step('H: return to primary origin', wc.loadURL(`${input.aemOrigin}/content/site`));
          const primaryUrlAfterSso = wc.getURL();
          if (primaryUrlAfterSso.includes('/login')) {
            await signIn('H');
          }
          const primaryHeadingRestored = await text('#aem-heading');

          const cookieHostsForSession = (
            await aemSession.cookies.get({ name: input.sessionCookieName })
          ).map((cookie) => ({
            domain: cookie.domain,
            path: cookie.path,
            httpOnly: cookie.httpOnly,
          }));

          host.destroy();

          return {
            loginUrl,
            loginHeading,
            afterLoginUrl,
            afterLoginHeading,
            afterLoginPath,
            scriptVisibility,
            rawDocumentCookie: typeof rawDocumentCookie === 'string' ? rawDocumentCookie : '(n/a)',
            privilegedCookieCount: cookiesViaPrivilegedApi.length,
            ipcReach: typeof ipcReach === 'string' ? ipcReach : '(n/a)',
            idpIpcReach: typeof idpIpcReach === 'string' ? idpIpcReach : '(n/a)',
            atIdpUrl,
            afterSsoUrl,
            afterSsoHeading,
            popupUrl,
            popupStatus,
            popupBridge,
            popupCookieCount: popupCookies.length,
            siblingWhoami,
            primaryUrlAfterSso,
            primaryHeadingRestored,
            cookieHostsForSession,
            failure: '',
            marks,
          };
        } catch (error) {
          return {
            loginUrl: '',
            loginHeading: '',
            afterLoginUrl: '',
            afterLoginHeading: '',
            afterLoginPath: '',
            scriptVisibility: '',
            rawDocumentCookie: '',
            privilegedCookieCount: 0,
            ipcReach: '',
            idpIpcReach: '',
            atIdpUrl: '',
            afterSsoUrl: '',
            afterSsoHeading: '',
            popupUrl: '',
            popupStatus: '',
            popupBridge: '',
            popupCookieCount: 0,
            siblingWhoami: '',
            primaryUrlAfterSso: '',
            primaryHeadingRestored: '',
            cookieHostsForSession: [] as { domain: string; path: string; httpOnly: boolean }[],
            failure:
              error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
            marks,
          };
        }
      },
      args,
    );

    console.error('LAUNCH 1:', JSON.stringify(report, null, 2));
    await first.close();
    expect(report.failure).toBe('');

    // A. protected content bounced to the login form
    expect(report.loginUrl).toContain('/login');
    expect(report.loginHeading).toBe('Sign in');

    // B. signing in returned to the originally requested path
    expect(report.afterLoginHeading).toBe('AEM content');
    expect(report.afterLoginPath).toBe('/content/site');

    // C. the session cookie is HttpOnly: invisible to page script, visible to the app
    expect(report.scriptVisibility).toBe('hidden');
    expect(report.rawDocumentCookie).not.toContain(AEM_SESSION_COOKIE);
    expect(report.privilegedCookieCount).toBeGreaterThan(0);

    // D. AEM content has no route to the app's IPC bridge
    expect(report.ipcReach).toBe(
      JSON.stringify({ daisy: 'undefined', require: 'undefined', process: 'undefined' }),
    );

    // E. SSO left the AEM origin for the IdP, then came back authenticated
    expect(report.atIdpUrl.startsWith(idp.origin)).toBe(true);
    // ...and the IdP origin has no route to the app's IPC bridge either.
    expect(report.idpIpcReach).toBe(
      JSON.stringify({ daisy: 'undefined', require: 'undefined', process: 'undefined' }),
    );
    expect(report.afterSsoUrl.startsWith(ssoAem.origin)).toBe(true);
    expect(report.afterSsoHeading).toBe('AEM content');

    // F. the popup really opened, and carries no privileged bridge
    expect(report.popupUrl).toContain('/popup');
    expect(report.popupStatus).toBe('popup-loaded');
    expect(report.popupBridge).toBe('undefined');
    expect(report.popupCookieCount).toBeGreaterThan(0);

    // G. shared-profile semantics, asserted as measured rather than as assumed
    expect(report.cookieHostsForSession.every((cookie) => cookie.httpOnly)).toBe(true);

    // H. a same-host sign-in on a different PORT shares one cookie jar, so the
    // SSO login displaced the primary origin's token and the primary origin
    // asked for credentials again. Recorded because it is the behaviour a user
    // running two AEM instances on one host will actually see.
    expect(report.primaryUrlAfterSso).toContain('/login');
    expect(report.primaryHeadingRestored).toBe('AEM content');

    // ---------------------------------------------------------------- launch 2
    const second = await launchApp(profile);
    const afterRestart = await second.evaluate(
      async ({ session, BrowserWindow, WebContentsView: View }, input: EvaluateArgs) => {
        const aemSession = session.fromPartition(input.partition);
        const host = new BrowserWindow({ show: false, width: 800, height: 600 });
        const view = new View({
          webPreferences: {
            session: aemSession,
            preload: input.preload,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        });
        host.contentView.addChildView(view);
        const wc = view.webContents;

        const persisted = await aemSession.cookies.get({ name: input.rememberCookieName });
        const sessionScoped = await aemSession.cookies.get({ name: input.sessionCookieName });

        await wc.loadURL(`${input.aemOrigin}/content/after-restart`);
        const url = wc.getURL();
        const headingValue: unknown = await wc.executeJavaScript(
          `document.querySelector("#aem-heading")?.textContent ?? "(missing)"`,
        );
        const whoamiValue: unknown = await wc.executeJavaScript(
          `fetch("/whoami", { credentials: "include" }).then((r) => r.text())`,
        );

        host.destroy();
        return {
          persistedCookieCount: persisted.length,
          sessionCookieCount: sessionScoped.length,
          url,
          heading: typeof headingValue === 'string' ? headingValue : '(n/a)',
          whoami: typeof whoamiValue === 'string' ? whoamiValue : '(n/a)',
        };
      },
      args,
    );

    console.error('LAUNCH 2 (after restart):', JSON.stringify(afterRestart, null, 2));
    await second.close();

    // The shared AEM profile survived a full application restart: the
    // persistent login-token was reloaded from disk and no second sign-in was
    // required.
    //
    // Deliberate deviation from Chromium's default (see
    // `src/main/aem/sessionCookiePersistence.ts` and docs/verification.md,
    // "AEM session cookies for non-TLS hosts now survive restart"): the
    // fixture's *session* cookie is set over plain HTTP and carries no
    // `Max-Age`, so Chromium would normally discard it on exit. The app now
    // promotes insecure session cookies to persistent ones, so it is reloaded
    // too. A `Secure` session cookie (the HTTPS case) is still left to die on
    // restart - that half is covered directly in the unit tests, since this
    // spec's origins are all plain HTTP.
    expect(afterRestart.persistedCookieCount).toBeGreaterThan(0);
    expect(afterRestart.sessionCookieCount).toBeGreaterThan(0);
    expect(afterRestart.url).not.toContain('/login');
    expect(afterRestart.heading).toBe('AEM content');
    expect(afterRestart.whoami).toContain(`"authenticated":true`);
    expect(afterRestart.whoami).toContain(FIXTURE_USERNAME);
  });
});
