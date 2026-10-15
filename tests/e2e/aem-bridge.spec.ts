import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  AEM_SESSION_COOKIE,
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  startAemOrigin,
  startSsoIdp,
  type AemOrigin,
  type SsoIdp,
} from '../integration/support/testAemServer';
import {
  AEM_BRIDGE_CANCEL_CHANNEL,
  AEM_BRIDGE_FETCH_CHANNEL,
  AEM_BRIDGE_REPLY_CHANNEL,
  type AemBridgeCancelCommand,
  type AemBridgeFetchCommand,
  type AemBridgeReply,
} from '../../src/shared/contracts/aemBridge';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import { createScratchDirs } from '../support/e2e/profile';

/**
 * Step 06 "private bridge" success criteria, proven end-to-end against the
 * REAL shipped artefacts: the built `out/main/index.js` and
 * `out/preload/aem-preload.js`, driven by the real fixture AEM/SSO servers in
 * `tests/integration/support/testAemServer.ts`. Nothing here re-implements
 * `src/preload/bridgeFetch.ts`'s decision logic; every assertion is made
 * against a reply the shipped preload actually produced.
 *
 * `src/main` does not yet wire anything onto the three bridge channels - that
 * is Step 07's job (`src/shared/contracts/aemBridge.ts` frames this bridge as
 * strictly "main -> preload -> main", and no broker currently owns the main
 * side). So `ipcMain` is unopposed here: this file plays the role of "main"
 * directly, sending `aem-bridge:fetch` / `aem-bridge:cancel` and listening for
 * `aem-bridge:reply` from inside `application.evaluate()`, which runs in the
 * real Electron main process with full `electron` access.
 *
 * Proven here, end-to-end, against the real preload:
 *  - the AEM session cookie is HttpOnly and travels with a bridge fetch, but
 *    the cookie value and any Set-Cookie/Cookie header never reach this
 *    process. The reply's readable-headers list (added for the tool HTTP log,
 *    commit 9a79dae) is browser-filtered: `Set-Cookie`/`Cookie` are
 *    forbidden names the fetch implementation never exposes, so no cookie can
 *    appear in it (tests 1, 2);
 *  - `redirect: "manual"` really yields a `redirect_blocked` opaque-redirect
 *    outcome in this Electron/Chromium build, both for an unauthenticated
 *    same-origin request and for a mid-fetch redirect to a different origin -
 *    this was previously only an assumption (tests 3, 9);
 *  - the preload's own origin re-check refuses a cross-origin command even
 *    though main built the URL (test 10);
 *  - Sling's non-2xx-but-parses-as-JSON shapes (300 array, HTML for `.json`,
 *    truncated JSON) are surfaced as raw status/contentType/bodyText, never
 *    silently accepted as the resource (tests 4-8);
 *  - a >1 MiB payload passes through with no byte cap (test 11);
 *  - cancelling and navigating away both silently prevent any reply, without
 *    crashing the app (tests 12, 13);
 *  - a duplicate requestId is ignored (test 15);
 *  - the page's own main world is given nothing at all: no bridge object, no
 *    `daisy`, no `require`/`ipcRenderer` (test 14).
 *
 * Deliberately NOT proven here, because they are properties of the future
 * broker rather than of the preload/wire protocol, and are already proven
 * with injectable seams in `tests/unit/main/aem/`:
 *  - the 90,000 ms per-request timeout (a unit test injects a fake clock
 *    rather than waiting 90 real seconds);
 *  - concurrency-exactly-1 queueing of multiple requests;
 *  - navigation-epoch staleness, i.e. a reply for a request issued before the
 *    view last navigated is discarded;
 *  - main-side sender trust, i.e. a reply from an untrusted
 *    WebFrameMain/origin is ignored.
 * This is a deliberate split, not an omission: there is no real broker wired
 * to `ipcMain` yet for this file to drive end-to-end (that is Step 07), so
 * those properties can only be exercised against the broker directly - with a
 * fake clock and a fake sender - until then.
 *
 * Run with the BUILT app (this file never runs the build itself):
 *   npx playwright test tests/e2e/aem-bridge.spec.ts
 */

const aemPreload = path.resolve(__dirname, '../../out/preload/aem-preload.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'aem-bridge-scratch');

/** Distinct partitions per scenario group so signed-in state never leaks between them. */
const AUTH_PARTITION = 'persist:aem-bridge-auth';
const UNAUTH_PARTITION = 'persist:aem-bridge-unauth';
const SSO_PARTITION = 'persist:aem-bridge-sso';
const NAV_PARTITION = 'persist:aem-bridge-nav';

/** Ample for a fixture that answers over localhost with no artificial delay. */
const BRIDGE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// View plumbing: create a real AEM WebContentsView (with the real shipped
// preload) inside the main process, and address it from later, independent
// `application.evaluate()` calls.
//
// The task's own suggestion - filter `webContents.getAllWebContents()` by
// URL - was tried first and rejected: several tests here deliberately
// navigate a view to a DIFFERENT origin (the SSO round trip, and the
// "navigation destroys in-flight work" test), so a URL-based filter would
// stop finding the right view the moment it matters most. `webContents.id`
// is a stable numeric handle Electron guarantees not to reuse for the
// lifetime of the process, so `webContents.fromId(id)` keeps addressing the
// same view across origins and across separate `evaluate()` calls (closures
// do not survive the process boundary between calls, so this id is the only
// thing threaded through `evaluate()`'s `arg` parameter from here on).
// ---------------------------------------------------------------------------

interface CreateViewArgs {
  readonly partition: string;
  readonly preload: string;
}

interface AemView {
  readonly webContentsId: number;
}

function createAemView(app: ElectronApp, args: CreateViewArgs): Promise<AemView> {
  return app.evaluate(
    ({ session, BrowserWindow, WebContentsView: View }, input: CreateViewArgs) => {
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
      return { webContentsId: view.webContents.id };
    },
    args,
  );
}

interface LoadUrlArgs {
  readonly webContentsId: number;
  readonly url: string;
  readonly timeoutMs: number;
}

async function loadUrl(
  app: ElectronApp,
  args: { readonly webContentsId: number; readonly url: string },
  timeoutMs = 20_000,
): Promise<void> {
  const evalArgs: LoadUrlArgs = { ...args, timeoutMs };
  await app.evaluate(async ({ webContents }, input: LoadUrlArgs) => {
    const target = webContents.fromId(input.webContentsId);
    if (target === undefined) {
      throw new Error(`loadUrl: webContents ${input.webContentsId} no longer exists`);
    }
    const done = new Promise<void>((resolve) => {
      target.once('did-finish-load', () => resolve());
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`loadUrl: timed out waiting for ${input.url} to finish loading`)),
        input.timeoutMs,
      );
    });
    try {
      await target.loadURL(input.url);
      await Promise.race([done, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, evalArgs);
}

interface SubmitLoginArgs {
  readonly webContentsId: number;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
}

/**
 * Fills and submits the fixture's login form, whichever origin it is
 * currently hosted on (the local AEM login page and the SSO IdP's login page
 * share the same markup - `loginFormHtml` in the fixture server).
 *
 * `form.submit()` deliberately is NOT used: the form's submit button has
 * `id="submit"`, and HTML named-element access makes `form.submit` resolve to
 * that BUTTON element rather than to `HTMLFormElement.prototype.submit` -
 * calling it throws. This is documented and worked around identically in
 * `aem-session.spec.ts`; clicking the button is unambiguous and closer
 * to what a real user does.
 */
async function submitLoginForm(
  app: ElectronApp,
  args: { readonly webContentsId: number; readonly username: string; readonly password: string },
  timeoutMs = 20_000,
): Promise<void> {
  const evalArgs: SubmitLoginArgs = { ...args, timeoutMs };
  await app.evaluate(async ({ webContents }, input: SubmitLoginArgs) => {
    const target = webContents.fromId(input.webContentsId);
    if (target === undefined) {
      throw new Error(`submitLoginForm: webContents ${input.webContentsId} no longer exists`);
    }

    const done = new Promise<void>((resolve) => {
      target.once('did-finish-load', () => resolve());
    });

    const script = `
      (() => {
        const u = document.getElementById("username");
        const p = document.getElementById("password");
        const f = document.getElementById("login-form");
        if (!u || !p || !f) return "no-form";
        u.value = ${JSON.stringify(input.username)};
        p.value = ${JSON.stringify(input.password)};
        const button = document.getElementById("submit");
        setTimeout(() => { if (button) button.click(); }, 0);
        return "submitted";
      })()
    `;
    const raw: Promise<unknown> = target.executeJavaScript(script);
    const outcome = await raw;
    if (outcome !== 'submitted') {
      throw new Error(
        `submitLoginForm: expected a login form, got ${String(outcome)} at ${target.getURL()}`,
      );
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('submitLoginForm: timed out waiting for post-login navigation')),
        input.timeoutMs,
      );
    });
    try {
      await Promise.race([done, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, evalArgs);
}

interface ReadElementTextArgs {
  readonly webContentsId: number;
  readonly selector: string;
}

async function readElementText(app: ElectronApp, args: ReadElementTextArgs): Promise<string> {
  return app.evaluate(async ({ webContents }, input: ReadElementTextArgs) => {
    const target = webContents.fromId(input.webContentsId);
    if (target === undefined) {
      throw new Error(`readElementText: webContents ${input.webContentsId} no longer exists`);
    }
    const script = `document.querySelector(${JSON.stringify(input.selector)})?.textContent ?? "(missing)"`;
    const raw: Promise<unknown> = target.executeJavaScript(script);
    const value = await raw;
    return typeof value === 'string' ? value : '(non-string)';
  }, args);
}

interface ReadTypeofsArgs {
  readonly webContentsId: number;
  readonly keys: readonly string[];
}

/**
 * Reads `typeof window[key]` for each key, one `executeJavaScript` round trip
 * per key. This is test 14's probe of the page's main world: everything is
 * read back as a primitive string, never as a live reference, because a page
 * hosting remote AEM content must not be trusted to serialize its own state
 * honestly for anything richer than that.
 */
async function readPageTypeofs(
  app: ElectronApp,
  args: ReadTypeofsArgs,
): Promise<Record<string, string>> {
  return app.evaluate(async ({ webContents }, input: ReadTypeofsArgs) => {
    const target = webContents.fromId(input.webContentsId);
    if (target === undefined) {
      throw new Error(`readPageTypeofs: webContents ${input.webContentsId} no longer exists`);
    }
    const result: Record<string, string> = {};
    for (const key of input.keys) {
      const script = `typeof window[${JSON.stringify(key)}]`;
      const raw: Promise<unknown> = target.executeJavaScript(script);
      const value = await raw;
      result[key] = typeof value === 'string' ? value : '(non-string)';
    }
    return result;
  }, args);
}

// ---------------------------------------------------------------------------
// The bridge helper itself.
// ---------------------------------------------------------------------------

interface BridgeFetchArgs {
  readonly webContentsId: number;
  readonly command: AemBridgeFetchCommand;
  readonly timeoutMs: number;
  readonly fetchChannel: string;
  readonly replyChannel: string;
}

interface BridgeFetchTimeout {
  readonly kind: 'timeout';
}

/**
 * Drives the real, shipped `aem-preload.ts` exactly the way main eventually
 * will (Step 07): send `aem-bridge:fetch` at the target view, and await
 * exactly one `aem-bridge:reply` on `ipcMain`. Everything else in this file
 * that needs a single request/reply round trip goes through this helper.
 *
 * The `ipcMain.once` here is deliberately a ONE-SHOT listener registered
 * strictly to observe the affirmative reply this call itself provoked - it is
 * never invoked manually, and it is always paired with a real timeout so a
 * hang fails fast with a clear message instead of stalling the whole suite.
 *
 * The channel name constants are read from the real contract module and
 * threaded through `evaluate()`'s `arg`, because a callback given to
 * `evaluate()` cannot close over anything from this file's outer scope - it
 * runs in a separate process, addressed only by what is passed as `arg`.
 */
async function bridgeFetch(
  app: ElectronApp,
  args: {
    readonly webContentsId: number;
    readonly url: string;
    readonly requestId: string;
    readonly timeoutMs?: number;
  },
): Promise<AemBridgeReply | BridgeFetchTimeout> {
  const evalArgs: BridgeFetchArgs = {
    webContentsId: args.webContentsId,
    command: { requestId: args.requestId, url: args.url },
    timeoutMs: args.timeoutMs ?? BRIDGE_TIMEOUT_MS,
    fetchChannel: AEM_BRIDGE_FETCH_CHANNEL,
    replyChannel: AEM_BRIDGE_REPLY_CHANNEL,
  };

  return app.evaluate(async ({ ipcMain, webContents }, input: BridgeFetchArgs) => {
    const target = webContents.fromId(input.webContentsId);
    if (target === undefined) {
      throw new Error(`bridgeFetch: webContents ${input.webContentsId} no longer exists`);
    }

    return new Promise<AemBridgeReply | BridgeFetchTimeout>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ kind: 'timeout' });
      }, input.timeoutMs);

      // A single request in flight per call, so the first message on this
      // channel after `send` below is unambiguously the answer to it. Several
      // requests racing on this channel at once (the broker's own
      // request/reply matching) is proven separately, with an injectable
      // clock, in tests/unit/main/aem/.
      ipcMain.once(input.replyChannel, (_event: unknown, reply: AemBridgeReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(reply);
      });

      target.send(input.fetchChannel, input.command);
    });
  }, evalArgs);
}

// ---------------------------------------------------------------------------
// A lower-level primitive for tests that must prove the ABSENCE of a reply,
// or that exactly one reply arrives among several commands sent back-to-back
// (cancellation, navigation, duplicate requestId).
// ---------------------------------------------------------------------------

interface BridgeCommandEntry {
  readonly channel: 'fetch' | 'cancel';
  readonly command: AemBridgeFetchCommand | AemBridgeCancelCommand;
}

interface CollectRepliesArgs {
  readonly webContentsId: number;
  readonly commands: readonly BridgeCommandEntry[];
  readonly navigateTo?: string;
  readonly windowMs: number;
  readonly fetchChannel: string;
  readonly cancelChannel: string;
  readonly replyChannel: string;
}

interface CollectRepliesResult {
  readonly replies: readonly AemBridgeReply[];
}

/**
 * Sends every command in `commands` to the target view synchronously,
 * back-to-back with no `await` between them, then (optionally) navigates the
 * view elsewhere, then waits `windowMs` collecting every reply that arrives
 * on `aem-bridge:reply`. Sending without awaiting in between is what makes
 * the race deterministic: IPC dispatch and the preload's synchronous
 * bookkeeping (registering an `AbortController`, checking `inFlight`) run to
 * completion long before a real network round trip over localhost could
 * resolve, so a cancel or a second identical command always lands before the
 * first fetch's response does.
 */
async function collectBridgeReplies(
  app: ElectronApp,
  args: {
    readonly webContentsId: number;
    readonly commands: readonly BridgeCommandEntry[];
    readonly navigateTo?: string;
    readonly windowMs: number;
  },
): Promise<CollectRepliesResult> {
  const evalArgs: CollectRepliesArgs = {
    ...args,
    fetchChannel: AEM_BRIDGE_FETCH_CHANNEL,
    cancelChannel: AEM_BRIDGE_CANCEL_CHANNEL,
    replyChannel: AEM_BRIDGE_REPLY_CHANNEL,
  };

  return app.evaluate(async ({ ipcMain, webContents }, input: CollectRepliesArgs) => {
    const target = webContents.fromId(input.webContentsId);
    if (target === undefined) {
      throw new Error(`collectBridgeReplies: webContents ${input.webContentsId} no longer exists`);
    }

    const replies: AemBridgeReply[] = [];
    const handler = (_event: unknown, reply: AemBridgeReply): void => {
      replies.push(reply);
    };
    ipcMain.on(input.replyChannel, handler);

    try {
      for (const entry of input.commands) {
        const channel = entry.channel === 'fetch' ? input.fetchChannel : input.cancelChannel;
        target.send(channel, entry.command);
      }

      if (input.navigateTo !== undefined) {
        const done = new Promise<void>((resolve) => {
          target.once('did-finish-load', () => resolve());
        });
        await target.loadURL(input.navigateTo);
        await done;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, input.windowMs);
      });
    } finally {
      ipcMain.removeListener(input.replyChannel, handler);
    }

    return { replies };
  }, evalArgs);
}

// ---------------------------------------------------------------------------
// JSON parsing helpers with no `as`/`as any`/`as unknown as` anywhere: each
// narrows via a type predicate or an explicit throw, never a cast.
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) {
    throw new Error(`expected a JSON object, got: ${text.slice(0, 200)}`);
  }
  return parsed;
}

function parseJsonArray(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`expected a JSON array, got: ${text.slice(0, 200)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// One Electron app for the whole file. Fixture servers and views are scoped
// per describe block below, each stopped/destroyed in its own `afterAll`.
// ---------------------------------------------------------------------------

test.describe('Step 06: AEM private bridge (driven directly over IPC)', () => {
  let application: ElectronApp;

  test.beforeAll(async () => {
    const profile = createScratchDirs(scratchBase);
    application = await launchApp(profile);
  });

  test.afterAll(async () => {
    await application.close();
  });

  test.describe('authenticated bridge fetches', () => {
    let aem: AemOrigin;
    let authView: AemView;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      aem = await startAemOrigin();
      authView = await createAemView(application, {
        partition: AUTH_PARTITION,
        preload: aemPreload,
      });
      await loadUrl(application, {
        webContentsId: authView.webContentsId,
        url: `${aem.origin}/content/site`,
      });
      await submitLoginForm(application, {
        webContentsId: authView.webContentsId,
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
      });
    });

    test.afterAll(async () => {
      await aem.close();
    });

    test('1. HttpOnly cookie is invisible to the page, and an authenticated bridge fetch round-trips UTF-8 intact', async () => {
      const cookieVisibility = await readElementText(application, {
        webContentsId: authView.webContentsId,
        selector: '#cookie-visible-to-script',
      });
      expect(cookieVisibility).toBe('hidden');

      const reply = await bridgeFetch(application, {
        webContentsId: authView.webContentsId,
        url: `${aem.origin}/content/site.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'response') {
        throw new Error(`expected a response reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.status).toBe(200);
      const body = parseJsonObject(reply.bodyText);
      expect(body['jcr:primaryType']).toBe('cq:Page');
      // Proves UTF-8 survives preload -> fetch -> IPC -> this process intact.
      expect(body['unicode']).toBe('проверка');
    });

    test('2. the session cookie reaches the server but never reaches the main process', async () => {
      const logCountBefore = aem.log.length;
      const reply = await bridgeFetch(application, {
        webContentsId: authView.webContentsId,
        url: `${aem.origin}/content/site.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'response') {
        throw new Error(`expected a response reply, got: ${JSON.stringify(reply)}`);
      }

      // The reply schema's "response" variant has exactly these six fields.
      // `headers` is the response's *readable* headers, for the tool HTTP log
      // (commit 9a79dae); the browser withholds `Set-Cookie`/`Cookie` from it,
      // so there is still nowhere for the session cookie to hide.
      expect(Object.keys(reply).sort()).toEqual([
        'bodyText',
        'contentType',
        'headers',
        'kind',
        'requestId',
        'status',
      ]);
      const serialized = JSON.stringify(reply);
      expect(serialized).not.toContain(AEM_SESSION_COOKIE);
      expect(serialized.toLowerCase()).not.toContain('cookie');

      // The readable-headers list is real - it carries the fixture's own
      // response headers - which is what makes the "no cookie header in it"
      // claim below meaningful rather than vacuous.
      const headerNames = (reply.headers ?? []).map((header) => header.name.toLowerCase());
      expect(headerNames).toContain('content-type');
      expect(headerNames).not.toContain('set-cookie');
      expect(headerNames).not.toContain('cookie');

      // The central security property, proven from the OTHER side: the
      // fixture's own request log shows the cookie DID travel to the server
      // (authenticated: true) and that no Authorization header was invented
      // in its place (authorizationHeaderPresent: false).
      const entries = aem.log
        .slice(logCountBefore)
        .filter((entry) => entry.path === '/content/site.0.json');
      const last = entries.at(-1);
      if (last === undefined) {
        throw new Error('expected the bridge fetch to be logged by the fixture server');
      }
      expect(last.authenticated).toBe(true);
      expect(last.authorizationHeaderPresent).toBe(false);
    });

    test('4. 403 Forbidden is a distinct outcome from a blocked redirect', async () => {
      const reply = await bridgeFetch(application, {
        webContentsId: authView.webContentsId,
        url: `${aem.origin}/content/forbidden.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'response') {
        throw new Error(`expected a response reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.status).toBe(403);
    });

    test('5. 404 Not Found is reported as a plain response', async () => {
      const reply = await bridgeFetch(application, {
        webContentsId: authView.webContentsId,
        url: `${aem.origin}/content/missing.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'response') {
        throw new Error(`expected a response reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.status).toBe(404);
    });

    test("6. Sling's 300 too-many-results trap is not silently accepted as the resource", async () => {
      const reply = await bridgeFetch(application, {
        webContentsId: authView.webContentsId,
        url: `${aem.origin}/content/too-many.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'response') {
        throw new Error(`expected a response reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.status).toBe(300);
      // A validator that only asks "did this parse?" would wrongly accept
      // this as the resource: it IS valid JSON with a JSON content type, but
      // it is an ARRAY of alternative URLs, not the resource's properties.
      const parsedArray = parseJsonArray(reply.bodyText);
      expect(Array.isArray(parsedArray)).toBe(true);
    });

    test('7. HTML answering a .json path is reported as HTML, not silently treated as data', async () => {
      const reply = await bridgeFetch(application, {
        webContentsId: authView.webContentsId,
        url: `${aem.origin}/content/html-not-json.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'response') {
        throw new Error(`expected a response reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.status).toBe(200);
      // HTTP success alone would have handed a login/error page to the model;
      // the content type is what actually distinguishes it from real data.
      if (reply.contentType === null) {
        throw new Error('expected a content type');
      }
      expect(reply.contentType.startsWith('text/html')).toBe(true);
    });

    test('8. invalid JSON is passed through as text, and fails to parse', async () => {
      const reply = await bridgeFetch(application, {
        webContentsId: authView.webContentsId,
        url: `${aem.origin}/content/broken-json.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'response') {
        throw new Error(`expected a response reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.status).toBe(200);
      expect(reply.contentType).toBe('application/json');
      expect(() => {
        JSON.parse(reply.bodyText);
      }).toThrow();
    });

    test('11. a payload larger than 1 MiB passes through intact', async () => {
      const reply = await bridgeFetch(application, {
        webContentsId: authView.webContentsId,
        url: `${aem.origin}/content/large.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'response') {
        throw new Error(`expected a response reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.status).toBe(200);
      // Proves the user-rejected byte cap has not reappeared.
      expect(reply.bodyText.length).toBeGreaterThan(1_200_000);
      const body = parseJsonObject(reply.bodyText);
      const blob = body['blob'];
      if (typeof blob !== 'string') {
        throw new Error('expected body.blob to be a string');
      }
      expect(blob.length).toBe(1_200_000);
      expect(blob).toBe('x'.repeat(1_200_000));
    });

    test('12. cancelling a request guarantees no reply, even though the fetch would otherwise succeed', async () => {
      const requestId = randomUUID();
      const { replies } = await collectBridgeReplies(application, {
        webContentsId: authView.webContentsId,
        commands: [
          { channel: 'fetch', command: { requestId, url: `${aem.origin}/content/large.0.json` } },
          { channel: 'cancel', command: { requestId } },
        ],
        windowMs: 3_000,
      });
      // The preload deletes the in-flight entry BEFORE aborting (see
      // aem-preload.ts), so the fetch's own `.then`/`.catch` finds no entry
      // and stays silent - a cancelled id can never complete, not even with a
      // "cancelled"-kind reply.
      expect(replies).toEqual([]);
    });

    test("14. the page's main world gets nothing: no bridge, no daisy, no require/ipcRenderer", async () => {
      const probe = await readPageTypeofs(application, {
        webContentsId: authView.webContentsId,
        keys: ['bridge', 'daisy', 'require', 'ipcRenderer', 'process'],
      });
      expect(probe['bridge']).toBe('undefined');
      expect(probe['daisy']).toBe('undefined');
      expect(probe['require']).toBe('undefined');
      expect(probe['ipcRenderer']).toBe('undefined');
      expect(probe['process']).toBe('undefined');
    });

    test('15. a duplicate requestId sent back-to-back is ignored, producing exactly one reply', async () => {
      const requestId = randomUUID();
      const command: AemBridgeFetchCommand = {
        requestId,
        url: `${aem.origin}/content/site.0.json`,
      };
      const { replies } = await collectBridgeReplies(application, {
        webContentsId: authView.webContentsId,
        commands: [
          { channel: 'fetch', command },
          { channel: 'fetch', command },
        ],
        windowMs: 3_000,
      });
      expect(replies).toHaveLength(1);
      const [only] = replies;
      if (only === undefined) {
        throw new Error('expected exactly one reply');
      }
      expect(only.kind).toBe('response');
      expect(only.requestId).toBe(requestId);
    });
  });

  test.describe('unauthenticated access is refused', () => {
    let aemUnauth: AemOrigin;
    let unauthView: AemView;

    test.beforeAll(async () => {
      aemUnauth = await startAemOrigin();
      unauthView = await createAemView(application, {
        partition: UNAUTH_PARTITION,
        preload: aemPreload,
      });
      // Navigating (without signing in) lands on the login page, but stays on
      // the AEM origin - so the fetch below is still same-origin, and the
      // only thing standing between it and a 200 is the missing session.
      await loadUrl(application, {
        webContentsId: unauthView.webContentsId,
        url: `${aemUnauth.origin}/content/site`,
      });
    });

    test.afterAll(async () => {
      await aemUnauth.close();
    });

    test('3. an unauthenticated request is refused, converting the redirect:manual assumption into evidence', async () => {
      // This is the single most important empirical question in this file:
      // until this assertion runs, it was only an ASSUMPTION that this
      // Electron/Chromium build surfaces a same-origin (or cross-origin) 3xx
      // under `redirect: "manual"` as an opaque-redirect response rather than
      // throwing. A genuine unauthenticated request to a real fixture server
      // is what turns that assumption into evidence.
      const reply = await bridgeFetch(application, {
        webContentsId: unauthView.webContentsId,
        url: `${aemUnauth.origin}/content/site.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'blocked') {
        throw new Error(`expected a blocked reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.reason).toBe('redirect_blocked');
      // Not a 200, and not a successful response of any kind.
      expect(reply.kind).not.toBe('response');
    });
  });

  test.describe('cross-origin redirect and command refusal', () => {
    const sharedSecret = 'daisy-step06-bridge-secret';
    let idp: SsoIdp;
    let ssoAem: AemOrigin;
    let ssoView: AemView;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      idp = await startSsoIdp({ sharedSecret });
      ssoAem = await startAemOrigin({ sso: { origin: idp.origin, sharedSecret } });
      ssoView = await createAemView(application, { partition: SSO_PARTITION, preload: aemPreload });
      await loadUrl(application, {
        webContentsId: ssoView.webContentsId,
        url: `${ssoAem.origin}/content/site`,
      });
      await submitLoginForm(application, {
        webContentsId: ssoView.webContentsId,
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
      });
    });

    test.afterAll(async () => {
      await Promise.all([idp.close(), ssoAem.close()]);
    });

    test('9. a redirect to another origin mid-fetch is blocked, and never reaches that origin', async () => {
      const idpLogCountBefore = idp.log.length;
      const reply = await bridgeFetch(application, {
        webContentsId: ssoView.webContentsId,
        url: `${ssoAem.origin}/content/redirect-away.0.json`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'blocked') {
        throw new Error(`expected a blocked reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.reason).toBe('redirect_blocked');
      // `redirect: "manual"` means the fetch never followed the 302, so the
      // IdP's own log must show no new request at all.
      expect(idp.log.length).toBe(idpLogCountBefore);
    });

    test('10. a command whose url targets a different origin is refused by the preload itself', async () => {
      const idpLogCountBefore = idp.log.length;
      const reply = await bridgeFetch(application, {
        webContentsId: ssoView.webContentsId,
        // The view's current document is on ssoAem.origin; this URL is a
        // DIFFERENT origin, so the preload must refuse it before ever
        // fetching - proving it re-checks origin rather than trusting main.
        url: `${idp.origin}/whoami`,
        requestId: randomUUID(),
      });
      if (reply.kind !== 'blocked') {
        throw new Error(`expected a blocked reply, got: ${JSON.stringify(reply)}`);
      }
      expect(reply.reason).toBe('cross_origin');
      expect(idp.log.length).toBe(idpLogCountBefore);
    });
  });

  test.describe('navigation destroys in-flight work', () => {
    let navAem: AemOrigin;
    let navView: AemView;

    test.beforeAll(async () => {
      navAem = await startAemOrigin();
      navView = await createAemView(application, { partition: NAV_PARTITION, preload: aemPreload });
      await loadUrl(application, {
        webContentsId: navView.webContentsId,
        url: `${navAem.origin}/content/site`,
      });
      await submitLoginForm(application, {
        webContentsId: navView.webContentsId,
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
      });
    });

    test.afterAll(async () => {
      await navAem.close();
    });

    test('13. navigating the view away destroys in-flight bridge work silently, without crashing the app', async () => {
      const requestId = randomUUID();
      const { replies } = await collectBridgeReplies(application, {
        webContentsId: navView.webContentsId,
        commands: [
          {
            channel: 'fetch',
            command: { requestId, url: `${navAem.origin}/content/large.0.json` },
          },
        ],
        navigateTo: `${navAem.origin}/whoami`,
        windowMs: 3_000,
      });
      expect(replies).toEqual([]);
      // The app is still alive and answering evaluate() calls afterwards.
      const stillAlive = await application.evaluate(() => true);
      expect(stillAlive).toBe(true);
    });
  });
});
