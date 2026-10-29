import type { BrowserWindow, Session } from 'electron';
import type { AddonModule } from '../../shared';
import { createPageAuditToolFactory } from './tool';

/**
 * The page-audit add-on's entry point, loaded by the application with a real
 * `import()` and asked to `activate(host)` once.
 *
 * The application knows nothing about auditing: it advertises the tool from the
 * pins, hands this module a generic host (a hidden window, the sessions, the
 * address policy, the pane URL, a log line) and forwards the model's calls. This
 * module owns the whole capability - the run, the window and session hardening,
 * its libraries and the report it paints.
 *
 * Nothing here reaches `src/main`: the add-on is downloaded to `%LOCALAPPDATA%`
 * and there is no application source beside it.
 */

/** The API version this build implements; the application accepts only its own. */
export const apiVersion = 1;

export const addon: AddonModule<BrowserWindow, Session> = {
  apiVersion,
  activate(host) {
    return { tools: { page_audit: createPageAuditToolFactory(host) } };
  },
};
