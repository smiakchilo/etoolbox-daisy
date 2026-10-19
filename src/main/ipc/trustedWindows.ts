/**
 * The set of `WebContents` that belong to this app's own local UI.
 *
 * Before this existed, the settings IPC guard compared the sender against a
 * single `mainWebContentsId` captured at registration time. That was correct
 * while the app had exactly one window, but the Settings window
 * (requirements-decisions.md section 8) is a *separate* `BrowserWindow`
 * created later, on demand, with its own `webContents.id`. It could therefore
 * never satisfy the guard, and every settings request it made was refused.
 *
 * Membership is explicit rather than inferred from `BrowserWindow.getAllWindows()`:
 * the browser `WebContentsView` hosts remote content and must never be trusted, so
 * "a window this app happens to own" is not the same question as "our own
 * privileged local UI".
 */
export interface TrustedWindowRegistry {
  /** Marks a local app window's `webContents.id` as trusted. */
  add(webContentsId: number): void;
  /**
   * Revokes trust, e.g. once a window has closed. Ids are not reused in
   * practice, but a registry that only ever grows would keep trusting a
   * destroyed window.
   */
  remove(webContentsId: number): void;
  /** The predicate the IPC guards consult. */
  has(webContentsId: number): boolean;
}

export function createTrustedWindowRegistry(
  initialIds: readonly number[] = [],
): TrustedWindowRegistry {
  const ids = new Set<number>(initialIds);
  return {
    add(webContentsId) {
      ids.add(webContentsId);
    },
    remove(webContentsId) {
      ids.delete(webContentsId);
    },
    has(webContentsId) {
      return ids.has(webContentsId);
    },
  };
}
