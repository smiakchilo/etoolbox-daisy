import type { HoverAction, HoverActionPlacement } from './hoverActionPopover';
import { type TableExportData, hasTableContent } from './tableExport';

/**
 * Where a `format_table` message's **gutter** is, and what its hover popover
 * offers.
 *
 * The gutter has exactly **two bands**, each with its own fixed position:
 *
 * - the **header band** - the column header row, and - while the message holds
 *   nothing but the table, its heading and its total line - everything in the
 *   message above it (the heading, the top padding). Its popover sits on the
 *   table's top-right edge, exactly as hovering the header row always did;
 * - the **footer band** - the total line the table draws, and everything in the
 *   message below the table (the gap under the last row, the bottom padding). Its
 *   popover sits on the footer line itself; for a table that draws no total line
 *   there is no line to sit on, so it hangs **just below the table's bottom
 *   edge**, beside the pointer - never up over the last row, whose height would
 *   make the distance unpredictable.
 *
 * An ordinary data row (`sp-table-body`) is deliberately never part of either
 * band: hovering a cell is how the reader opens that cell's own link/CRX
 * popover, and the two affordances must not fight over the same pixel. The
 * message's **side padding alongside the rows** is inert too - it belongs to
 * neither band, so a pointer travelling down the side cannot drag the popover
 * between the two positions.
 *
 * The bands exist only while the message holds nothing but the table, its
 * heading and its total line: a message that also carries prose keeps the
 * popover on the table's own chrome, so the reader never gets Copy/Export over
 * words that are not the table.
 *
 * Split out from `transcriptView.ts` so the region test (a `closest` plus the
 * table's own geometry) and the action composition are unit-testable under
 * jsdom, where the real Spectrum overlay - and so the popover itself - never
 * exists.
 */

/** Which band of a table message the pointer is in - the message's two affordances. */
export type TableGutterBand = 'header' | 'footer';

/** A pointer sitting on a table-message gutter: where to hang the popover, the shell owning the table, and the band. */
export interface TableGutterHit {
  readonly anchor: HTMLElement;
  readonly shell: HTMLElement;
  readonly band: TableGutterBand;
  /** Which point of `anchor` the popover hangs off - above its top, or below its bottom. */
  readonly placement: HoverActionPlacement;
}

/** The assistant message node a `format_table` run paints into. */
const TABLE_MESSAGE_SELECTOR = '.chat-table-message';

/** The column header row, which is the header band's anchor. */
const TABLE_HEADER_SELECTOR = '.chat-table-message sp-table-head';

/** The total line, which is the footer band's anchor. */
const TABLE_TOTAL_SELECTOR = '.chat-table-message .chat-table-message__total';

/** A table's data rows, which are never the gutter. */
const TABLE_DATA_SELECTOR = 'sp-table-body';

/**
 * What a table-only message may hold besides the table: its heading, and the
 * total line the table itself draws.
 */
const TABLE_MESSAGE_CONTENT_SELECTOR =
  'sp-table, .chat-table-message__title, .chat-table-message__total';

/**
 * Whether `target` is inside a table's data rows - the one part of a table
 * message that is never the gutter, however much of the message around it is.
 */
export function isTableDataRow(target: EventTarget | null): boolean {
  return ((target as Element | null)?.closest?.(TABLE_DATA_SELECTOR) ?? null) !== null;
}

/**
 * Whether `shell` is a message whose only content is the table, its heading and
 * its total line - the condition for the message's own surface to form the two
 * bands.
 */
function isTableOnlyMessage(shell: HTMLElement): boolean {
  const children = [...shell.children];
  return (
    children.some((child) => child.matches('sp-table')) &&
    children.every((child) => child.matches(TABLE_MESSAGE_CONTENT_SELECTOR))
  );
}

/**
 * The footer band's popover: the total line when the table draws one (the
 * popover sits just above it), else the table itself with the popover hanging
 * off its **bottom edge** - so the buttons stay beside the pointer instead of
 * rising over the last row.
 */
function footerGutter(
  shell: HTMLElement,
  table: HTMLElement,
): Pick<TableGutterHit, 'anchor' | 'placement'> {
  const total = shell.querySelector<HTMLElement>('.chat-table-message__total');
  return total === null
    ? { anchor: table, placement: 'bottom-end' }
    : { anchor: total, placement: 'top-end' };
}

/**
 * The gutter under `target`, if any, split into its two bands. `pointerY` is the
 * pointer's viewport y (a `PointerEvent`'s `clientY`): it decides which band a
 * point on the message's own surface is in, because that surface lies both above
 * the table and below it.
 */
export function tableGutterFrom(
  target: EventTarget | null,
  pointerY: number,
): TableGutterHit | undefined {
  const element = target as Element | null;
  if (typeof element?.closest !== 'function') return undefined;

  const shell = element.closest<HTMLElement>(TABLE_MESSAGE_SELECTOR);
  if (shell === null) return undefined;

  // The table's own chrome is unambiguous: the header row and the total line
  // each anchor their own band.
  const header = element.closest<HTMLElement>(TABLE_HEADER_SELECTOR);
  if (header !== null) return { anchor: header, shell, band: 'header', placement: 'top-end' };
  const total = element.closest<HTMLElement>(TABLE_TOTAL_SELECTOR);
  if (total !== null) return { anchor: total, shell, band: 'footer', placement: 'top-end' };

  // The message's own surface: split it above/below the table. A data row is
  // never the gutter, and the side padding alongside the rows belongs to neither
  // band.
  if (isTableDataRow(element) || !isTableOnlyMessage(shell)) return undefined;
  const table = shell.querySelector<HTMLElement>('sp-table');
  if (table === null) return undefined;

  const headerBand = table.querySelector<HTMLElement>('sp-table-head');
  const tableRect = table.getBoundingClientRect();
  const headerBottom =
    headerBand === null ? tableRect.top : headerBand.getBoundingClientRect().bottom;
  if (pointerY <= headerBottom) {
    return headerBand === null
      ? undefined
      : { anchor: headerBand, shell, band: 'header', placement: 'top-end' };
  }
  if (pointerY >= tableRect.bottom) {
    return { ...footerGutter(shell, table), shell, band: 'footer' };
  }
  return undefined;
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
