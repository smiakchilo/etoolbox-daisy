import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The subset of Electron's `safeStorage` this module actually needs
 * (implementation-plan.md step 04, requirements-decisions.md section 4: "Use
 * Windows DPAPI through a supported Electron safeStorage API for app-managed
 * proxy secrets").
 *
 * Verified against the installed `electron@44.3.0` typings
 * (`node_modules/electron/electron.d.ts`, `interface SafeStorage`): it
 * exposes exactly `isEncryptionAvailable(): boolean`,
 * `encryptString(plainText: string): Buffer` (synchronous, "will throw an
 * error if encryption fails"), and `decryptString(encrypted: Buffer): string`
 * (synchronous). That matches this interface, so no async variant or
 * fallback shape is needed here.
 *
 * This module never imports `electron` itself - `safeStorage` only works
 * inside a real Electron process, which would make this module untestable
 * without one. The real `electron.safeStorage` object satisfies this
 * interface as-is and is passed in by the caller in `src/main`; unit tests
 * pass a fake.
 */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Store/retrieve/remove one app-managed proxy secret, keyed by `secretRef`. */
export interface SecretStore {
  /**
   * Encrypts `plainText` and stores it under `secretRef`, replacing any
   * existing secret for that ref. Throws, without creating or modifying any
   * file, if secure storage is unavailable
   * ({@link SecretCipher.isEncryptionAvailable} returns `false`) - there is no
   * plaintext fallback.
   */
  set(secretRef: string, plainText: string): Promise<void>;
  /**
   * Returns the decrypted secret for `secretRef`, or `undefined` if none is
   * stored. Throws if secure storage is unavailable, or if the stored
   * ciphertext cannot be decrypted (corruption, or encrypted by a different
   * user/machine) - it never returns an empty string or garbage in place of
   * a real error.
   */
  get(secretRef: string): Promise<string | undefined>;
  /** Whether a secret is stored for `secretRef`, without reading or decrypting it. */
  has(secretRef: string): Promise<boolean>;
  /**
   * Removes the secret for `secretRef`, if any. Idempotent: deleting a
   * `secretRef` that has no stored secret succeeds silently, since the
   * multi-store deletion flow (chat/server deletion) retries this.
   */
  delete(secretRef: string): Promise<void>;
}

const SECRET_FILE_EXTENSION = '.secret';

/**
 * Derives the on-disk filename for `secretRef` by hashing it rather than
 * using it verbatim.
 *
 * A `secretRef` identifies *which* server/proxy a secret belongs to (e.g. a
 * server id) and must never contain the secret itself, but nothing about
 * this module's contract stops a caller's `secretRef` from containing path
 * separators, "..", reserved Windows device names, or characters invalid in
 * a filename. Hashing sidesteps all of that filename validation entirely,
 * and as a side effect keeps the filename from revealing which server/proxy
 * a file corresponds to - defence in depth on top of "ciphertext only,
 * without secrets in filenames or metadata", even though the ref itself is
 * not required to be secret.
 */
function secretFileName(secretRef: string): string {
  if (secretRef.length === 0) {
    throw new Error('secretRef must not be empty');
  }
  const digest = createHash('sha256').update(secretRef, 'utf8').digest('hex');
  return `${digest}${SECRET_FILE_EXTENSION}`;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

const ENCRYPTION_UNAVAILABLE_MESSAGE =
  'Secure storage (Electron safeStorage / Windows DPAPI) is unavailable on this machine. ' +
  'Refusing to store or read the secret in plaintext';

/**
 * Creates a {@link SecretStore} rooted at `storageDir` (an app-owned
 * directory, e.g. `<appData>/secrets` - injected as a plain string so this
 * module never needs to import `appPaths.ts`), using `cipher` for
 * encryption/decryption.
 */
export function createSecretStore(storageDir: string, cipher: SecretCipher): SecretStore {
  function filePathFor(secretRef: string): string {
    return path.join(storageDir, secretFileName(secretRef));
  }

  return {
    async set(secretRef, plainText) {
      if (!cipher.isEncryptionAvailable()) {
        throw new Error(ENCRYPTION_UNAVAILABLE_MESSAGE);
      }
      // Encrypt before touching the filesystem: if this throws (Electron
      // docs: "will throw an error if encryption fails"), nothing has been
      // written or modified yet.
      const ciphertext = cipher.encryptString(plainText);

      const filePath = filePathFor(secretRef);
      await mkdir(storageDir, { recursive: true });

      // Write-temp-then-rename. The temp file lives in the same directory as
      // the final file (so the rename is a same-volume rename, not a copy)
      // and is fully written and fsynced *before* the rename happens. On
      // Windows, `fs.rename` is implemented as a single `MoveFileExW` call
      // with `MOVEFILE_REPLACE_EXISTING`, which NTFS carries out as one
      // atomic directory-entry update: there is no observable intermediate
      // state where the final filename exists but points at a partially
      // written file. If the process is killed before the rename, only an
      // orphaned temp file is left behind and the previous secret (if any)
      // is untouched; if it is killed during or after the rename, the
      // rename either fully happened or fully did not - never a truncated
      // file under the real name.
      const tempPath = path.join(
        storageDir,
        `.${path.basename(filePath)}.tmp-${randomBytes(8).toString('hex')}`,
      );
      const handle = await open(tempPath, 'w');
      try {
        await handle.writeFile(ciphertext);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, filePath);
    },

    async get(secretRef) {
      const filePath = filePathFor(secretRef);
      let ciphertext: Buffer;
      try {
        ciphertext = await readFile(filePath);
      } catch (error) {
        if (isNotFoundError(error)) {
          return undefined;
        }
        throw error;
      }

      if (!cipher.isEncryptionAvailable()) {
        throw new Error(ENCRYPTION_UNAVAILABLE_MESSAGE);
      }
      try {
        return cipher.decryptString(ciphertext);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Stored secret for this reference is corrupted or was encrypted by a different ` +
            `user/machine and cannot be decrypted: ${reason}`,
          { cause: error },
        );
      }
    },

    async has(secretRef) {
      try {
        await stat(filePathFor(secretRef));
        return true;
      } catch (error) {
        if (isNotFoundError(error)) {
          return false;
        }
        throw error;
      }
    },

    async delete(secretRef) {
      // `force: true` makes this idempotent: deleting an already-absent
      // secret (ENOENT) succeeds silently instead of throwing, as required
      // by the multi-store deletion flow that retries this.
      await rm(filePathFor(secretRef), { force: true });
    },
  };
}
