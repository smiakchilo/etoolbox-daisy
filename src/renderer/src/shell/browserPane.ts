import { el } from '../lib/dom';
import { createBrowserToolbar } from './browserToolbar';
import { createBrowserViewHost } from './browserViewHost';
import { createInsecureBanner } from './insecureBanner';
import type { InsecureMarkerState, ServerOption } from './viewModel';

export interface BrowserPane {
  readonly element: HTMLElement;
  update(state: {
    readonly addressValue: string;
    readonly serverOptions: readonly ServerOption[];
    readonly insecureMarker: InsecureMarkerState;
  }): void;
  /** Collapses/restores the native AEM view while the pane splitter is dragged - see `BrowserViewHost.setSuspended`. */
  setViewSuspended(suspended: boolean): void;
  dispose(): void;
}

/** The left-hand browser pane: toolbar, persistent insecure marker, and the reserved page-view region. */
export function createBrowserPane(): BrowserPane {
  const toolbar = createBrowserToolbar();
  const insecureBanner = createInsecureBanner();
  const viewHost = createBrowserViewHost();

  const element = el('section', {
    attrs: { class: 'pane browser-pane', 'aria-label': 'Browser' },
    children: [toolbar.element, toolbar.messageElement, insecureBanner.element, viewHost.element],
  });

  return {
    element,
    update(state): void {
      toolbar.setAddressValue(state.addressValue);
      toolbar.setServerOptions(state.serverOptions);
      insecureBanner.update(state.insecureMarker);
      viewHost.reportBoundsNow();
    },
    setViewSuspended(suspended: boolean): void {
      viewHost.setSuspended(suspended);
    },
    dispose(): void {
      toolbar.dispose();
      viewHost.dispose();
    },
  };
}
