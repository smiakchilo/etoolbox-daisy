import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearLastChat,
  loadLastChat,
  saveLastChat,
  STORAGE_KEY,
} from '../../../src/renderer/src/lib/lastChatStore';
import type { ChatId, SessionId, ServerId } from '../../../src/shared';
import { createWindowStorageInstaller, memoryStorage } from '../../support/memoryStorage';

/**
 * `lastChatStore.ts` touches nothing but `window.localStorage`, so a minimal
 * stub is enough - and it is the only way to exercise the "storage throws"
 * paths, which are exactly the paths that must not take the window down.
 * Mirrors `lastPageStore.test.ts`.
 */

const windowStorage = createWindowStorageInstaller();
const installStorage = windowStorage.install;

const record = {
  chatId: 'chat-1' as ChatId,
  sessionId: 'sdk-1' as SessionId,
  serverId: 'server-1' as ServerId,
};

beforeEach(() => {
  installStorage(memoryStorage());
});

afterEach(() => {
  windowStorage.restore();
});

describe('last chat persistence', () => {
  it('round-trips a chat id and session id', () => {
    saveLastChat(record);
    expect(loadLastChat()).toEqual(record);
  });

  it('reports no stored value on a first run', () => {
    expect(loadLastChat()).toBeUndefined();
  });

  it('discards a malformed stored value', () => {
    installStorage(memoryStorage({ [STORAGE_KEY]: 'not json' }));
    expect(loadLastChat()).toBeUndefined();
  });

  it('discards a record missing its session id', () => {
    installStorage(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ chatId: 'chat-1' }) }));
    expect(loadLastChat()).toBeUndefined();
  });

  it('discards a record missing its server id', () => {
    installStorage(
      memoryStorage({
        [STORAGE_KEY]: JSON.stringify({ chatId: 'chat-1', sessionId: 'sdk-1' }),
      }),
    );
    expect(loadLastChat()).toBeUndefined();
  });

  it('discards a record with an extra key', () => {
    installStorage(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ ...record, extra: 'nope' }) }));
    expect(loadLastChat()).toBeUndefined();
  });

  it('discards an over-long stored value rather than trusting it', () => {
    installStorage(memoryStorage({ [STORAGE_KEY]: `{"chatId":"${'x'.repeat(2000)}"}` }));
    expect(loadLastChat()).toBeUndefined();
  });

  it('clears the stored value', () => {
    saveLastChat(record);
    clearLastChat();
    expect(loadLastChat()).toBeUndefined();
  });

  it('survives storage that throws on read', () => {
    installStorage({
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(loadLastChat()).toBeUndefined();
  });

  it('survives storage that throws on write and on clear', () => {
    installStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    });
    expect(() => saveLastChat(record)).not.toThrow();
    expect(() => clearLastChat()).not.toThrow();
  });
});
