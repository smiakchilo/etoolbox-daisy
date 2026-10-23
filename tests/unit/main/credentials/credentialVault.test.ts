import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCredentialVault,
  credentialSecretRef,
  isStorableOrigin,
  SIGN_IN_INDEX_FILE_NAME,
} from '../../../../src/main/credentials/credentialVault';
import { makeRecordingLogger } from '../../../support/ipcHandlerHarness';
import { createScratchDirs } from '../../../support/scratchDirs';

/**
 * The vault's own rules: what a load tolerates, what a record replaces, and
 * what "erase" really deletes. The secret store is faked as an in-memory map so
 * these cases say nothing about DPAPI - `secretStore.test.ts` covers that.
 */

const scratch = createScratchDirs('main-unit-scratch', 'credentialVault-');

let directory: string;

/** An in-memory stand-in for `secretStore`, recording every call. */
function createFakeSecrets(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    set: vi.fn((ref: string, plainText: string) => {
      values.set(ref, plainText);
      return Promise.resolve();
    }),
    get: vi.fn((ref: string) => Promise.resolve(values.get(ref))),
    delete: vi.fn((ref: string) => {
      values.delete(ref);
      return Promise.resolve();
    }),
  };
}

const origin = 'https://author.example.com';
const otherOrigin = 'http://localhost:4502';

beforeEach(() => {
  directory = scratch.create();
});

afterEach(() => {
  scratch.cleanup();
});

describe('isStorableOrigin', () => {
  it('accepts a canonical http(s) origin', () => {
    expect(isStorableOrigin('https://author.example.com')).toBe(true);
    expect(isStorableOrigin('http://localhost:4502')).toBe(true);
  });

  it('rejects a URL with a path, a query or a default port spelled out', () => {
    expect(isStorableOrigin('https://author.example.com/content')).toBe(false);
    expect(isStorableOrigin('https://author.example.com?x=1')).toBe(false);
    expect(isStorableOrigin('https://author.example.com:443')).toBe(false);
  });

  it('rejects every non-http scheme', () => {
    expect(isStorableOrigin('file:///c:/x')).toBe(false);
    expect(isStorableOrigin('about:blank')).toBe(false);
    expect(isStorableOrigin('not a url')).toBe(false);
    expect(isStorableOrigin('')).toBe(false);
  });
});

describe('createCredentialVault', () => {
  it('starts empty when there is no index', async () => {
    const secrets = createFakeSecrets();
    const vault = createCredentialVault({ directory, secrets, logger: makeRecordingLogger() });

    await vault.ready;

    expect(vault.count()).toBe(0);
    expect(vault.listForOrigin(origin)).toEqual([]);
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it('records a pair, writes the index without the password, and reads it back after a reload', async () => {
    const secrets = createFakeSecrets();
    const vault = createCredentialVault({
      directory,
      secrets,
      logger: makeRecordingLogger(),
      now: () => 1_000,
    });
    await vault.ready;

    await vault.record({ origin, username: 'admin', password: 'secret' });

    expect(vault.listForOrigin(origin)).toEqual([
      { origin, username: 'admin', password: 'secret', lastUsedAt: 1_000 },
    ]);
    const raw = await readFile(path.join(directory, SIGN_IN_INDEX_FILE_NAME), 'utf8');
    expect(raw).not.toContain('secret');
    expect(JSON.parse(raw)).toEqual({
      entries: [{ origin, username: 'admin', lastUsedAt: 1_000 }],
    });

    const reloaded = createCredentialVault({
      directory,
      secrets: createFakeSecrets({ [credentialSecretRef(origin, 'admin')]: 'secret' }),
      logger: makeRecordingLogger(),
    });
    await reloaded.ready;
    expect(reloaded.listForOrigin(origin)).toEqual([
      { origin, username: 'admin', password: 'secret', lastUsedAt: 1_000 },
    ]);
  });

  it('replaces the same pair and promotes it to the front, keeping the other account', async () => {
    const vault = createCredentialVault({
      directory,
      secrets: createFakeSecrets(),
      logger: makeRecordingLogger(),
      now: () => 1_000,
    });
    await vault.ready;
    await vault.record({ origin, username: 'first', password: 'one' });
    await vault.record({ origin, username: 'second', password: 'two' });

    const clock = 2_000;
    const later = createCredentialVault({
      directory,
      secrets: createFakeSecrets({
        [credentialSecretRef(origin, 'first')]: 'one',
        [credentialSecretRef(origin, 'second')]: 'two',
      }),
      logger: makeRecordingLogger(),
      now: () => clock,
    });
    await later.ready;
    await later.record({ origin, username: 'first', password: 'rotated' });

    expect(later.listForOrigin(origin).map((entry) => entry.username)).toEqual(['first', 'second']);
    expect(later.listForOrigin(origin)[0]?.password).toBe('rotated');
    expect(later.count()).toBe(2);
  });

  it('keeps origins apart and reports the newest username per origin', async () => {
    const vault = createCredentialVault({
      directory,
      secrets: createFakeSecrets(),
      logger: makeRecordingLogger(),
      now: () => 1_000,
    });
    await vault.ready;
    await vault.record({ origin, username: 'admin', password: 'a' });
    await vault.record({ origin: otherOrigin, username: 'author', password: 'b' });

    expect(vault.listForOrigin(origin)).toHaveLength(1);
    expect(vault.latestUsername(origin)).toBe('admin');
    expect(vault.latestUsername(otherOrigin)).toBe('author');
    expect(vault.latestUsername('https://unknown.example.com')).toBeUndefined();
  });

  it('skips a stored entry whose secret is missing, and keeps the rest', async () => {
    await writeFile(
      path.join(directory, SIGN_IN_INDEX_FILE_NAME),
      JSON.stringify({
        entries: [
          { origin, username: 'admin', lastUsedAt: 2 },
          { origin, username: 'author', lastUsedAt: 1 },
        ],
      }),
      'utf8',
    );
    const secrets = createFakeSecrets({ [credentialSecretRef(origin, 'author')]: 'kept' });
    const logger = makeRecordingLogger();
    const vault = createCredentialVault({ directory, secrets, logger });

    await vault.ready;

    expect(vault.listForOrigin(origin)).toEqual([
      { origin, username: 'author', password: 'kept', lastUsedAt: 1 },
    ]);
    expect(logger.warn).toHaveBeenCalledWith('CREDENTIAL_LOAD_FAILED', { count: 1 });
  });

  it('treats a corrupt index as empty and logs it', async () => {
    await writeFile(path.join(directory, SIGN_IN_INDEX_FILE_NAME), '{ not json', 'utf8');
    const logger = makeRecordingLogger();
    const vault = createCredentialVault({
      directory,
      secrets: createFakeSecrets(),
      logger,
    });

    await vault.ready;

    expect(vault.count()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('CREDENTIAL_LOAD_FAILED', { count: 0 });
  });

  it('drops an index entry that is not a canonical http(s) origin', async () => {
    await writeFile(
      path.join(directory, SIGN_IN_INDEX_FILE_NAME),
      JSON.stringify({
        entries: [
          { origin: 'file:///c:/x', username: 'admin', lastUsedAt: 1 },
          { origin, username: 'admin', lastUsedAt: 2 },
        ],
      }),
      'utf8',
    );
    const vault = createCredentialVault({
      directory,
      secrets: createFakeSecrets({ [credentialSecretRef(origin, 'admin')]: 'kept' }),
      logger: makeRecordingLogger(),
    });

    await vault.ready;

    expect(vault.listForOrigin(origin)).toHaveLength(1);
    expect(vault.count()).toBe(1);
  });

  it('erases every secret and the index', async () => {
    const secrets = createFakeSecrets();
    const vault = createCredentialVault({
      directory,
      secrets,
      logger: makeRecordingLogger(),
      now: () => 1_000,
    });
    await vault.ready;
    await vault.record({ origin, username: 'admin', password: 'a' });
    await vault.record({ origin: otherOrigin, username: 'author', password: 'b' });

    const removed = await vault.eraseAll();

    expect(removed).toBe(2);
    expect(vault.count()).toBe(0);
    expect(secrets.values.size).toBe(0);
    await expect(readFile(path.join(directory, SIGN_IN_INDEX_FILE_NAME))).rejects.toThrow();
  });

  it('still erases the index when one secret cannot be deleted', async () => {
    const secrets = createFakeSecrets();
    const vault = createCredentialVault({
      directory,
      secrets,
      logger: makeRecordingLogger(),
      now: () => 1_000,
    });
    await vault.ready;
    await vault.record({ origin, username: 'admin', password: 'a' });
    secrets.delete.mockRejectedValueOnce(new Error('locked'));

    const removed = await vault.eraseAll();

    expect(removed).toBe(1);
    expect(vault.count()).toBe(0);
    await expect(readFile(path.join(directory, SIGN_IN_INDEX_FILE_NAME))).rejects.toThrow();
  });

  it('does not leave a replaced entry behind when the index write fails', async () => {
    const secrets = createFakeSecrets();
    const vault = createCredentialVault({
      directory,
      secrets,
      logger: makeRecordingLogger(),
      now: () => 1_000,
    });
    await vault.ready;
    await vault.record({ origin, username: 'admin', password: 'old' });

    // Make the directory unwritable by replacing it with a file: the temp write
    // then fails, and memory must keep the previous value rather than a promise
    // the next launch cannot honour.
    await rm(directory, { recursive: true, force: true });
    await writeFile(directory, 'not a directory', 'utf8');

    await expect(vault.record({ origin, username: 'admin', password: 'new' })).rejects.toThrow();
    expect(vault.listForOrigin(origin)[0]?.password).toBe('old');

    await rm(directory, { force: true });
  });
});
