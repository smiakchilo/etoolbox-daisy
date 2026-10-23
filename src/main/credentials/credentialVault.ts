import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger';
import type { SecretStore } from '../secretStore';

/**
 * The saved-sign-in vault: what the browser pane remembers about the sign-in
 * forms it has seen submitted, keyed by `(origin, username)`.
 *
 * Keyed by the pair, not by the origin alone, because two accounts can live on
 * one origin (two users on one localhost:4502, two accounts at one identity
 * provider). The most recently used entry is what a page load prefills, so the
 * order of {@link CredentialVault.listForOrigin} is load-bearing: a successful
 * submit promotes its entry to the front.
 *
 * **Storage.** The password is DPAPI-encrypted by the existing
 * `secretStore` under `signin:<origin>|<username>`. The plaintext index
 * (`sign-ins.json`) holds only what the UI needs to reason about - origin,
 * username, `lastUsedAt` - never a password, so a corrupt index can never leak
 * one, and an origin is not a secret. This is the same split the settings
 * document already uses for proxy and agent-token passwords.
 *
 * **Everything a consumer needs is synchronous after {@link ready}.** The index
 * and its secrets are loaded once at startup and kept in memory: the fill path
 * runs on every `dom-ready` and the host-auth path answers an HTTP 401, neither
 * of which can afford a disk round trip, and Electron's `login` callback wants
 * an answer now. Writes still go to disk, serialized so two quick submits
 * cannot interleave their index writes.
 *
 * **No `schemaVersion`, no migration** - the same deliberate rule the settings
 * document follows: there are no deployed users, so the shape may change.
 * A hand-edited or corrupt index is tolerated (unknown keys are dropped, an
 * unusable entry is skipped) rather than fatal.
 */
export interface StoredCredential {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  /** Epoch milliseconds of the last submission (or of the load that created it). */
  readonly lastUsedAt: number;
}

export interface CredentialVault {
  /** Resolves once the index and every stored password are in memory. */
  readonly ready: Promise<void>;
  /** This origin's credentials, most recently used first. Empty for an unknown origin. */
  listForOrigin(origin: string): readonly StoredCredential[];
  /** The origin's most recently used username, for a password step that omits it. */
  latestUsername(origin: string): string | undefined;
  /** How many sign-ins are stored. */
  count(): number;
  /** Remembers one submitted pair, replacing that pair's password and promoting it. */
  record(input: { origin: string; username: string; password: string }): Promise<void>;
  /** Forgets every sign-in. Resolves with how many were removed. */
  eraseAll(): Promise<number>;
}

export interface CredentialVaultOptions {
  /** The app's technical credentials folder (never the user-visible one). */
  readonly directory: string;
  readonly secrets: Pick<SecretStore, 'set' | 'get' | 'delete'>;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** The index file. Plaintext by design: it holds no password. */
export const SIGN_IN_INDEX_FILE_NAME = 'sign-ins.json';

interface IndexEntry {
  readonly origin: string;
  readonly username: string;
  readonly lastUsedAt: number;
}

/**
 * The secret store's handle for one pair. `secretStore` hashes the reference,
 * so the `|` and `:` here only have to be unambiguous, not filename-safe.
 */
export function credentialSecretRef(origin: string, username: string): string {
  return `signin:${origin}|${username}`;
}

/**
 * Whether `value` is a canonical http(s) origin - the only thing this vault
 * keys on. Main derives it from the sending frame's URL, but the index is a
 * file on disk, so it is re-validated on load.
 */
export function isStorableOrigin(value: string): boolean {
  if (value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === value;
  } catch {
    return false;
  }
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<IndexEntry>;
  return (
    typeof candidate.origin === 'string' &&
    isStorableOrigin(candidate.origin) &&
    typeof candidate.username === 'string' &&
    candidate.username.length > 0 &&
    candidate.username.length <= 320 &&
    typeof candidate.lastUsedAt === 'number' &&
    Number.isFinite(candidate.lastUsedAt) &&
    candidate.lastUsedAt >= 0
  );
}

/** Reads the index, returning `undefined` when there is no usable file at all. */
async function readIndex(filePath: string): Promise<readonly IndexEntry[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return undefined;
  return entries.filter(isIndexEntry);
}

/** Write-temp-then-rename, the same atomicity the secret store uses. */
async function writeIndex(filePath: string, entries: readonly IndexEntry[]): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${randomBytes(8).toString('hex')}`,
  );
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(JSON.stringify({ entries }, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

export function createCredentialVault(options: CredentialVaultOptions): CredentialVault {
  const indexPath = path.join(options.directory, SIGN_IN_INDEX_FILE_NAME);
  const now = options.now ?? Date.now;

  /** Most recently used first. */
  let entries: StoredCredential[] = [];
  // One queue for every write (and for the initial load), so two submissions
  // cannot interleave their secret/index writes.
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    // The queue keeps going after a failure; the failure still reaches the caller.
    queue = next.catch(() => undefined);
    return next;
  }

  async function load(): Promise<void> {
    const stored = await readIndex(indexPath);
    if (stored === undefined) {
      // A missing index is the normal first-run case; an unreadable one is
      // logged and treated as empty (nothing can be recovered from it anyway).
      if (await pathExists(indexPath)) {
        options.logger.warn('CREDENTIAL_LOAD_FAILED', { count: 0 });
      }
      return;
    }
    const loaded: StoredCredential[] = [];
    await Promise.all(
      stored.map(async (entry) => {
        try {
          const password = await options.secrets.get(
            credentialSecretRef(entry.origin, entry.username),
          );
          if (password === undefined) {
            options.logger.warn('CREDENTIAL_LOAD_FAILED', { count: 1 });
            return;
          }
          loaded.push({ ...entry, password });
        } catch {
          // Unreadable ciphertext (another user/machine) is not fatal: that one
          // entry is skipped and the rest of the vault still works.
          options.logger.warn('CREDENTIAL_LOAD_FAILED', { count: 1 });
        }
      }),
    );
    entries = loaded.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  }

  const ready = enqueue(load);

  return {
    ready,

    listForOrigin(origin) {
      return entries.filter((entry) => entry.origin === origin);
    },

    latestUsername(origin) {
      return entries.find((entry) => entry.origin === origin)?.username;
    },

    count() {
      return entries.length;
    },

    async record(input) {
      await ready;
      await enqueue(async () => {
        await options.secrets.set(
          credentialSecretRef(input.origin, input.username),
          input.password,
        );
        const lastUsedAt = now();
        const next: StoredCredential[] = [
          { ...input, lastUsedAt },
          ...entries.filter(
            (entry) => !(entry.origin === input.origin && entry.username === input.username),
          ),
        ];
        await writeIndex(
          indexPath,
          next.map(({ origin, username, lastUsedAt: used }) => ({
            origin,
            username,
            lastUsedAt: used,
          })),
        );
        // Assigned only after the index write succeeds: memory never claims a
        // sign-in that a failed write would forget on the next launch.
        entries = next;
      });
    },

    async eraseAll() {
      await ready;
      return enqueue(async () => {
        const removed = entries.length;
        const results = await Promise.allSettled(
          entries.map((entry) =>
            options.secrets.delete(credentialSecretRef(entry.origin, entry.username)),
          ),
        );
        const failed = results.filter((result) => result.status === 'rejected').length;
        if (failed > 0) options.logger.warn('CREDENTIALS_ERASE_FAILED', { count: failed });
        // The index goes even when a secret could not be deleted: the orphaned
        // ciphertext is unreadable without its index entry, and keeping the
        // index would keep the sign-in visible after the user asked to forget it.
        await rm(indexPath, { force: true });
        entries = [];
        return removed;
      });
    },
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
