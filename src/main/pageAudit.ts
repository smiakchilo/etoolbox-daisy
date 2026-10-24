import { BrowserWindow, type Session } from 'electron';
import {
  PAGE_AUDIT_MAX_FAILURES,
  type PageAuditCategory,
  type PageAuditFailed,
  type PageAuditFailure,
  type PageAuditOutcome,
  type PageAuditRequest,
  type PageAuditRunner,
  type PageAuditScore,
} from '../shared';
import { defaultResolve, isAllowedTarget } from './externalFetch';
import type { Logger } from './logger';
import { DebuggerTransport } from './pageAuditTransport';

export const PAGE_AUDIT_TIMEOUT_MS = 120_000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;

export interface PageAuditOptions {
  /** The browser pane's session: a configured host's page loads with its cookies. */
  readonly paneSession: Session;
  /** A session with no stored state, for a page that is not on a configured host. */
  readonly anonymousSession: () => Session;
  /** The address the browser pane is showing, if it shows a page. */
  readonly currentUrl: () => string | undefined;
  readonly isConfiguredOrigin: (origin: string) => boolean;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  /** Replaceable so a unit test need not resolve real names. */
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
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
    | {
        readonly title: string;
        readonly score: number | null;
        readonly scoreDisplayMode: string;
        readonly displayValue?: string;
      }
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

export function lighthouseFailures(
  lhr: LighthouseResult,
  categories: readonly PageAuditCategory[],
): { readonly failures: PageAuditFailure[]; readonly total: number } {
  const seen = new Set<string>();
  const all: PageAuditFailure[] = [];
  for (const category of categories) {
    const refs = [...(lhr.categories[category]?.auditRefs ?? [])].sort(
      (a, b) => b.weight - a.weight,
    );
    for (const ref of refs) {
      const audit = lhr.audits[ref.id];
      if (audit === undefined || seen.has(ref.id) || ref.weight <= 0) continue;
      if (UNSCORED_MODES.has(audit.scoreDisplayMode)) continue;
      if (audit.score === null || audit.score >= 1) continue;
      seen.add(ref.id);
      all.push({
        category,
        id: ref.id,
        title: audit.title,
        score: audit.score,
        ...(audit.displayValue === undefined || audit.displayValue === ''
          ? {}
          : { displayValue: audit.displayValue }),
      });
    }
  }
  return { failures: all.slice(0, PAGE_AUDIT_MAX_FAILURES), total: all.length };
}

function sleepUntilAborted(signal: AbortSignal | undefined): Promise<'cancelled'> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve('cancelled');
    else signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
  });
}

/**
 * Runs Lighthouse on one page in a hidden, off-screen window the application
 * owns. Puppeteer drives that window's own debugger in-process (no debugging
 * port is opened). A configured host's page uses the pane's session, so a page
 * behind sign-in can be audited; any other page uses an empty session and every
 * request it makes - redirects and subresources included - is held to the
 * address policy of `externalFetch`.
 */
export function createPageAudit(options: PageAuditOptions): PageAuditRunner {
  const timeoutMs = options.timeoutMs ?? PAGE_AUDIT_TIMEOUT_MS;
  const resolveAddresses = options.resolveAddresses ?? defaultResolve;
  let queue: Promise<unknown> = Promise.resolve();

  async function audit(
    request: PageAuditRequest,
    signal: AbortSignal | undefined,
    progress?: (stage: string) => void,
  ): Promise<PageAuditOutcome> {
    const target = parseTarget(request.url, options.currentUrl());
    if (target === 'no_page') return { kind: 'no_page' };
    if (target === undefined) return { kind: 'invalid_url' };

    const outside = !options.isConfiguredOrigin(target.origin);
    if (outside && !(await isAllowedTarget(target, resolveAddresses))) {
      return { kind: 'blocked', message: 'The address is local, private or internal.' };
    }

    const session = outside ? options.anonymousSession() : options.paneSession;
    let blocked = false;
    if (outside) {
      await session.clearStorageData();
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      const isAllowedRequest = async (address: string): Promise<boolean> => {
        try {
          const url = new URL(address);
          const local =
            url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:';
          return local || (await isAllowedTarget(url, resolveAddresses));
        } catch {
          return false;
        }
      };
      session.webRequest.onBeforeRequest((details, callback) => {
        void isAllowedRequest(details.url).then((allowed) => {
          if (!allowed) blocked = true;
          callback(allowed ? {} : { cancel: true });
        });
      });
    }

    const win = new BrowserWindow({
      show: false,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      webPreferences: {
        session,
        sandbox: true,
        offscreen: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.setFrameRate(30);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    let transport: DebuggerTransport | undefined;
    let browser: import('puppeteer-core').Browser | undefined;
    const work = (async (): Promise<PageAuditOutcome> => {
      const url = target.href;
      await Promise.race([
        win.loadURL(url),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('The page did not load in time.')),
            PAGE_LOAD_TIMEOUT_MS,
          ).unref(),
        ),
      ]);
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
      const { failures, total } = lighthouseFailures(lhr, request.categories);
      return {
        kind: 'report',
        url,
        formFactor: request.formFactor,
        scores,
        failures,
        failureCount: total,
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
      if (blocked)
        return { kind: 'blocked', message: 'The page redirected to a local or internal address.' };
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn('PAGE_AUDIT_FAILED');
      return { kind: 'failed', message };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      work.catch(() => undefined);
      try {
        await browser?.disconnect();
      } catch {
        // Already disconnected.
      }
      transport?.close();
      if (!win.isDestroyed()) win.destroy();
      if (outside) {
        session.webRequest.onBeforeRequest(null);
        session.setPermissionRequestHandler(null);
      }
    }
  }

  return (request, signal, progress) => {
    const run = queue.then(
      () => audit(request, signal, progress),
      () => audit(request, signal, progress),
    );
    const settled: Promise<PageAuditOutcome> = run.catch((): PageAuditFailed => ({
      kind: 'failed',
    }));
    queue = settled;
    return settled;
  };
}
