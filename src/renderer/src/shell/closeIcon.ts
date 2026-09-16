/**
 * A hairline close (cross) glyph, drawn by us rather than by the Spectrum
 * icons. Spectrum's own crosses are *filled* shapes - the thinnest one
 * (cross600) is still a ~19% of-icon bar, which reads heavy at the panel
 * close button's enlarged size. This element strokes its own two lines
 * instead: at the panel's 32px render it draws roughly a 2px cross, about
 * a third as thick as the filled glyph.
 *
 * The stroke is `currentColor` (so it inherits the quiet action button's
 * content color and hovers correctly) and the width is a tunable custom
 * property, `--daisy-close-stroke-width` (default 1.5).
 */
export const CLOSE_ICON_TAG = 'daisy-close-icon';

const SVG_TEMPLATE = `        <svg
      viewBox="0 0 24 24"
      width="100%"
      height="100%"
      fill="none"
      role="img"
      aria-hidden="true"
    >
      <path
        d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5"
        stroke="currentColor"
        stroke-linecap="round"
      />
    </svg>
    <style>
      :host {
        display: inline-block;
        color: inherit;
      }
      path {
        stroke-width: var(--daisy-close-stroke-width, 1.5);
      }
    </style>`;

let registered = false;

/**
 * Registers the custom element exactly once.  Called from `createPanel`
 * (which only runs inside the real browser, never during unit-test import).
 */
export function registerCloseIcon(): void {
  if (registered) return;
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return;
  registered = true;

  class CloseIconElement extends HTMLElement {
    constructor() {
      super();
      const shadow = this.attachShadow({ mode: 'open' });
      const root = document.createElement('div');
      root.innerHTML = SVG_TEMPLATE;
      shadow.append(root);
    }
  }

  customElements.define(CLOSE_ICON_TAG, CloseIconElement);
}
