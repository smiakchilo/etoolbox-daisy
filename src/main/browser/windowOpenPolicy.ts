import { decideAllowedUrl } from './urlPolicy';

/**
 * The new-window policy for the browser pane's remote content.
 *
 * A new-window request is one of two things, and the pane treats them
 * differently:
 *
 *  - a **popup** - Chromium's `new-window` disposition, which it derives from a
 *    `window.open(url, name, features)` whose features ask for a real window
 *    (`width`/`height`/`popup`/...). These are the SSO/login dialogs. They need
 *    a real, separate window because the page may talk back to it through
 *    `window.opener` (`postMessage`, `popup.closed` polling,
 *    `opener.location = ...`); suppressing the window would break the flow, so
 *    popups are left alone.
 *  - a **tab** - every other disposition (`default`, `foreground-tab`,
 *    `background-tab`, `other`): a `target="_blank"` link/form, or a bare
 *    `window.open(url)`. These mean "show me this content", not a back-channel,
 *    so they load in the pane's own view instead: the chat pane keeps
 *    describing what is on screen, and the hop is a history entry Back rewinds.
 *
 * `disposition` is the authoritative signal: Chromium parses the feature string
 * and decides popup-vs-tab itself. Do **not** infer it from `features` being
 * non-empty - `window.open(url, name, "noopener")` (which AEM's own Sites
 * "Edit" action uses) and `"noreferrer"` are non-empty feature strings that
 * Chromium still classifies as `foreground-tab`. The measured matrix lives in
 * this module's unit tests.
 *
 * Pure, so the popup/tab decision has a direct unit test with no real Electron
 * `WebContents` involved.
 */
export interface WindowOpenRequest {
  readonly url: string;
  readonly disposition: 'default' | 'foreground-tab' | 'background-tab' | 'new-window' | 'other';
}

export type WindowOpenDecision =
  { readonly kind: 'popup' } | { readonly kind: 'navigate-in-place' } | { readonly kind: 'deny' };

export function decideWindowOpen(request: WindowOpenRequest): WindowOpenDecision {
  if (decideAllowedUrl(request.url).kind !== 'allow') {
    return { kind: 'deny' };
  }
  if (request.disposition === 'new-window') {
    return { kind: 'popup' };
  }
  return { kind: 'navigate-in-place' };
}
