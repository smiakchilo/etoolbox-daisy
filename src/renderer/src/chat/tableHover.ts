import type { HoverAction } from './hoverActionPopover';
import { type TableExportData, hasTableContent } from './tableExport';

/**
 * Where a `format_table` message's **gutter** is, and what its hover popover
 * offers.
 *
 * The gutter is the table's chrome, not its data: the **column header row**
 * (`sp-table-head`, the upper area the headers sit in) and the **total line**
 * (`.chat-table-message__total`, below the rows). An ordinary data row
 * (`sp-table-body`) is deliberately not part of it - hovering a cell is how the
 * reader opens that cell's own link/CRX popover, and the two affordances must
 * not fight over the same pixel.
 *
 * Split out from `transcriptView.ts` so the region test (a `closest` on a real
 * DOM subtree) and the action composition are unit-testable under jsdom, where
 * the real Spectrum overlay - and so the popover itself - never exists.
 */

/** A pointer sitting on a table-message gutter: the element to anchor the popover to, and the shell owning the table. */
export interface TableGutterHit {
  readonly anchor: HTMLElement;
  readonly shell: HTMLElement;
}

/**
 * The header row or the total line, but never a data row. `closest` matches an
 * ancestor-or-self, so a pointer on a header *cell* resolves to its
 * `sp-table-head`, and one on the total spinner resolves to the total line.
 */
const TABLE_GUTTER_POINTER_SELECTOR =
  '.chat-table-message sp-table-head, .chat-table-message .chat-table-message__total';

/** The gutter under `target`, if any. */
export function tableGutterFrom(target: EventTarget | null): TableGutterHit | undefined {
  const anchor =
    ((target as Element | null)?.closest?.(TABLE_GUTTER_POINTER_SELECTOR) as HTMLElement | null) ??
    null;
  if (anchor === null) return undefined;
  const shell = anchor.closest<HTMLElement>('.chat-table-message');
  if (shell === null) return undefined;
  return { anchor, shell };
}

export interface TableHoverHandlers {
  readonly onCopy: (data: TableExportData) => void;
  readonly onExport: (data: TableExportData) => void;
}

/**
 * The gutter's two actions, bound to `data`. An empty array when there is no
 * table to act on (a run with no columns), so the caller shows nothing rather
 * than buttons that would do nothing.
 */
export function tableHoverActions(
  data: TableExportData,
  handlers: TableHoverHandlers,
): readonly HoverAction[] {
  if (!hasTableContent(data)) return [];
  return [
    {
      id: 'copy',
      title: 'Copy',
      icon: 'sp-icon-copy',
      onActivate: () => handlers.onCopy(data),
    },
    {
      id: 'export',
      title: 'Export',
      icon: 'sp-icon-export',
      onActivate: () => handlers.onExport(data),
    },
  ];
}
