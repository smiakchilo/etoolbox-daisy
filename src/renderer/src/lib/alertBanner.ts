import { el } from './dom';

/**
 * Shared status/prompt row builder for the shell's three `sp-alert-banner`
 * surfaces: the browser pane's toolbar message (`shell/browserToolbar.ts`),
 * the Settings panel's single status slot (`settings/statusBanner.ts`) and
 * the chat pane's standing "no usable agent" row (`chat/agentBanner.ts`).
 *
 * Each surface keeps its own root class (`.browser-toolbar-message` /
 * `.settings-banner` / `.chat-banner`) as a *surface* class on top of the
 * shared `banner-row` base, because the rows are mounted in the same document
 * at once (Settings opens over the browser pane) and Playwright strict-mode
 * locators rely on each matching exactly one element. Every rule they can
 * honestly share lives in `styles/banner.css` under `.banner-row`; the
 * surface classes carry only what genuinely differs (browser: the loading
 * presentation and its progress line).
 *
 * The row height is pinned by `.banner-row` in banner.css: the component's
 * `.text` slot margins (`--mod-alert-banner-*-text`) are neutralized and the
 * strip is held at the theme's 48px minimum, so a row containing a size-s
 * `sp-action-button` (see `createBannerActionButton`) is exactly as tall as a
 * plain-text row. That same stylesheet clamps a row's message to three lines
 * and gives it the button's own line height when one shares the line.
 *
 * Both rows are revealed/collapsed by animating their own `block-size`
 * (`banner.css`'s `banner-row--revealing` / `banner-row--closing`), which is
 * what lets the content region above the row - the native `WebContentsView`'s
 * reserved rectangle, or the Settings tab content - shrink/grow gradually
 * instead of snapping. The banner itself carries no opacity/slide animation:
 * it cannot paint above the native view, so it is simply uncovered from the
 * bottom edge as the region above it gives up the space. Because the row's
 * resting height depends on its content (and its 48px minimum), the helpers
 * here measure it and pass it to the keyframes through `--banner-row-height`
 * (a fixed target would clip a wrapped message).
 */

/** The shared root class every banner row carries. */
export const BANNER_ROW_CLASS = 'banner-row';
/** The shared message-copy wrapper class. */
export const BANNER_ROW_COPY_CLASS = 'banner-row__copy';
/** The shared action-button group class. */
export const BANNER_ROW_ACTIONS_CLASS = 'banner-row__actions';

/** How long the shared reveal/collapse animation runs, in milliseconds. */
export const BANNER_TRANSITION_DURATION_MS = 150;

const BANNER_REVEALING_CLASS = 'banner-row--revealing';
const BANNER_CLOSING_CLASS = 'banner-row--closing';
const BANNER_HEIGHT_VAR = '--banner-row-height';
const BANNER_DURATION_VAR = '--banner-row-transition-duration';
const PREFERS_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** True when the user has asked the OS to minimize motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(PREFERS_REDUCED_MOTION_QUERY).matches
  );
}

/** Pins the shared animation duration for a row (JS timer and CSS agree). */
export function configureBannerTransition(
  row: HTMLElement,
  durationMs: number = BANNER_TRANSITION_DURATION_MS,
): void {
  row.style.setProperty(BANNER_DURATION_VAR, `${durationMs}ms`);
}

/** True while the row is mid-collapse. */
export function isBannerClosing(row: HTMLElement): boolean {
  return row.classList.contains(BANNER_CLOSING_CLASS);
}

/** Unwinds any in-flight reveal/collapse, leaving the row at its natural height. */
export function restoreBannerRow(row: HTMLElement): void {
  row.classList.remove(BANNER_REVEALING_CLASS, BANNER_CLOSING_CLASS);
  row.style.removeProperty(BANNER_HEIGHT_VAR);
}

/**
 * Plays the reveal: measures the row's resting height (with `open` already
 * set) and animates `block-size` from 0 up to it. Under reduced motion the
 * row is left at rest, so nothing animates.
 */
export function revealBannerRow(row: HTMLElement): void {
  restoreBannerRow(row);
  if (prefersReducedMotion()) return;
  const height = row.getBoundingClientRect().height;
  // Zero means the row (or an ancestor) is not laid out - e.g. it lives in the
  // browser pane's page panel while a whole-size panel covers it. There is
  // nothing to animate and no correct target, so leave it at rest; it appears
  // at full height when its region returns.
  if (height <= 0) return;
  row.style.setProperty(BANNER_HEIGHT_VAR, `${height}px`);
  row.classList.add(BANNER_REVEALING_CLASS);
}

/**
 * Starts the collapse from the row's current height. Returns false when there
 * is nothing to animate (reduced motion), so the caller can tear the row down
 * synchronously instead.
 */
export function collapseBannerRow(row: HTMLElement): boolean {
  const height = row.getBoundingClientRect().height;
  row.classList.remove(BANNER_REVEALING_CLASS);
  if (prefersReducedMotion()) return false;
  row.style.setProperty(BANNER_HEIGHT_VAR, `${height}px`);
  row.classList.add(BANNER_CLOSING_CLASS);
  return true;
}

/**
 * Builds the `sp-alert-banner` row for a given surface. `surfaceClass` names
 * the owning surface (`browser-toolbar-message` or `settings-banner`); the
 * element always carries `variant="neutral"` and starts `dismissible`, which
 * each surface toggles as its presentations change (the browser removes it
 * for the loading row, Settings re-derives it per slot).
 */
export function createBannerRow(surfaceClass: string): HTMLElement {
  const row = el('sp-alert-banner', {
    attrs: {
      class: `${BANNER_ROW_CLASS} ${surfaceClass}`,
      variant: 'neutral',
      dismissible: '',
    },
  });
  // The reveal class also removes the component's 48px minimum for the
  // animation's duration; drop it the instant the animation ends so the
  // resting height is restored (a lingering class would leave a plain text row
  // shorter than its 48px minimum).
  row.addEventListener('animationend', (event) => {
    if (event.animationName === 'banner-row-reveal') {
      row.classList.remove(BANNER_REVEALING_CLASS);
    }
  });
  return row;
}

/**
 * The one action-button idiom every banner surface uses. Always `size="s"`:
 * a banner action sits *inside* a text line, where the default (m) button
 * would dominate the row's height. Centralised here so each surface - Settings
 * status/prompt rows, the chat pane's agent banner, the browser toolbar's
 * certificate/origin prompts - gets the same size without having to remember
 * to ask for it.
 */
export function createBannerActionButton(label: string): HTMLElement {
  return el('sp-action-button', { attrs: { size: 's' }, text: label });
}

/**
 * Builds the `_copy` span for a row whose sentence embeds a control inline
 * (the chat pane's "Activate an agent in <Settings> to send messages" row),
 * where the control must sit *inside* the sentence rather than in the
 * trailing action group. `parts` are appended in order; strings become text
 * nodes. Use {@link buildBannerPrompt} instead when the controls belong in the
 * trailing `_actions` group.
 */
export function buildBannerCopy(parts: readonly (string | Node)[]): HTMLElement {
  const span = el('span', { attrs: { class: BANNER_ROW_COPY_CLASS } });
  for (const part of parts) {
    span.append(typeof part === 'string' ? document.createTextNode(part) : part);
  }
  return span;
}

/**
 * Builds the `_copy` span + `_actions` span pair for a prompt/confirm row
 * (the certificate and unknown-origin prompts, the Settings confirmations).
 * `actionButtons` is usually a single `sp-action-button`; the actions host
 * keeps the buttons side by side and the 12px `margin-inline-start` seam
 * (banner.css) keeps them on one line after the copy.
 */
export function buildBannerPrompt(
  copy: string,
  actionButtons: readonly HTMLElement[],
): readonly HTMLElement[] {
  return [
    el('span', { attrs: { class: BANNER_ROW_COPY_CLASS }, text: copy }),
    el('span', {
      attrs: { class: BANNER_ROW_ACTIONS_CLASS },
      children: [...actionButtons],
    }),
  ];
}
