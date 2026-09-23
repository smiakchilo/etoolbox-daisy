import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearLastChat,
  loadLastChat,
  saveLastChat,
} from '../../../src/renderer/src/lib/lastChatStore';
import type { ChatId, SdkSessionId, ServerId } from '../../../src/shared';

/**
 * `lastChatStore.ts` touches nothing but `window.localStorage`, so a minimal
 * stub is enough - and it is the only way to exercise the "storage throws"
 * paths, which are exactly the paths that must not take the window down.
 * Mirrors `lastPageStore.test.ts`.
 */

interface StubStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const previousWindow = Reflect.get(globalThis, 'window') as unknown;
const STORAGE_KEY = 'daisy.mainShell.lastChat';

function installStorage(storage: StubStorage): void {
  Reflect.set(globalThis, 'window', { localStorage: storage });
}

function memoryStorage(seed: Record<string, string> = {}): StubStorage & {
  readonly values: Record<string, string>;
} {
  const values: Record<string, string> = { ...seed };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
    removeItem: (key) => {
      delete values[key];
    },
  };
}

const record = {
  chatId: 'chat-1' as ChatId,
  sdkSessionId: 'sdk-1' as SdkSessionId,
  serverId: 'server-1' as ServerId,
};

beforeEach(() => {
  installStorage(memoryStorage());
});

afterEach(() => {
  Reflect.set(globalThis, 'window', previousWindow);
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
        [STORAGE_KEY]: JSON.stringify({ chatId: 'chat-1', sdkSessionId: 'sdk-1' }),
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
