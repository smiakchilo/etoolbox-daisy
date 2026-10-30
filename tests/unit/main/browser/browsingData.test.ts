import { describe, expect, it, vi } from 'vitest';
import {
  clearBrowsingData,
  documentsInSession,
  type BrowsingDataDocument,
  type BrowsingDataSession,
  type BrowsingDataStorage,
} from '../../../../src/main/browser/browsingData';

/**
 * The two clearing scopes' exact split, against fakes. The point of these cases
 * is that a `storage` clear never touches the cookie jar (it would sign the user
 * out of everything) and a `personal` clear never touches local data (it would
 * silently discard work the user did not ask to lose).
 */

function fakeSession(behaviour: { rejectClear?: boolean; rejectCache?: boolean } = {}) {
  const clearStorageData = vi.fn((options: { storages: BrowsingDataStorage[] }) => {
    void options;
    return behaviour.rejectClear === true
      ? Promise.reject(new Error('no profile'))
      : Promise.resolve();
  });
  const clearCache = vi.fn(() =>
    behaviour.rejectCache === true ? Promise.reject(new Error('no cache')) : Promise.resolve(),
  );
  const session: BrowsingDataSession = { clearStorageData, clearCache };
  return { session, clearStorageData, clearCache };
}

function fakeDocument(behaviour: { destroyed?: boolean; reject?: boolean } = {}) {
  const executeJavaScript = vi.fn((code: string) => {
    void code;
    return behaviour.reject === true
      ? Promise.reject(new Error('no document'))
      : Promise.resolve(true);
  });
  const document: BrowsingDataDocument = {
    isDestroyed: () => behaviour.destroyed === true,
    executeJavaScript,
  };
  return { document, executeJavaScript };
}

describe('clearBrowsingData', () => {
  describe('personal', () => {
    it('clears only the cookie jar, never local data, and never the cache', async () => {
      const { session, clearStorageData, clearCache } = fakeSession();

      await clearBrowsingData('personal', { session, documents: [] });

      expect(clearStorageData).toHaveBeenCalledWith({ storages: ['cookies'] });
      expect(clearCache).not.toHaveBeenCalled();
    });

    it("clears each open document's session storage", async () => {
      const { session } = fakeSession();
      const pane = fakeDocument();
      const popup = fakeDocument();

      const outcome = await clearBrowsingData('personal', {
        session,
        documents: [pane.document, popup.document],
      });

      expect(pane.executeJavaScript).toHaveBeenCalledWith('window.sessionStorage.clear()', true);
      expect(popup.executeJavaScript).toHaveBeenCalledWith('window.sessionStorage.clear()', true);
      expect(outcome).toEqual({ clearedDocuments: 2, failedDocuments: 0 });
    });

    it('counts an unscriptable document and still clears the others', async () => {
      const { session } = fakeSession();
      const unscriptable = fakeDocument({ reject: true });
      const gone = fakeDocument({ destroyed: true });
      const pane = fakeDocument();

      const outcome = await clearBrowsingData('personal', {
        session,
        documents: [unscriptable.document, gone.document, pane.document],
      });

      expect(outcome).toEqual({ clearedDocuments: 1, failedDocuments: 2 });
      expect(gone.executeJavaScript).not.toHaveBeenCalled();
    });

    it('propagates a rejected cookie clear - the caller reports the erase as failed', async () => {
      const { session } = fakeSession({ rejectClear: true });
      const pane = fakeDocument();

      await expect(
        clearBrowsingData('personal', { session, documents: [pane.document] }),
      ).rejects.toThrow('no profile');
      expect(pane.executeJavaScript).not.toHaveBeenCalled();
    });
  });

  describe('storage', () => {
    it('clears every local store and the cache, and never the cookies', async () => {
      const { session, clearStorageData, clearCache } = fakeSession();

      await clearBrowsingData('storage', { session, documents: [] });

      const storages = clearStorageData.mock.calls[0]?.[0].storages;
      expect(storages).toEqual(
        expect.arrayContaining([
          'localstorage',
          'indexdb',
          'filesystem',
          'serviceworkers',
          'cachestorage',
          'shadercache',
        ]),
      );
      expect(storages).not.toContain('cookies');
      expect(clearCache).toHaveBeenCalledTimes(1);
    });

    it('does not touch session storage of the open documents', async () => {
      const { session } = fakeSession();
      const pane = fakeDocument();

      await clearBrowsingData('storage', { session, documents: [pane.document] });

      expect(pane.executeJavaScript).not.toHaveBeenCalled();
    });

    it('propagates a rejected cache clear', async () => {
      const { session } = fakeSession({ rejectCache: true });

      await expect(clearBrowsingData('storage', { session, documents: [] })).rejects.toThrow(
        'no cache',
      );
    });
  });
});

describe('documentsInSession', () => {
  it('keeps the live documents the pane session owns and drops the rest', () => {
    const session = { name: 'pane' };
    const live = { session, isDestroyed: () => false };
    const destroyed = { session, isDestroyed: () => true };
    const otherSession = { session: { name: 'other' }, isDestroyed: () => false };

    const documents = documentsInSession([live, destroyed, otherSession], session);

    expect(documents).toEqual([live]);
  });
});
