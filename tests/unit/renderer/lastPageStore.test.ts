import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isHostPageUrl,
  loadLastPageUrl,
  saveLastPageUrl,
  STORAGE_KEY,
} from '../../../src/renderer/src/lib/lastPageStore';
import { createWindowStorageInstaller, memoryStorage } from '../../support/memoryStorage';

/**
 * `lastPageStore.ts` touches nothing but `window.localStorage`, so a minimal
 * stub is enough - and it is the only way to exercise the "storage throws"
 * paths, which are exactly the paths that must not take the window down.
 * Mirrors tests/unit/renderer/paneLayoutStore.test.ts.
 */

const windowStorage = createWindowStorageInstaller();
const installStorage = windowStorage.install;

beforeEach(() => {
  installStorage(memoryStorage());
});

afterEach(() => {
  windowStorage.restore();
});

const HOST_ORIGINS = ['https://author.example'];

describe('last page persistence', () => {
  it('round-trips a page URL', () => {
    const url = 'https://author.example/editor.html/content/site/en/home.html';
    saveLastPageUrl(url);
    expect(loadLastPageUrl()).toBe(url);
  });

  it('reports no stored value on a first run', () => {
    expect(loadLastPageUrl()).toBeUndefined();
  });

  it('discards a stored value that is not a real http(s) address', () => {
    installStorage(memoryStorage({ [STORAGE_KEY]: 'about:blank' }));
    expect(loadLastPageUrl()).toBeUndefined();
  });

  it('discards a malformed stored value', () => {
    installStorage(memoryStorage({ [STORAGE_KEY]: 'not a url' }));
    expect(loadLastPageUrl()).toBeUndefined();
  });

  it('never writes a URL that could not be replayed', () => {
    const storage = memoryStorage();
    installStorage(storage);
    saveLastPageUrl('about:blank');
    saveLastPageUrl('file:///C:/secret.txt');
    saveLastPageUrl('');
    expect(Object.keys(storage.values)).toHaveLength(0);
  });

  it('survives storage that throws on read', () => {
    installStorage({
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => undefined,
    });
    expect(loadLastPageUrl()).toBeUndefined();
  });

  it('survives storage that throws on write', () => {
    installStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    });
    expect(() => saveLastPageUrl('https://author.example/')).not.toThrow();
  });
});

describe('isHostPageUrl', () => {
  it('accepts a deep link on a configured host', () => {
    expect(
      isHostPageUrl('https://author.example/editor.html/content/site.html', HOST_ORIGINS),
    ).toBe(true);
  });

  it('accepts the bare host origin itself', () => {
    expect(isHostPageUrl('https://author.example', HOST_ORIGINS)).toBe(true);
  });

  it('rejects a page on a different origin', () => {
    expect(isHostPageUrl('https://ims-na1.adobelogin.com/oauth', HOST_ORIGINS)).toBe(false);
  });

  it('rejects a non-http(s) address', () => {
    expect(isHostPageUrl('about:blank', HOST_ORIGINS)).toBe(false);
  });

  it('rejects any page when no hosts are configured', () => {
    expect(isHostPageUrl('https://author.example/page.html', [])).toBe(false);
  });
});
