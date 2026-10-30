import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, type Page } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../../src/shared';
import { launchApp, type ElectronApp } from './app';
import { createScratchDirs, writeSettings } from './profile';
import { byTestId } from '../selectors';

/**
 * A local AEM-shaped fixture for specs that need the pane to load a real page:
 * a loopback HTTP server plus a scratch profile with exactly one host pointing
 * at it, so launching the app and picking that host starts a genuine load.
 *
 * Shared by `shortcuts.spec.ts` and `find-and-zoom.spec.ts`, which both need a
 * loaded, focused AEM view before they can inject input into it.
 */

export interface FixtureServer {
  readonly server: Server;
  readonly origin: string;
  /** Every request path the server has answered, in order. */
  readonly requests: string[];
}

/** One non-HTML response a fixture path answers with (an asset, for instance). */
export interface FixtureResponse {
  readonly contentType: string;
  readonly body: string | Buffer;
  /** Extra response headers, e.g. a `content-disposition` the app must cope with. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FixtureServerOptions {
  /**
   * Answers a request path with its own response instead of the HTML `render`.
   * Return `undefined` to fall through to `render`.
   */
  readonly respond?: (url: string) => FixtureResponse | undefined;
  /** Extra headers sent with every response (e.g. `cache-control: no-store`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A loopback server that answers every path with `render(url)` (recording the paths). */
export async function startFixtureServer(
  render: (url: string) => string,
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    requests.push(url);
    const override = options.respond?.(url);
    if (override !== undefined) {
      res.writeHead(200, {
        'content-type': override.contentType,
        ...options.headers,
        ...override.headers,
      });
      res.end(override.body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...options.headers });
    res.end(render(url));
  });
  return { server, origin: await listenOnLoopback(server), requests };
}

/**
 * Starts an already-built `Server` on a random loopback port and returns its
 * origin. For a fixture whose responses the spec drives itself (holding a
 * request open, for instance) and which therefore cannot be handed to
 * `startFixtureServer`'s always-answering `render`.
 */
export async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server port');
  return `http://127.0.0.1:${String(address.port)}`;
}

export function closeFixtureServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Switches the pane to a configured host through the same IPC the app's own
 * History resume and hosts picker use (not a toolbar click): the specs here
 * need the pane on some host without depending on which host is showing.
 */
export async function switchHost(page: Page, serverId: string): Promise<void> {
  await page.evaluate(async (id: string) => {
    const daisy = Reflect.get(window, 'daisy') as {
      browser: { switchServer(serverId: string): Promise<unknown> };
    };
    await daisy.browser.switchServer(id);
  }, serverId);
}

export interface HostFixture {
  readonly app: ElectronApp;
  readonly page: Page;
  readonly origin: string;
}

/**
 * Seeds one host at `origin`, launches the built app against a fresh scratch
 * home, and picks that host so the AEM view starts a real load (which is what
 * gives it focus later).
 */
export async function seedHostAndLaunch(
  scratchBase: string,
  origin: string,
  label: string,
): Promise<HostFixture> {
  const dirs = createScratchDirs(scratchBase);
  const base = defaultAppSettings();
  writeSettings(
    dirs.home,
    appSettingsSchema.parse({
      ...base,
      hosts: [
        ...base.hosts,
        {
          id: randomUUID(),
          label,
          origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await launchApp(dirs, { fakeAgent: true });
  const page = await app.firstWindow();
  await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
  await expect(page.locator(byTestId('browser-address'))).toBeVisible({ timeout: 30_000 });
  return { app, page, origin };
}
