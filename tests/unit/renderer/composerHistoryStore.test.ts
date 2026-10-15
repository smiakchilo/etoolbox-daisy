import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadComposerHistory,
  saveComposerHistory,
  STORAGE_KEY,
} from '../../../src/renderer/src/lib/composerHistoryStore';
import { COMPOSER_HISTORY_LIMIT } from '../../../src/renderer/src/chat/composerHistory';
import { createWindowStorageInstaller, memoryStorage } from '../../support/memoryStorage';

/**
 * `composerHistoryStore.ts` touches nothing but `window.localStorage`, so a
 * minimal stub is enough - and it is the only way to exercise the "storage
 * throws" paths, which are exactly the paths that must not take the window
 * down. Mirrors tests/unit/renderer/lastPageStore.test.ts.
 */

const windowStorage = createWindowStorageInstaller();
const installStorage = windowStorage.install;

beforeEach(() => {
  installStorage(memoryStorage());
});

afterEach(() => {
  windowStorage.restore();
});

describe('composer history persistence', () => {
  it('round-trips the remembered prompts, oldest first', () => {
    saveComposerHistory(['first', 'second']);
    expect(loadComposerHistory()).toEqual(['first', 'second']);
  });

  it('reports an empty history on a first run', () => {
    expect(loadComposerHistory()).toEqual([]);
  });

  it('discards a stored document that is not a JSON array', () => {
    installStorage(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ nope: true }) }));
    expect(loadComposerHistory()).toEqual([]);
  });

  it('discards a stored document that is not valid JSON', () => {
    installStorage(memoryStorage({ [STORAGE_KEY]: 'not json {' }));
    expect(loadComposerHistory()).toEqual([]);
  });

  it('drops non-string and blank entries from a hand-edited document', () => {
    installStorage(
      memoryStorage({ [STORAGE_KEY]: JSON.stringify(['keep', 42, '', '   ', null, 'also']) }),
    );
    expect(loadComposerHistory()).toEqual(['keep', 'also']);
  });

  it('keeps only the newest entries when the stored document is over the limit', () => {
    const stored = Array.from({ length: COMPOSER_HISTORY_LIMIT + 4 }, (_, i) => `p${i}`);
    installStorage(memoryStorage({ [STORAGE_KEY]: JSON.stringify(stored) }));

    const loaded = loadComposerHistory();
    expect(loaded).toHaveLength(COMPOSER_HISTORY_LIMIT);
    expect(loaded[loaded.length - 1]).toBe(`p${COMPOSER_HISTORY_LIMIT + 3}`);
  });

  it('never writes more than the limit', () => {
    const storage = memoryStorage();
    installStorage(storage);
    const entries = Array.from({ length: COMPOSER_HISTORY_LIMIT + 4 }, (_, i) => `p${i}`);

    saveComposerHistory(entries);

    expect(JSON.parse(storage.values[STORAGE_KEY] ?? '[]')).toEqual(
      entries.slice(-COMPOSER_HISTORY_LIMIT),
    );
  });

  it('survives storage that throws on read', () => {
    installStorage({
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => undefined,
    });
    expect(loadComposerHistory()).toEqual([]);
  });

  it('survives storage that throws on write', () => {
    installStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    });
    expect(() => saveComposerHistory(['prompt'])).not.toThrow();
  });
});
