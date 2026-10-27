import { rm, writeFile } from 'node:fs/promises';

import type { AgentFetch, UpdateRuntimePart, UpdateStatus } from '../../shared';
import { type LogReason, type Logger, toLoggableUrl } from '../logger';
import { downloadVerifiedArchive, sha512Expectation } from './download';
import {
  compareVersions,
  fileUrlIn,
  MAX_MANIFEST_BYTES,
  MAX_UPDATE_ARCHIVE_BYTES,
  resolveFolderUrl,
  UPDATE_MANIFEST_FILE,
  updateManifestSchema,
  type UpdateFile,
  type UpdateManifest,
} from './manifest';
import { describeRuntimeDifferences, type RuntimeDescriptor } from './runtime';

const MANIFEST_TIMEOUT_MS = 15_000;
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;

export interface UpdaterDependencies {
  readonly installedVersion: string;
  /**
   * This install's runtime layer, as it physically is - `undefined` when it
   * cannot be described, which is never read as "compatible".
   */
  readonly readInstalledRuntime: () => Promise<RuntimeDescriptor | undefined>;
  /** `<platform>-<arch>`, the key into a manifest's `files`. */
  readonly platformKey: string;
  /** The folders built into the app, checked after the custom one. */
  readonly builtinUrls: readonly string[];
  /** The Settings "Custom update URL", read fresh on every check. */
  readonly customUrl: () => string | undefined;
  /** A fetch honouring the proxy configured right now. */
  readonly createFetch: () => Promise<AgentFetch>;
  /**
   * Whether that fetch goes through a configured proxy. Read fresh per check and
   * recorded on every failed source, so a diagnostic can tell "the network could
   * not reach GitHub" from "the configured proxy could not be reached".
   */
  readonly usesProxy: () => boolean;
  /** The installed `app.asar`; `undefined` when this process cannot be updated in place. */
  readonly targetAsar: string | undefined;
  /** Starts the swap of the verified, staged archive; `restart` says whether to quit now. */
  readonly install: (stagedAsar: string) => { readonly restart: boolean };
  readonly quit: () => void;
  readonly logger: Pick<Logger, 'error' | 'warn'>;
  readonly onStatusChanged: (status: UpdateStatus) => void;
}

export interface Updater {
  getStatus(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  apply(): Promise<UpdateStatus>;
}

interface PendingUpdate {
  readonly folder: URL;
  readonly file: UpdateFile;
}

/** Why one source could not be read - the fields `UPDATE_CHECK_FAILED` carries. */
interface ManifestFailure {
  readonly ok: false;
  readonly reason: LogReason;
  readonly durationMs: number;
  /** Present only when a response arrived and was not ok. */
  readonly statusCode?: number;
}

type ManifestRead = { readonly ok: true; readonly manifest: UpdateManifest } | ManifestFailure;

/**
 * The updater's state machine. It never throws: every failure becomes a
 * `failed` status and a log line, so a flaky source or a bad download can
 * never be anything worse than "the update did not happen".
 *
 * Sources are tried in order - the custom folder, then the built-in ones - and
 * the first reachable source whose manifest carries a newer version for this
 * platform wins. An unreachable or malformed source is skipped and logged with
 * its own reason, so a failed check names the source that failed.
 */
export function createUpdater(deps: UpdaterDependencies): Updater {
  let status: UpdateStatus = { kind: 'idle' };
  let pending: PendingUpdate | undefined;
  let busy = false;

  function setStatus(next: UpdateStatus): UpdateStatus {
    status = next;
    deps.onStatusChanged(next);
    return next;
  }

  /**
   * Reads the manifest at `url`, or says why it could not. Never throws: the
   * reason is what `check()` logs, so a failed check is diagnosable from
   * `app.log` without a debugger.
   */
  async function readManifest(fetchFn: AgentFetch, url: URL): Promise<ManifestRead> {
    const started = Date.now();
    const elapsed = (): number => Math.max(0, Date.now() - started);
    try {
      const response = await fetchFn(url, {
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      });
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
      if (text.length > MAX_MANIFEST_BYTES) {
        return { ok: false, reason: 'too-large', durationMs: elapsed() };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, reason: 'invalid-manifest', durationMs: elapsed() };
      }
      const parsed = updateManifestSchema.safeParse(json);
      if (!parsed.success) return { ok: false, reason: 'invalid-manifest', durationMs: elapsed() };
      return { ok: true, manifest: parsed.data };
    } catch (error) {
      // `AbortSignal.timeout` rejects with a `TimeoutError`; anything else is a
      // transport failure the caller can only classify as a network failure.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { ok: false, reason: timedOut ? 'timeout' : 'network', durationMs: elapsed() };
    }
  }

  /** One line per unreadable source: which URL, why, how long, and over which route. */
  function logSourceFailure(failure: ManifestFailure, url: URL, proxied: boolean): void {
    deps.logger.warn('UPDATE_CHECK_FAILED', {
      outcome: 'failure',
      reason: failure.reason,
      durationMs: failure.durationMs,
      proxied,
      url: toLoggableUrl(url.href),
      ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
    });
  }

  async function check(): Promise<UpdateStatus> {
    if (busy) return status;
    busy = true;
    setStatus({ kind: 'checking' });
    /**
     * This install's own runtime layer, described at most once per check and
     * only when a candidate archive names one to compare against. An install
     * that cannot be described reads as `undefined`, which never matches.
     */
    let installedRuntime: Promise<RuntimeDescriptor | undefined> | undefined;
    const currentRuntime = (): Promise<RuntimeDescriptor | undefined> => {
      installedRuntime ??= deps.readInstalledRuntime().catch(() => undefined);
      return installedRuntime;
    };
    try {
      const custom = deps.customUrl();
      const folders = [...(custom === undefined ? [] : [custom]), ...deps.builtinUrls]
        .map(resolveFolderUrl)
        .filter((folder): folder is URL => folder !== undefined);
      const fetchFn = await deps.createFetch();
      const proxied = deps.usesProxy();
      let reachable = false;
      for (const folder of folders) {
        const url = fileUrlIn(folder, UPDATE_MANIFEST_FILE);
        const read = await readManifest(fetchFn, url);
        if (!read.ok) {
          logSourceFailure(read, url, proxied);
          continue;
        }
        reachable = true;
        const manifest = read.manifest;
        const file = manifest.files[deps.platformKey];
        if (file === undefined || compareVersions(manifest.version, deps.installedVersion) <= 0) {
          continue;
        }
        const installerRequired = await checkRuntime(file, currentRuntime);
        if (installerRequired !== undefined) {
          pending = undefined;
          return setStatus({
            kind: 'installerRequired',
            version: manifest.version,
            ...(installerRequired.length === 0 ? {} : { changed: [...installerRequired] }),
          });
        }
        pending = { folder, file };
        return setStatus({
          kind: 'available',
          version: manifest.version,
          ...(manifest.notes === undefined ? {} : { notes: manifest.notes }),
        });
      }
      pending = undefined;
      if (reachable) return setStatus({ kind: 'upToDate' });
      // No source could be read. `count` separates "every source failed" (the
      // per-source lines above say why) from "no source was configured at all".
      deps.logger.warn('UPDATE_CHECK_FAILED', { outcome: 'failure', count: folders.length });
      return setStatus({ kind: 'failed', phase: 'check' });
    } catch {
      pending = undefined;
      deps.logger.error('UPDATE_CHECK_FAILED', { outcome: 'failure', reason: 'unexpected' });
      return setStatus({ kind: 'failed', phase: 'check' });
    } finally {
      busy = false;
    }
  }

  async function download(update: PendingUpdate, targetAsar: string): Promise<string> {
    const fetchFn = await deps.createFetch();
    const bytes = await downloadVerifiedArchive(
      fetchFn,
      fileUrlIn(update.folder, update.file.name),
      sha512Expectation(update.file),
      { timeoutMs: ARCHIVE_TIMEOUT_MS, maxBytes: MAX_UPDATE_ARCHIVE_BYTES },
    );
    const staged = `${targetAsar}.new`;
    await writeFile(staged, bytes);
    return staged;
  }

  async function apply(): Promise<UpdateStatus> {
    if (busy || status.kind !== 'available' || pending === undefined) return status;
    busy = true;
    setStatus({ kind: 'applying' });
    const update = pending;
    const target = deps.targetAsar;
    let staged: string | undefined;
    try {
      staged = await download(update, target ?? failNotUpdatable());
      const { restart } = deps.install(staged);
      if (restart) {
        deps.quit();
        return status;
      }
      pending = undefined;
      return setStatus({ kind: 'upToDate' });
    } catch {
      if (staged !== undefined) await rm(staged, { force: true }).catch(() => undefined);
      pending = undefined;
      deps.logger.error('UPDATE_APPLY_FAILED', { outcome: 'failure' });
      return setStatus({ kind: 'failed', phase: 'apply' });
    } finally {
      busy = false;
    }
  }

  return { getStatus: () => status, check, apply };
}

/**
 * Whether `file` may be swapped into this install.
 *
 * `undefined` means yes. An empty list means no, and refuses to guess why - the
 * archive does not say which runtime layer it needs, or this install cannot
 * describe the one it has. Neither case is treated as compatible: with no
 * counter behind it any more, a descriptor is the only evidence there is. A
 * non-empty list names the parts that differ, which the Settings tab shows.
 */
async function checkRuntime(
  file: UpdateFile,
  currentRuntime: () => Promise<RuntimeDescriptor | undefined>,
): Promise<readonly UpdateRuntimePart[] | undefined> {
  if (file.runtime === undefined) return [];
  const installed = await currentRuntime();
  if (installed === undefined) return [];
  const changed = describeRuntimeDifferences(installed, file.runtime);
  return changed.length === 0 ? undefined : changed;
}

function failNotUpdatable(): never {
  throw new Error('not updatable in place');
}
