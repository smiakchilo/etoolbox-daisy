import { el } from '../lib/dom';
import type { InsecureMarkerState } from './viewModel';

/**
 * Persistent insecure-connection marker (requirements-decisions.md sections 4
 * and 8): stays in the DOM as long as the active server is plain HTTP, never
 * a transient toast. Colour (negative/red) is always paired with icon +
 * explicit text, never colour alone.
 */
export interface InsecureBanner {
  readonly element: HTMLElement;
  update(state: InsecureMarkerState): void;
}

export function createInsecureBanner(): InsecureBanner {
  const statusLight = el('sp-status-light', {
    attrs: { variant: 'negative', size: 's' },
  });
  const banner = el('div', {
    attrs: { class: 'insecure-banner', role: 'status' },
    children: [statusLight],
  });
  banner.hidden = true;

  return {
    element: banner,
    update(state: InsecureMarkerState): void {
      banner.hidden = !state.visible;
      statusLight.textContent = state.message;
    },
  };
}
