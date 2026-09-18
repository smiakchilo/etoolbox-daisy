import { el } from './dom';

/**
 * Shared status/prompt row builder for the two `sp-alert-banner` surfaces:
 * the browser pane's toolbar message (`shell/browserToolbar.ts`) and the
 * Settings panel's single status slot (`settings/statusBanner.ts`).
 *
 * The two surfaces keep their own root class (`.browser-toolbar-message` /
 * `.settings-banner`) as a *surface* class on top of the shared `banner-row`
 * base, because both rows are mounted in the same document at once (Settings
 * opens over the browser pane) and Playwright strict-mode locators rely on
 * `.browser-toolbar-message` / `.settings-banner` matching exactly one
 * element. Every rule the two can honestly share lives in `styles/banner.css`
 * under `.banner-row`; the surface classes carry only what genuinely differs
 * (browser: the loading presentation, the progress line, in-flow flex;
 * settings: absolute bottom pinning, the fade-out).
 *
 * The row height is pinned by `.banner-row` in banner.css: the component's
 * `.text` slot margins (`--mod-alert-banner-*-text`) are neutralized and the
 * strip is held at the theme's 48px minimum, so a row containing a 32px
 * `sp-action-button` is exactly as tall as a plain-text row.
 */

/** The shared root class every banner row carries. */
export const BANNER_ROW_CLASS = 'banner-row';
/** The shared message-copy wrapper class. */
export const BANNER_ROW_COPY_CLASS = 'banner-row__copy';
/** The shared action-button group class. */
export const BANNER_ROW_ACTIONS_CLASS = 'banner-row__actions';

/**
 * Builds the `sp-alert-banner` row for a given surface. `surfaceClass` names
 * the owning surface (`browser-toolbar-message` or `settings-banner`); the
 * element always carries `variant="neutral"` and starts `dismissible`, which
 * each surface toggles as its presentations change (the browser removes it
 * for the loading row, Settings re-derives it per slot).
 */
export function createBannerRow(surfaceClass: string): HTMLElement {
  return el('sp-alert-banner', {
    attrs: {
      class: `${BANNER_ROW_CLASS} ${surfaceClass}`,
      variant: 'neutral',
      dismissible: '',
    },
  });
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
