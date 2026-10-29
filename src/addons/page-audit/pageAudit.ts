import type { BrowserWindow, Session } from 'electron';
import type { AddonHost } from '../../shared';
import { type LighthouseAudit, auditEvidence, hasMeasuredSaving } from './evidence';
import { DebuggerTransport } from './pageAuditTransport';
import type {
  PageAuditCategory,
  PageAuditFailed,
  PageAuditFailure,
  PageAuditOutcome,
  PageAuditRequest,
  PageAuditRunner,
  PageAuditScore,
} from './types';

export const PAGE_AUDIT_TIMEOUT_MS = 120_000;
/** How many audits may wait behind the one running before a further request is refused. */
export const PAGE_AUDIT_MAX_QUEUED = 2;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;

/** The part of a navigation event the audit uses. */
interface PreventableEvent {
  preventDefault(): void;
}

interface LighthouseAuditRef {
  readonly id: string;
  readonly weight: number;
}

export interface LighthouseResult {
  readonly categories: Record<
    string,
    { readonly score: number | null; readonly auditRefs: readonly LighthouseAuditRef[] } | undefined
  >;
  readonly audits: Record<
    string,
    | (LighthouseAudit & { readonly score: number | null; readonly scoreDisplayMode: string })
    | undefined
  >;
  readonly runtimeError?: { readonly message?: string; readonly code?: string };
}

/** Audits whose score says nothing about a pass or a failure. */
const UNSCORED_MODES = new Set(['informative', 'manual', 'notApplicable', 'error']);

export function parseTarget(
  raw: string | undefined,
  currentUrl: string | undefined,
): URL | 'no_page' | undefined {
  const value = raw?.trim();
  let candidate: URL;
  try {
    if (value === undefined || value === '') {
      if (currentUrl === undefined) return 'no_page';
      candidate = new URL(currentUrl);
    } else if (/^\/(?!\/)/.test(value)) {
      if (currentUrl === undefined) return 'no_page';
      candidate = new URL(value, new URL(currentUrl).origin);
    } else {
      candidate = new URL(value);
    }
  } catch {
    return undefined;
  }
  if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') return undefined;
  if (candidate.username !== '' || candidate.password !== '') return undefined;
  candidate.hash = '';
  return candidate;
}

/**
 * Every audit that did not pass, heaviest first, each once, with the evidence
 * the run reported for it (see `evidence.ts`) - plus every weight-0
 * `informative` insight it measured a saving for, because that is where the
 * latest scoring keeps the performance category's actionable findings (its only
 * weighted audits are the five metrics). Nothing is capped: a report that lists
 * ten audits without saying what failed is what this replaced.
 */
export function lighthouseFailures(
  lhr: LighthouseResult,
  categories: readonly PageAuditCategory[],
): readonly PageAuditFailure[] {
  const seen = new Set<string>();
  const failures: PageAuditFailure[] = [];
  for (const category of categories) {
    const refs = [...(lhr.categories[category]?.auditRefs ?? [])].sort(
      (a, b) => b.weight - a.weight,
    );
    for (const ref of refs) {
      const audit = lhr.audits[ref.id];
      if (audit === undefined || seen.has(ref.id)) continue;
      if (UNSCORED_MODES.has(audit.scoreDisplayMode)) {
        // Not a pass/fail audit. An insight that measured a saving is still a
        // finding; a breakdown, a manual check or an error is not.
        if (audit.scoreDisplayMode !== 'informative' || !hasMeasuredSaving(audit)) continue;
      } else if (audit.score === null || audit.score >= 1) {
        continue;
      }
      seen.add(ref.id);
      failures.push({
        category,
        id: ref.id,
        title: audit.title,
        score: audit.score,
        ...(audit.displayValue === undefined || audit.displayValue === ''
          ? {}
          : { displayValue: audit.displayValue }),
        evidence: auditEvidence(audit),
      });
    }
  }
  return failures;
}

/** A request the audit window was not allowed to make. */
export interface AuditRefusal {
  readonly url: string;
  readonly reason: string;
}

export type AuditRequestVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * What the audit window may request. Its own configured hosts are trusted (their
 * pages and subresources are audited through the pane's session); `data:`,
 * `blob:` and `about:` are local; everything else has to pass the host's address
 * policy. Applied to every request - a configured host's page included - and
 * again to `will-navigate`/`will-redirect`.
 */
export async function inspectAuditRequest(
  address: string,
  host: Pick<AddonHost<BrowserWindow, Session>, 'hosts' | 'network'>,
): Promise<AuditRequestVerdict> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { allowed: false, reason: 'it is not a valid address' };
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') {
    return { allowed: true };
  }
  if (host.hosts.isConfiguredOrigin(url.origin)) return { allowed: true };
  const target = await host.network.inspectTarget(url.href);
  return target.allowed
    ? { allowed: true }
    : { allowed: false, reason: 'it is a local or internal address' };
}

function sleepUntilAborted(signal: AbortSignal | undefined): Promise<'cancelled'> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve('cancelled');
    else signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
  });
}

function shortUrl(url: string): string {
  return url.length <= 200 ? url : `${url.slice(0, 197)}...`;
}

/**
 * Runs one audit in a hidden, off-screen window the **host** creates. Puppeteer
 * drives that window's own debugger in-process (no debugging port is opened). A
 * configured host's page uses the pane's session, so a page behind sign-in can
 * be audited; any other page uses an empty isolated session. Every request
 * either kind of page makes is held to `inspectAuditRequest`, and the add-on
 * applies all of that window's hardening itself: no new windows, permissions
 * scoped to the audit, no WebRTC over anything but the proxy, and a navigation
 * guard.
 *
 * The request filter is a **best effort** against DNS rebinding: Chromium
 * resolves the name itself, so the address it connects to is not pinned to the
 * one that was checked (`docs/compatibility.md` §11.8). What the filter does
 * guarantee is that no request is even attempted to a literal or resolved
 * loopback, link-local, private or internal address, and that the audit window
 * cannot open windows, ask for permissions or use WebRTC over anything but the
 * proxy.
 */
export function createPageAudit(
  host: AddonHost<BrowserWindow, Session>,
  options: { readonly timeoutMs?: number } = {},
): PageAuditRunner {
  const timeoutMs = options.timeoutMs ?? PAGE_AUDIT_TIMEOUT_MS;
  let queue: Promise<unknown> = Promise.resolve();
  let accepted = 0;

  async function audit(
    request: PageAuditRequest,
    signal: AbortSignal | undefined,
    progress?: (stage: string) => void,
  ): Promise<PageAuditOutcome> {
    const target = parseTarget(request.url, host.pane.currentUrl());
    if (target === 'no_page') return { kind: 'no_page' };
    if (target === undefined) return { kind: 'invalid_url' };

    const outside = !host.hosts.isConfiguredOrigin(target.origin);
    if (outside && !(await host.network.inspectTarget(target.href)).allowed) {
      return { kind: 'blocked', message: 'The address is local, private or internal.' };
    }

    const session = outside ? host.sessions.isolated('anonymous') : host.sessions.pane();
    // An outside audit gets a dedicated session, so every request in it belongs
    // to the audit. A configured host's audit shares the pane's session, where
    // the user's own traffic must not be filtered: only the audit window's
    // requests are examined (an id-less service-worker request is left alone).
    const filterEverything = outside;
    if (outside) await session.clearStorageData();

    const refusals: AuditRefusal[] = [];
    const remember = (url: string, reason: string): void => {
      refusals.push({ url: shortUrl(url), reason });
      if (refusals.length > 10) refusals.shift();
    };

    const win = host.browser.createHiddenWindow({
      session,
      offscreen: true,
      backgroundThrottling: false,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    });
    const windowId = win.webContents.id;
    win.webContents.setFrameRate(30);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // WebRTC can leave through UDP without passing the HTTP request filter.
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

    const isAuditRequest = (webContentsId: number | undefined): boolean =>
      filterEverything || webContentsId === undefined || webContentsId === windowId;

    const requestFilter = (
      details: { readonly url: string; readonly webContentsId?: number },
      callback: (response: { cancel?: boolean }) => void,
    ): void => {
      if (!isAuditRequest(details.webContentsId)) {
        callback({});
        return;
      }
      void inspectAuditRequest(details.url, host).then((verdict) => {
        if (verdict.allowed) callback({});
        else {
          remember(details.url, verdict.reason);
          callback({ cancel: true });
        }
      });
    };

    session.webRequest.onBeforeRequest(requestFilter);
    // Scoped to this window, so a pane session's other views keep the default
    // (approved) behaviour while the audit runs.
    session.setPermissionRequestHandler((contents, _permission, callback) => {
      callback(contents.id !== windowId);
    });
    session.setPermissionCheckHandler((contents) => contents?.id !== windowId);

    // `onBeforeRequest` covers these too, but a navigation that is already known
    // to be refused is stopped before it starts a document load.
    const stopRefusedNavigation = (url: string): void => {
      void inspectAuditRequest(url, host).then((verdict) => {
        if (verdict.allowed) return;
        remember(url, verdict.reason);
        if (!win.isDestroyed()) win.webContents.stop();
      });
    };
    const onWillNavigate = (_event: PreventableEvent, url: string): void =>
      stopRefusedNavigation(url);
    const onWillRedirect = (event: PreventableEvent, url: string): void => {
      void inspectAuditRequest(url, host).then((verdict) => {
        if (verdict.allowed) return;
        remember(url, verdict.reason);
        event.preventDefault();
      });
    };
    win.webContents.on('will-navigate', onWillNavigate);
    win.webContents.on('will-redirect', onWillRedirect);

    let transport: DebuggerTransport | undefined;
    let browser: import('puppeteer-core').Browser | undefined;
    const work = (async (): Promise<PageAuditOutcome> => {
      const url = target.href;
      let loadTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          win.loadURL(url),
          new Promise<never>((_, reject) => {
            loadTimer = setTimeout(
              () => reject(new Error('The page did not load in time.')),
              PAGE_LOAD_TIMEOUT_MS,
            );
            loadTimer.unref();
          }),
        ]);
      } finally {
        if (loadTimer !== undefined) clearTimeout(loadTimer);
      }
      progress?.('Loading tools');
      const lighthouse = (await import('lighthouse')).default;
      const puppeteer = await import('puppeteer-core');
      progress?.('Auditing the page');
      transport = new DebuggerTransport(win.webContents.debugger, {
        title: win.webContents.getTitle(),
        url: win.webContents.getURL(),
      });
      browser = await puppeteer.connect({ transport, defaultViewport: null });
      const pageTarget = await browser.waitForTarget(
        (t) => t.type() === puppeteer.TargetType.PAGE,
        { timeout: 10_000 },
      );
      const page = await pageTarget.page();
      if (page === null) return { kind: 'failed', message: 'The audit page could not be opened.' };
      const desktop = request.formFactor === 'desktop';
      const config = desktop
        ? (await import('lighthouse/core/config/desktop-config.js')).default
        : undefined;
      const result = await lighthouse(
        win.webContents.getURL(),
        { output: 'json', logLevel: 'error', onlyCategories: [...request.categories] },
        config,
        page,
      );
      if (result === undefined)
        return { kind: 'failed', message: 'Lighthouse returned no result.' };
      const lhr = result.lhr as unknown as LighthouseResult;
      const scores: PageAuditScore[] = request.categories.map((category) => ({
        category,
        score: lhr.categories[category]?.score ?? null,
      }));
      const failures = lighthouseFailures(lhr, request.categories);
      return {
        kind: 'report',
        url,
        formFactor: request.formFactor,
        scores,
        failures,
        ...(lhr.runtimeError?.message === undefined
          ? {}
          : { runtimeError: lhr.runtimeError.message }),
      };
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref();
    });
    try {
      const raced = await Promise.race([work, timeout, sleepUntilAborted(signal)]);
      if (raced === 'timeout') return { kind: 'timeout' };
      if (raced === 'cancelled') return { kind: 'cancelled' };
      return raced;
    } catch (error) {
      // A refused request is the reason the audit failed, and the message says
      // which request it was - never only "redirected to a local address".
      const refusal = refusals.at(-1);
      if (refusal !== undefined) {
        const documentRefused = refusals.some((item) => item.url === shortUrl(target.href));
        return {
          kind: documentRefused ? 'blocked' : 'failed',
          message: `A request to ${refusal.url} was refused because ${refusal.reason}`,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      host.log({ code: 'runtime-failed' });
      return { kind: 'failed', message };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Tear the page down first: a hung iteration must not keep the window
      // (and the CPU it burns) alive while `disconnect` waits.
      transport?.close();
      if (!win.isDestroyed()) win.destroy();
      try {
        await browser?.disconnect();
      } catch {
        // Already disconnected.
      }
      work.catch(() => undefined);
      session.webRequest.onBeforeRequest(null);
      session.setPermissionRequestHandler(null);
      session.setPermissionCheckHandler(null);
    }
  }

  return (request, signal, progress) => {
    if (accepted > PAGE_AUDIT_MAX_QUEUED) {
      return Promise.resolve({
        kind: 'failed',
        message: 'An audit is already running, and the queue is full. Try again when it finishes',
      } satisfies PageAuditFailed);
    }
    accepted += 1;
    const run = queue.then(
      () => audit(request, signal, progress),
      () => audit(request, signal, progress),
    );
    const settled: Promise<PageAuditOutcome> = run
      .catch((): PageAuditFailed => ({ kind: 'failed' }))
      .finally(() => {
        accepted -= 1;
      });
    queue = settled;
    return settled;
  };
}
