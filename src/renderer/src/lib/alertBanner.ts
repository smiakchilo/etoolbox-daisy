import { el } from './dom';

/**
 * Shared status/prompt row builder for the shell's three `sp-alert-banner`
 * surfaces: the browser pane's toolbar message (`shell/browserToolbar.ts`),
 * the browser pane's pane-owned surface-status row for the panels it hosts -
 * Settings today (`shell/browserPane.ts`, `settings/statusBanner.ts`) - and
 * the chat pane's single status slot (also `settings/statusBanner.ts`, mounted
 * by `shell/chatPane.ts`).
 *
 * Each surface owns exactly one row and keeps its own root class
 * (`.browser-toolbar-message` / `.surface-status-banner` /
 * `.chat-status-banner`) as a *surface* class on top of the shared
 * `banner-row` base, because the rows are mounted in the same document at once
 * (Settings opens over the browser pane) and Playwright strict-mode locators
 * rely on each matching exactly one
 * element. Every rule they can honestly share lives in `styles/banner.css`
 * under `.banner-row`; the surface classes carry only what genuinely differs.
 * The loading presentation - a light-gray fill plus an indeterminate progress
 * line (`.banner-row--loading` / `createBannerProgressLine`) - is shared by
 * the browser pane's "Loading\u2026" row and the chat pane's "Connecting to
 * agent..." row, so the two are visibly the same kind of row.
 *
 * One row per surface is the invariant that keeps two banners from stacking: a
 * later message *suppresses* the former by taking that single row. Within
 * `statusBanner.ts` this is the priority slot (`prompt > error > notice >
 * status`) plus a persistent lowest-priority "standing" floor the chat pane uses
 * for its "no usable agent" prompt; `browserToolbar.ts` applies its own priority
 * (loading > certificate prompt > unknown-origin prompt > error) to the one
 * row it owns.
 *
 * **Copy is a label, never a sentence: no message row ends with a period.**
 * "Settings saved", "No agent available. Browsing AEM still works", "Exported to
 * table-20261014-101530.csv". A period inside is fine where two statements need
 * separating; a trailing one is never added (a real E2E failed once for exactly
 * that mismatch - see AGENTS.md §11).
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
/** The shared loading-presentation class: a light-gray fill and a progress line. */
export const BANNER_ROW_LOADING_CLASS = 'banner-row--loading';
/**
 * The shared attention-flash class, added for one prompt and dropped when the
 * fade ends. Its declarations - and the `@keyframes` - are shared with the
 * composer's ask-user flash in `styles/attention.css`, so a confirmation prompt
 * and a new question are literally the same wash; see {@link flashBannerRow}.
 */
export const BANNER_ATTENTION_CLASS = 'banner-row--attention';
/** The `@keyframes` name a row's `animationend` listener filters the flash on. */
export const BANNER_ATTENTION_ANIMATION = 'app-attention-flash';
/**
 * The class a blocking confirmation puts on the region it blocks (the pane's
 * page-view slot: the panel, the home veil or the hosts picker behind it). The
 * class paints a white veil over the region - everything under it fades to the
 * weight of disabled content while the surface stays light - so the dark prompt
 * strip below stands out against it. The *blocking* itself is the `inert`
 * attribute the owning banner also sets, so pointer, keyboard and assistive
 * technology are all covered by one declarative switch rather than by per
 * control disabling.
 */
export const BANNER_BLOCKED_SCOPE_CLASS = 'banner-blocked-scope';
/** The shared message-copy wrapper class. */
export const BANNER_ROW_COPY_CLASS = 'banner-row__copy';
/**
 * The token a prompt's copy string uses to say where its action button(s) sit
 * *inside* the sentence, e.g. `'Press {action} to allow it'`. Only ever used
 * with app-authored copy: {@link buildBannerPrompt} replaces it with the button
 * inline, so the control flows right beside the text instead of being pushed
 * onto its own line or into a separate column. Copy with no token gets its
 * buttons appended inline after the sentence.
 */
export const BANNER_ACTION_MARKER = '{action}';

/** How long the shared reveal/collapse animation runs, in milliseconds. */
export const BANNER_TRANSITION_DURATION_MS = 150;

const BANNER_REVEALING_CLASS = 'banner-row--revealing';
export const BANNER_CLOSING_CLASS = 'banner-row--closing';
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
 * Runs a row's one-time attention flash: the accent wash shared with the
 * composer's ask-user question (see `styles/attention.css`). Once per prompt,
 * removed by the row's own `animationend` listener as the fade ends - which is
 * also what stops a repaint from replaying it. Removing the class and forcing a
 * layout flush first means a prompt arriving before the previous flash has
 * finished (two Delete presses well under a second apart) still replays it,
 * instead of being coalesced into the running animation - exactly the composer's
 * behaviour.
 */
export function flashBannerRow(row: HTMLElement): void {
  row.classList.remove(BANNER_ATTENTION_CLASS);
  void row.offsetWidth;
  row.classList.add(BANNER_ATTENTION_CLASS);
}

/**
 * Builds the `sp-alert-banner` row for a given surface. `surfaceClass` names
 * the owning surface (`browser-toolbar-message` or `surface-status-banner`);
 * the element always carries `variant="neutral"` and starts `dismissible` - the
 * default for every row, so the close control is present unless a presentation
 * says otherwise (see {@link applyBannerPresentation}).
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
  // shorter than its 48px minimum). The attention wash is dropped the same way,
  // keyed on its own animation name so the row's reveal never clears it and
  // vice versa.
  row.addEventListener('animationend', (event) => {
    if (event.animationName === 'banner-row-reveal') {
      row.classList.remove(BANNER_REVEALING_CLASS);
    } else if (event.animationName === BANNER_ATTENTION_ANIMATION) {
      row.classList.remove(BANNER_ATTENTION_CLASS);
    }
  });
  return row;
}

/**
 * How a banner row is presenting right now. This is the single input the close
 * control is derived from - the rule lives here, not at the call sites.
 *
 * - `default`   - a message or prompt the user may wave away. Dismissible.
 * - `loading`   - work in flight (the shared light fill + progress line).
 *                 There is nothing to dismiss, so no close control.
 * - `transient` - an auto-hiding acknowledgement such as "Settings saved". It
 *                 clears itself, so no close control.
 * - `hidden`    - the row is torn down or not showing. No close control, so a
 *                 closed row never leaves one behind.
 */
export type BannerPresentation = 'default' | 'loading' | 'transient' | 'hidden';

/**
 * Applies a presentation's close-control rule to a row, centrally:
 * {@link BannerPresentation} `default` carries the dismiss cross; `loading`,
 * `transient` and `hidden` do not. Also toggles the shared loading class, which
 * is part of the same presentation. `createBannerRow` already starts a row
 * dismissible, so a surface calls this at each presentation change instead of
 * adding or removing `dismissible` itself.
 */
export function applyBannerPresentation(row: HTMLElement, presentation: BannerPresentation): void {
  row.classList.toggle(BANNER_ROW_LOADING_CLASS, presentation === 'loading');
  row.toggleAttribute('dismissible', presentation === 'default');
}

/**
 * Builds the indeterminate progress line pinned to a loading row's top edge -
 * a hand-copied rendering of Spectrum's `sp-progress-bar` size="s" sweep (see
 * `styles/banner.css`'s `.banner-row__progress*`), because the
 * `@spectrum-web-components/progress-bar` package is not a project dependency.
 * Shared by the browser pane's "Loading\u2026" row and the chat pane's
 * "Connecting to agent..." row so both present identically. The caller is
 * responsible for the row's `banner-row--loading` class.
 */
export function createBannerProgressLine(): HTMLElement {
  return el('div', {
    attrs: { class: 'banner-row__progress' },
    children: [el('div', { attrs: { class: 'banner-row__progress-fill' } })],
  });
}

/**
 * The one action-button idiom every banner surface uses. Always `size="s"`:
 * a banner action sits *inside* a text line, where the default (m) button
 * would dominate the row's height. Centralised here so each surface - Settings
 * status/prompt rows, the chat pane's agent banner, the browser toolbar's
 * certificate/origin prompts - gets the same size without having to remember
 * to ask for it.
 */
export function createBannerActionButton(label: string, testId?: string): HTMLElement {
  return el('sp-action-button', {
    attrs: testId === undefined ? { size: 's' } : { size: 's', 'data-testid': testId },
    text: label,
  });
}

/**
 * Normalises the text/control boundaries of a composed row so a control is
 * never glued to a word. A prompt copy that marks the button's place with
 * {@link BANNER_ACTION_MARKER} almost always already spaces it ("Press
 * {action} to allow"), but a copy that names no place at all - "Timed out.
 * Check the address" - has its button appended straight onto the end, which
 * rendered as "addressReload": no visual gap, and the row's own text copied as
 * one word. Every boundary is therefore spaced here, in the one place parts
 * become nodes, instead of at each call site.
 */
function withControlSpacing(parts: readonly (string | Node)[]): (string | Node)[] {
  const spaced: (string | Node)[] = [];
  for (const part of parts) {
    const previous = spaced[spaced.length - 1];
    const isText = typeof part === 'string';
    const previousIsText = typeof previous === 'string';
    if (!isText && previousIsText && previous !== '' && !/\s$/.test(previous)) {
      spaced.push(' ');
    } else if (
      isText &&
      previous !== undefined &&
      !previousIsText &&
      part !== '' &&
      !/^\s/.test(part)
    ) {
      spaced.push(' ');
    }
    spaced.push(part);
  }
  return spaced;
}

/**
 * Builds the `_copy` span for a row whose sentence embeds controls inline (the
 * chat pane's "Activate an agent in <Settings> to send messages" row, and every
 * prompt/notice row via {@link buildBannerPrompt}). `parts` are appended in
 * order; strings become text nodes. The controls are ordinary inline parts of
 * the sentence, so they flow beside the text and wrap with it rather than
 * landing on their own line - and a missing space between a control and the
 * text beside it is supplied by {@link withControlSpacing}, so no call site has
 * to remember it.
 */
export function buildBannerCopy(parts: readonly (string | Node)[]): HTMLElement {
  const span = el('span', { attrs: { class: BANNER_ROW_COPY_CLASS } });
  for (const part of withControlSpacing(parts)) {
    span.append(typeof part === 'string' ? document.createTextNode(part) : part);
  }
  return span;
}

/**
 * Builds the `_copy` span for a prompt/confirm row (the certificate and
 * unknown-origin prompts, the Settings confirmations) with its action
 * button(s) placed *inline in the sentence*, exactly like {@link buildBannerCopy}.
 *
 * `copy` marks the button's place with {@link BANNER_ACTION_MARKER} - e.g.
 * `'Untrusted certificate. Press {action} to allow'` - and
 * the first button replaces that token, so text follows the control and the
 * control can never be orphaned on a line of its own. Any further buttons
 * replace further tokens; buttons left over when there are no more tokens are
 * appended inline after the sentence. Only app-authored copy is passed here
 * (dynamic text such as an error message must use `buildBannerCopy` directly),
 * so the marker can never collide with user content.
 */
export function buildBannerPrompt(
  copy: string,
  actionButtons: readonly HTMLElement[],
): readonly HTMLElement[] {
  const parts: (string | Node)[] = [];
  const segments = copy.split(BANNER_ACTION_MARKER);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment !== undefined && segment !== '') parts.push(segment);
    const button = actionButtons[index];
    if (button !== undefined) parts.push(button);
  }
  // Buttons with no marker left to sit in are appended inline after the copy.
  for (let index = segments.length; index < actionButtons.length; index += 1) {
    const button = actionButtons[index];
    if (button !== undefined) parts.push(button);
  }
  return [buildBannerCopy(parts)];
}
