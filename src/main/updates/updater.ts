import { readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';

import type { AgentFetch, UpdateStatus } from '../../shared';
import { type LogReason, type Logger, toLoggableUrl } from '../logger';
import { packageJsonUrl, parseUpdateSource, sourceArchiveUrl } from './source';
import { compareVersions } from './version';

/** Shown as the version of an update whose source is a whole archive URL, which carries none. */
const ARCHIVE_SOURCE_VERSION = 'archive';

const VERSION_TIMEOUT_MS = 15_000;
const MAX_PACKAGE_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 1000;
/** An update whose status stays untouched this long is abandoned: the script died. */
const STALL_LIMIT_MS = 30 * 60_000;
const MAX_STAGE_LENGTH = 40;
const MAX_TEXT_LENGTH = 200;

const packageVersionSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });

export interface UpdaterDependencies {
  readonly installedVersion: string;
  /**
   * The Settings "Update source" (a ref, a repository or an https archive URL),
   * read fresh on every use.
   */
  readonly source: () => string | undefined;
  /** A fetch honouring the proxy configured right now. */
  readonly createFetch: () => Promise<AgentFetch>;
  /**
   * Whether that fetch goes through a configured proxy. Read fresh per check and
   * recorded on every failed read, so a diagnostic can tell "the network could
   * not reach GitHub" from "the configured proxy could not be reached".
   */
  readonly usesProxy: () => boolean;
  /**
   * The file the update script reports its progress in. Both sides of the
   * hand-over use it: the script writes `stage|text` lines, the relaunched app
   * answers `started|<version>`, and a `.go` file beside it asks for a restart.
   */
  readonly statusFile: string;
  /** Whether this process was started by an update's swap (the script says so). */
  readonly startedByUpdate: boolean;
  /**
   * Starts the detached script that builds the offered archive and swaps it in
   * once the app has exited. Rejects when that cannot be done (an unpackaged
   * build, no script).
   */
  readonly launch: (archiveUrl: string) => Promise<void>;
  readonly quit: () => void;
  readonly logger: Pick<Logger, 'error' | 'warn'>;
  readonly onStatusChanged: (status: UpdateStatus) => void;
}

export interface Updater {
  getStatus(): UpdateStatus;
  /** `force` (dev tooling) offers whatever version the source has, even an equal or older one. */
  check(options?: { readonly force?: boolean }): Promise<UpdateStatus>;
  /** Builds the update in the background; the app quits itself once it is ready to swap in. */
  apply(): Promise<UpdateStatus>;
  /** Answers the script that started this process, and reports how its update ended. */
  resumeAfterUpdate(): Promise<void>;
}

/** Why one version read failed - the fields `UPDATE_CHECK_FAILED` carries. */
interface VersionFailure {
  readonly ok: false;
  readonly reason: LogReason;
  readonly durationMs: number;
  /** Present only when a response arrived and was not ok. */
  readonly statusCode?: number;
}

type VersionRead = { readonly ok: true; readonly version: string } | VersionFailure;

function parseStatusLine(raw: string): { readonly stage: string; readonly text: string } {
  const line = (raw.split(/\r?\n/)[0] ?? '').trim();
  const bar = line.indexOf('|');
  return bar < 0
    ? { stage: line, text: '' }
    : { stage: line.slice(0, bar).trim(), text: line.slice(bar + 1).trim() };
}

function applyingStatus(stage: string, text: string): UpdateStatus {
  return {
    kind: 'applying',
    ...(stage === '' ? {} : { stage: stage.slice(0, MAX_STAGE_LENGTH) }),
    ...(text === '' ? {} : { text: text.slice(0, MAX_TEXT_LENGTH) }),
  };
}

function failedApplyStatus(reason: string): UpdateStatus {
  return {
    kind: 'failed',
    phase: 'apply',
    ...(reason === '' ? {} : { reason: reason.slice(0, MAX_TEXT_LENGTH) }),
  };
}

interface RepositoryRead {
  readonly repository: string;
  readonly url: URL;
  readonly read: VersionRead;
}

/**
 * The newest version any repository answered, the first repository breaking a
 * tie. A repository that could not be read never hides the other's answer;
 * `undefined` means none of them answered.
 */
function newestReading(
  readings: readonly RepositoryRead[],
): { readonly repository: string; readonly version: string } | undefined {
  let newest: { readonly repository: string; readonly version: string } | undefined;
  for (const { repository, read } of readings) {
    if (!read.ok) continue;
    if (newest === undefined || compareVersions(read.version, newest.version) > 0) {
      newest = { repository, version: read.version };
    }
  }
  return newest;
}

/**
 * The updater's state machine. It never throws: every failure becomes a
 * `failed` status and a log line, so a flaky source or a broken build can never
 * be anything worse than "the update did not happen".
 *
 * A check reads the `version` of `package.json` on one ref in every repository
 * the "Update source" names (`src/main/updates/source.ts`) - both defaults when
 * it names none - and offers the newest one. An update is built by the install
 * script (`--update`), from that repository's archive, which swaps the finished
 * build in after this process exits.
 */
export function createUpdater(deps: UpdaterDependencies): Updater {
  const goFile = `${deps.statusFile}.go`;
  let status: UpdateStatus = { kind: 'idle' };
  /** The archive URL the script builds, set by a check that offered an update. */
  let pending: string | undefined;
  let busy = false;

  function setStatus(next: UpdateStatus): UpdateStatus {
    status = next;
    deps.onStatusChanged(next);
    return next;
  }

  async function readStatusFile(): Promise<string | undefined> {
    try {
      return await readFile(deps.statusFile, 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the version at `url`, or says why it could not. Never throws: the
   * reason is what `check()` logs, so a failed check is diagnosable from
   * `app.log` without a debugger.
   */
  async function readVersion(fetchFn: AgentFetch, url: URL): Promise<VersionRead> {
    const started = Date.now();
    const elapsed = (): number => Math.max(0, Date.now() - started);
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
      if (!response.ok) {
        return {
          ok: false,
          reason: 'http-status',
          statusCode: response.status,
          durationMs: elapsed(),
        };
      }
      if (!response.url.startsWith('https:')) {
        return { ok: false, reason: 'insecure', durationMs: elapsed() };
      }
      const text = await response.text();
      if (text.length > MAX_PACKAGE_BYTES) {
        return { ok: false, reason: 'too-large', durationMs: elapsed() };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, reason: 'invalid-manifest', durationMs: elapsed() };
      }
      const parsed = packageVersionSchema.safeParse(json);
      if (!parsed.success) return { ok: false, reason: 'invalid-manifest', durationMs: elapsed() };
      return { ok: true, version: parsed.data.version };
    } catch (error) {
      // `AbortSignal.timeout` rejects with a `TimeoutError`; anything else is a
      // transport failure the caller can only classify as a network failure.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { ok: false, reason: timedOut ? 'timeout' : 'network', durationMs: elapsed() };
    }
  }

  function logReadFailure(failure: VersionFailure, url: URL, proxied: boolean): void {
    deps.logger.warn('UPDATE_CHECK_FAILED', {
      outcome: 'failure',
      reason: failure.reason,
      durationMs: failure.durationMs,
      proxied,
      url: toLoggableUrl(url.href),
      ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
    });
  }

  async function check(options?: { readonly force?: boolean }): Promise<UpdateStatus> {
    if (busy) return status;
    busy = true;
    setStatus({ kind: 'checking' });
    try {
      const parsed = parseUpdateSource(deps.source());
      if (parsed.kind === 'archive') {
        // An archive has no cheap version to compare: it is always offered.
        pending = parsed.url;
        return setStatus({ kind: 'available', version: ARCHIVE_SOURCE_VERSION });
      }
      const fetcher = await deps.createFetch();
      const readings = await Promise.all(
        parsed.repositories.map(async (repository) => {
          const url = packageJsonUrl(repository, parsed.ref);
          return { repository, url, read: await readVersion(fetcher, url) };
        }),
      );
      const proxied = deps.usesProxy();
      for (const { url, read } of readings) {
        if (!read.ok) logReadFailure(read, url, proxied);
      }
      const newest = newestReading(readings);
      if (newest === undefined) {
        pending = undefined;
        return setStatus({ kind: 'failed', phase: 'check' });
      }
      if (options?.force !== true && compareVersions(newest.version, deps.installedVersion) <= 0) {
        pending = undefined;
        return setStatus({ kind: 'upToDate' });
      }
      pending = sourceArchiveUrl(newest.repository, parsed.ref);
      return setStatus({ kind: 'available', version: newest.version });
    } catch {
      pending = undefined;
      deps.logger.error('UPDATE_CHECK_FAILED', { outcome: 'failure', reason: 'unexpected' });
      return setStatus({ kind: 'failed', phase: 'check' });
    } finally {
      busy = false;
    }
  }

  function failApply(reason: string): void {
    pending = undefined;
    deps.logger.error('UPDATE_APPLY_FAILED', { outcome: 'failure' });
    setStatus(failedApplyStatus(reason));
  }

  /** Follows the script's status file until it is ready to swap, or failed. */
  async function watch(): Promise<void> {
    let last = '';
    let changedAt = Date.now();
    try {
      for (;;) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const raw = await readStatusFile();
        const line = raw === undefined ? undefined : raw.trim();
        if (line !== undefined && line !== '' && line !== last) {
          last = line;
          changedAt = Date.now();
          const { stage, text } = parseStatusLine(line);
          if (stage === 'ready') {
            // The user confirmed "install and restart" when starting the update.
            await writeFile(goFile, '');
            setStatus(applyingStatus(stage, text));
            deps.quit();
            return;
          }
          if (stage === 'failed') {
            failApply(text);
            return;
          }
          setStatus(applyingStatus(stage, text));
        } else if (Date.now() - changedAt > STALL_LIMIT_MS) {
          failApply('The update stopped responding');
          return;
        }
      }
    } catch {
      failApply('');
    } finally {
      busy = false;
    }
  }

  async function apply(): Promise<UpdateStatus> {
    if (busy || status.kind !== 'available' || pending === undefined) return status;
    busy = true;
    const source = pending;
    setStatus({ kind: 'applying' });
    try {
      await rm(deps.statusFile, { force: true });
      await rm(goFile, { force: true });
      await deps.launch(source);
    } catch (error) {
      busy = false;
      failApply(error instanceof Error ? error.message : '');
      return status;
    }
    void watch();
    return status;
  }

  async function resumeAfterUpdate(): Promise<void> {
    if (!deps.startedByUpdate) return;
    try {
      const raw = await readStatusFile();
      if (raw === undefined) return;
      const { stage, text } = parseStatusLine(raw);
      if (stage === 'swapped') {
        await writeFile(deps.statusFile, `started|${deps.installedVersion}`);
        setStatus({ kind: 'updated', version: deps.installedVersion });
      } else if (stage === 'reverted' || stage === 'failed') {
        setStatus(failedApplyStatus(text));
      }
    } catch {
      deps.logger.warn('UPDATE_APPLY_FAILED', { outcome: 'failure', reason: 'unexpected' });
    }
  }

  return { getStatus: () => status, check, apply, resumeAfterUpdate };
}
