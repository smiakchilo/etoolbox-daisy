import { el } from '../lib/dom';
import type { UsageRow } from '../chat/sessionUsage';
import { createPanel, type Panel } from './panel';

/**
 * The conversation's usage details, as a whole-size panel over the browser
 * pane's page-view region (`panel.ts`) - the same surface Settings and History
 * use. Opened by the chat footer's token gauge. It is deliberately dumb: the
 * chat pane projects the usage into {@link UsageRow}s and hands them over; the
 * panel only draws them (as text, never markup).
 */
export interface UsagePanel extends Panel {
  /** Replaces the rows; a no-op when they are unchanged, so it may be called freely. */
  setRows(rows: readonly UsageRow[]): void;
}

export interface UsagePanelOptions {
  /** Fired when the close (cross) button or Escape dismisses the panel. */
  readonly onDismiss: () => void;
}

export function createUsagePanel(options: UsagePanelOptions): UsagePanel {
  let shown = '';
  const list = el('div', {
    attrs: { class: 'usage-panel__list', role: 'list', 'aria-label': 'Conversation usage' },
  });

  const panel = createPanel({
    title: 'Usage',
    closeAriaLabel: 'Close usage',
    surfaceClassName: 'usage-panel',
    testId: 'usage-panel',
    content: list,
    onDismiss(): void {
      options.onDismiss();
    },
  });

  return {
    get element() {
      return panel.element;
    },
    get isOpen() {
      return panel.isOpen;
    },
    open: () => panel.open(),
    close: () => panel.close(),
    setCloseable: (closeable) => panel.setCloseable(closeable),
    dispose: () => panel.dispose(),
    setRows(rows): void {
      const key = JSON.stringify(rows);
      if (key === shown) return;
      shown = key;
      list.replaceChildren(
        ...rows.map((row) =>
          el('div', {
            attrs: {
              class: 'usage-row',
              role: 'listitem',
              'data-testid': `usage-row-${row.id}`,
            },
            children: [
              el('span', { attrs: { class: 'usage-row__label' }, text: row.label }),
              el('span', { attrs: { class: 'usage-row__value' }, text: row.value }),
            ],
          }),
        ),
      );
    },
  };
}
