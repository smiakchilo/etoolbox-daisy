import type { PageAuditRunner } from '../../shared';
import { createPageAudit, type PageAuditAddonDeps } from './pageAudit';

/**
 * The page-audit add-on's entry point, loaded by the application with
 * `import(pathToFileURL(entry))`.
 *
 * The application builds the dependencies (the pane's session, the window
 * factory, the address policy) and hands them in; this module owns only the
 * Lighthouse run. Nothing here reaches `src/main`: the add-on is downloaded to
 * `%LOCALAPPDATA%` and there is no application source beside it.
 */

/** The API version this build implements; the application accepts only its own. */
export const apiVersion = 1;

export type CreatePageAuditRunner = (deps: PageAuditAddonDeps) => PageAuditRunner;

export function createPageAuditRunner(deps: PageAuditAddonDeps): PageAuditRunner {
  return createPageAudit(deps);
}
