import { rm, writeFile } from 'node:fs/promises';

import type { AgentFetch, UpdateRuntimePart, UpdateStatus } from '../../shared';
import type { Logger } from '../logger';
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

/**
 * The updater's state machine. It never throws: every failure becomes a
 * `failed` status and a log line, so a flaky source or a bad download can
 * never be anything worse than "the update did not happen".
 *
 * Sources are tried in order - the custom folder, then the built-in ones - and
 * the first reachable source whose manifest carries a newer version for this
 * platform wins. An unreachable or malformed source is skipped.
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

  async function readManifest(
    fetchFn: AgentFetch,
    folder: URL,
  ): Promise<UpdateManifest | undefined> {
    try {
      const response = await fetchFn(fileUrlIn(folder, UPDATE_MANIFEST_FILE), {
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      });
      if (!response.ok || !response.url.startsWith('https:')) return undefined;
      const text = await response.text();
      if (text.length > MAX_MANIFEST_BYTES) return undefined;
      const parsed = updateManifestSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
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
      let reachable = false;
      for (const folder of folders) {
        const manifest = await readManifest(fetchFn, folder);
        if (manifest === undefined) continue;
        reachable = true;
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
      deps.logger.warn('UPDATE_CHECK_FAILED', { outcome: 'failure' });
      return setStatus({ kind: 'failed', phase: 'check' });
    } catch {
      pending = undefined;
      deps.logger.error('UPDATE_CHECK_FAILED', { outcome: 'failure' });
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
