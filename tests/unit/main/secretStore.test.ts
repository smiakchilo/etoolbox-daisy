import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretStore, type SecretCipher } from '../../../src/main/secretStore';

/**
 * Scratch directories live under the project's own `test-results/` (already
 * gitignored), never an OS temp directory - matching
 * `tests/unit/agent/runtimePaths.test.ts`.
 */
const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'secretStore-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A real (non-Electron) AES-256-GCM cipher standing in for
 * `electron.safeStorage`. It genuinely encrypts/decrypts - including
 * authenticated-tag verification, so corrupted ciphertext genuinely fails to
 * decrypt - without requiring a real Electron process.
 */
function createFakeCipher(options: { available?: boolean } = {}): SecretCipher {
  const available = options.available ?? true;
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    encryptString(plainText: string): Buffer {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return Buffer.concat([iv, authTag, ciphertext]);
    },
    decryptString(encrypted: Buffer): string {
      const iv = encrypted.subarray(0, 12);
      const authTag = encrypted.subarray(12, 28);
      const ciphertext = encrypted.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}

function listAllFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return entries
    .map((entry) => path.join(dir, entry))
    .filter((fullPath) => {
      try {
        return statSync(fullPath).isFile();
      } catch {
        return false;
      }
    });
}

describe('createSecretStore', () => {
  it('round-trips a stored secret', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());

    await store.set('server:alpha:proxy', 'hunter2');

    await expect(store.get('server:alpha:proxy')).resolves.toBe('hunter2');
  });

  it('does not write the plaintext secret anywhere in the storage directory', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());
    const plaintext = 'CANARY-SECRET-d41d8cd98f00b204';

    await store.set('server:alpha:proxy', plaintext);

    const files = listAllFiles(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = readFileSync(file);
      expect(contents.includes(Buffer.from(plaintext, 'utf8'))).toBe(false);
      expect(file).not.toContain(plaintext);
    }
  });

  it('canary: the exact secret string appears nowhere in file contents or filenames', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());
    const canary = 'CANARY-SECRET-d41d8cd98f00b204';

    await store.set('copilot:global-proxy', canary);
    await store.set('server:beta:proxy', 'some other secret containing ' + canary);

    const files = listAllFiles(dir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      expect(file).not.toContain(canary);
      const contents = readFileSync(file);
      expect(contents.includes(Buffer.from(canary, 'utf8'))).toBe(false);
    }
  });

  it('does not derive the on-disk filename from the secretRef verbatim', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());
    const secretRef = 'server:super-secret-looking-ref:proxy';

    await store.set(secretRef, 'value');

    const files = listAllFiles(dir);
    expect(files.length).toBe(1);
    expect(path.basename(files[0] ?? '')).not.toContain(secretRef);
  });

  it('fails explicitly and writes no file when encryption is unavailable', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher({ available: false }));

    await expect(store.set('server:alpha:proxy', 'hunter2')).rejects.toThrow(
      /secure storage.*unavailable/i,
    );

    // Not just "no secret readable" - no file/directory was created at all.
    expect(() => statSync(dir)).not.toThrow();
    expect(listAllFiles(dir)).toHaveLength(0);
  });

  it('fails explicitly on read when encryption is unavailable, without returning plaintext or empty', async () => {
    const dir = createScratchRoot();
    const cipher = createFakeCipher();
    const writingStore = createSecretStore(dir, cipher);
    await writingStore.set('server:alpha:proxy', 'hunter2');

    const unavailableCipher = createFakeCipher({ available: false });
    const readingStore = createSecretStore(dir, unavailableCipher);

    await expect(readingStore.get('server:alpha:proxy')).rejects.toThrow(
      /secure storage.*unavailable/i,
    );
  });

  it('surfaces an explicit error for corrupted ciphertext instead of garbage or empty string', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());
    await store.set('server:alpha:proxy', 'hunter2');

    const files = listAllFiles(dir);
    expect(files).toHaveLength(1);
    const filePath = files[0];
    if (filePath === undefined) throw new Error('expected a stored secret file');

    const original = readFileSync(filePath);
    const corrupted = Buffer.from(original);
    // Flip a byte inside the ciphertext/auth-tag region so decryption fails
    // its integrity check rather than silently producing wrong output.
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
    writeFileSync(filePath, corrupted);

    await expect(store.get('server:alpha:proxy')).rejects.toThrow(/corrupted|decrypt/i);
  });

  it('reports no secret for a ref that was never stored', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());

    await expect(store.get('server:never-stored:proxy')).resolves.toBeUndefined();
  });

  it('deletes a stored secret', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());
    await store.set('server:alpha:proxy', 'hunter2');

    await store.delete('server:alpha:proxy');

    await expect(store.get('server:alpha:proxy')).resolves.toBeUndefined();
  });

  it('is idempotent when deleting a secret that does not exist', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());

    await expect(store.delete('server:never-stored:proxy')).resolves.toBeUndefined();
    await expect(store.delete('server:never-stored:proxy')).resolves.toBeUndefined();
  });

  it('reports existence without returning the secret value', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());

    await expect(store.has('server:alpha:proxy')).resolves.toBe(false);

    await store.set('server:alpha:proxy', 'hunter2');

    const result: boolean = await store.has('server:alpha:proxy');
    expect(result).toBe(true);
    expect(typeof result).toBe('boolean');
  });

  it('round-trips a secret containing Unicode', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());
    const secret = 'пароль-🔒-密码-café';

    await store.set('server:unicode:proxy', secret);

    await expect(store.get('server:unicode:proxy')).resolves.toBe(secret);
  });

  it('round-trips a very long secret value', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());
    const secret = 'x'.repeat(200_000) + '-end';

    await store.set('server:long:proxy', secret);

    await expect(store.get('server:long:proxy')).resolves.toBe(secret);
  });

  it('replaces an existing secret for the same ref', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());

    await store.set('server:alpha:proxy', 'first-value');
    await store.set('server:alpha:proxy', 'second-value');

    await expect(store.get('server:alpha:proxy')).resolves.toBe('second-value');
    expect(listAllFiles(dir)).toHaveLength(1);
  });

  it('leaves no temp file behind after a successful write', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());

    await store.set('server:alpha:proxy', 'hunter2');

    const files = listAllFiles(dir);
    expect(files).toHaveLength(1);
    expect(path.basename(files[0] ?? '')).not.toContain('.tmp-');
  });

  it('keeps secrets for different refs independent', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());

    await store.set('server:alpha:proxy', 'alpha-secret');
    await store.set('server:beta:proxy', 'beta-secret');

    await expect(store.get('server:alpha:proxy')).resolves.toBe('alpha-secret');
    await expect(store.get('server:beta:proxy')).resolves.toBe('beta-secret');
    expect(listAllFiles(dir)).toHaveLength(2);
  });

  it('rejects an empty secretRef', async () => {
    const dir = createScratchRoot();
    const store = createSecretStore(dir, createFakeCipher());

    await expect(store.set('', 'hunter2')).rejects.toThrow(/secretRef/);
  });
});
