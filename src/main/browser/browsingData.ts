import type { BrowsingDataScope } from '../../shared';

/**
 * Clearing the browser pane's stored state (the Settings "Browser" tab's
 * "Clear personal data" and "Clear storage" buttons).
 *
 * This module owns the *exact* split between the two scopes, in one place, so
 * the prose in `browserSection.ts` and the shipped behaviour cannot drift. It
 * deliberately knows nothing about Electron beyond the two narrow interfaces
 * below, so both scopes are unit-tested against fakes rather than a real
 * session.
 *
 * `sessionStorage` is the odd one out: Electron's `clearStorageData` has no
 * storage type for it (it is per-document memory, not an on-disk store), so the
 * `personal` scope runs `window.sessionStorage.clear()` inside every document
 * the pane's session owns - the browser view itself and any `window.open` SSO
 * popup. A document that cannot run script (a destroyed frame, `about:blank`)
 * is skipped; the cookie clear is the part that must succeed.
 */

/** What a `personal` clear removes from the session: the pane's own sign-in jar. */
const PERSONAL_STORAGES = ['cookies'] as const;

/**
 * What a `storage` clear removes: every on-disk store a site keeps for itself,
 * as Electron 44's `Storages` union names them. `indexdb` is Electron's spelling
 * of IndexedDB (its union has always used it), not a typo introduced here.
 */
const STORAGE_STORAGES = [
  'localstorage',
  'indexdb',
  'filesystem',
  'serviceworkers',
  'cachestorage',
  'shadercache',
] as const;

export type BrowsingDataStorage = (typeof STORAGE_STORAGES)[number] | 'cookies';

/**
 * The subset of `Session` this module touches. Taken as an interface rather
 * than the real type so a unit test can assert exactly which storages a scope
 * names without an Electron runtime.
 */
export interface BrowsingDataSession {
  clearStorageData(options: { storages: BrowsingDataStorage[] }): Promise<void>;
  clearCache(): Promise<void>;
}

/** The subset of `WebContents` a sessionStorage clear needs. */
export interface BrowsingDataDocument {
  isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

export interface BrowsingDataTargets {
  readonly session: BrowsingDataSession;
  /** Every live document in the pane's session (the pane itself and its SSO popups). */
  readonly documents: readonly BrowsingDataDocument[];
}

export interface BrowsingDataOutcome {
  /** Documents whose `sessionStorage` was cleared (`personal` only). */
  readonly clearedDocuments: number;
  /** Documents whose `sessionStorage` clear failed or was skipped (`personal` only). */
  readonly failedDocuments: number;
}

/**
 * Clears `scope`'s stored state. A rejected `clearStorageData`/`clearCache`
 * propagates - the caller reports the erase as failed - while an individual
 * document's `sessionStorage` failure is counted, not thrown: the cookies are
 * the part the user relies on, and one unscriptable frame must not undo them.
 */
export async function clearBrowsingData(
  scope: BrowsingDataScope,
  targets: BrowsingDataTargets,
): Promise<BrowsingDataOutcome> {
  if (scope === 'personal') {
    await targets.session.clearStorageData({ storages: [...PERSONAL_STORAGES] });
    return clearSessionStorage(targets.documents);
  }
  await targets.session.clearStorageData({ storages: [...STORAGE_STORAGES] });
  await targets.session.clearCache();
  return { clearedDocuments: 0, failedDocuments: 0 };
}

async function clearSessionStorage(
  documents: readonly BrowsingDataDocument[],
): Promise<BrowsingDataOutcome> {
  let cleared = 0;
  let failed = 0;
  for (const document of documents) {
    if (document.isDestroyed()) {
      failed += 1;
      continue;
    }
    try {
      await document.executeJavaScript('window.sessionStorage.clear()', true);
      cleared += 1;
    } catch {
      failed += 1;
    }
  }
  return { clearedDocuments: cleared, failedDocuments: failed };
}

/**
 * A document plus the session it belongs to - structurally what `WebContents`
 * already is, so this module never has to import Electron's full type and a
 * test can hand it plain objects.
 */
export interface SessionOwnedDocument {
  readonly session: object;
  isDestroyed(): boolean;
}

/** The live documents a session owns, for a `personal` clear. */
export function documentsInSession<T extends SessionOwnedDocument>(
  all: readonly T[],
  session: object,
): readonly T[] {
  return all.filter((contents) => !contents.isDestroyed() && contents.session === session);
}
