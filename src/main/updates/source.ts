/**
 * Where an update comes from: which repositories a check reads, and at which
 * ref.
 *
 * The two repositories in {@link UPDATE_REPOSITORIES} are treated equally: a
 * check reads their `package.json` on the same ref and offers the newest
 * version found, the first entry breaking a tie. A fresh install
 * (`install/install.cmd` / `install.command`) still builds from that first
 * entry, because it has no version to compare and no second source to merge.
 *
 * The Settings "Update source" may name one repository instead:
 *
 * - `owner/name@ref` - that repository, at that branch, tag or commit;
 * - `github.com/owner/name` - the same, at {@link DEFAULT_UPDATE_REF}, and
 *   `github.com/owner/name@ref` for any other ref;
 * - a whole `https://` URL whose path is exactly `owner/name` (an optional
 *   `.git` is accepted) - the same, so pasting a repository's GitHub address
 *   does not turn into a "download the HTML page as a zip";
 * - anything else without a scheme is a ref of {@link UPDATE_REPOSITORIES};
 * - empty is {@link DEFAULT_UPDATE_REF} of {@link UPDATE_REPOSITORIES}.
 *
 * A URL that is not a bare repository address is a whole source zip, used as it
 * is (its version cannot be compared, so it is always offered).
 */

/** The repositories every check reads, in tie-break order. */
export const UPDATE_REPOSITORIES = ['smiakchilo/etoolbox-daisy', 'exadel/etoolbox-daisy'] as const;

/** The ref a check follows until the Settings "Update source" names another. */
export const DEFAULT_UPDATE_REF = 'master';

const GITHUB_PREFIX = 'github.com/';
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

/** One repository and the ref to read in it. */
export interface UpdateRepositoryTarget {
  readonly repository: string;
  readonly ref: string;
}

/** A check reads this set (one repository, or the defaults) at one ref. */
export interface RepositoriesUpdateSource {
  readonly kind: 'repositories';
  /** In tie-break order. */
  readonly repositories: readonly string[];
  readonly ref: string;
}

/** A whole source zip, which carries no version to compare. */
export interface ArchiveUpdateSource {
  readonly kind: 'archive';
  readonly url: string;
}

export type ParsedUpdateSource = RepositoriesUpdateSource | ArchiveUpdateSource;

/** The same ref rules the Settings contract enforces: no parent hops, no absolute path. */
function isRef(value: string): boolean {
  return REF_PATTERN.test(value) && !value.includes('..') && !value.startsWith('/');
}

/** `github.com/owner/name[@ref]` and `owner/name@ref`, without a scheme. */
function splitRepository(value: string): UpdateRepositoryTarget | undefined {
  if (value.startsWith(GITHUB_PREFIX)) {
    const body = value.slice(GITHUB_PREFIX.length);
    const at = body.lastIndexOf('@');
    const repository = at < 0 ? body : body.slice(0, at);
    const ref = at < 0 ? DEFAULT_UPDATE_REF : body.slice(at + 1);
    return REPOSITORY_PATTERN.test(repository) && isRef(ref) ? { repository, ref } : undefined;
  }
  const at = value.lastIndexOf('@');
  if (at <= 0) return undefined;
  const repository = value.slice(0, at);
  const ref = value.slice(at + 1);
  return REPOSITORY_PATTERN.test(repository) && isRef(ref) ? { repository, ref } : undefined;
}

/** A `https://github.com/owner/name` address, which is a repository, not a zip. */
function repositoryFromUrl(value: string): UpdateRepositoryTarget | undefined {
  if (!value.startsWith('https://')) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'github.com' || url.search !== '' || url.hash !== '') return undefined;
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length !== 2) return undefined;
  const [owner, last = ''] = segments;
  const at = last.lastIndexOf('@');
  const name = (at < 0 ? last : last.slice(0, at)).replace(/\.git$/i, '');
  const ref = at < 0 ? DEFAULT_UPDATE_REF : last.slice(at + 1);
  const repository = `${owner ?? ''}/${name}`;
  return REPOSITORY_PATTERN.test(repository) && isRef(ref) ? { repository, ref } : undefined;
}

/** Parses the Settings "Update source" (or an absent one) into what a check reads. */
export function parseUpdateSource(source: string | undefined): ParsedUpdateSource {
  const value = (source ?? '').trim();
  if (value === '') {
    return { kind: 'repositories', repositories: UPDATE_REPOSITORIES, ref: DEFAULT_UPDATE_REF };
  }
  const target = splitRepository(value) ?? repositoryFromUrl(value);
  if (target !== undefined) {
    return { kind: 'repositories', repositories: [target.repository], ref: target.ref };
  }
  if (value.includes(':')) return { kind: 'archive', url: value };
  return { kind: 'repositories', repositories: UPDATE_REPOSITORIES, ref: value };
}

/** `package.json` at `ref` - the version there is the release. */
export function packageJsonUrl(repository: string, ref: string): URL {
  return new URL(`https://raw.githubusercontent.com/${repository}/${ref}/package.json`);
}

/**
 * The source zip the install script builds. Always an explicit address, so the
 * script's own default repository never decides which one an update came from.
 */
export function sourceArchiveUrl(repository: string, ref: string): string {
  return `https://github.com/${repository}/archive/${ref}.zip`;
}
