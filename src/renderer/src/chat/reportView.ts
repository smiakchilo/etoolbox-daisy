import type {
  ToolReportBlock,
  ToolReportCell,
  ToolReportEntry,
  ToolReportMessage,
  ToolReportSection,
  ToolReportTreeNode,
} from '../../../shared';
import {
  EMPTY_AEM_LINKIFY_STATE,
  type AemLinkifyState,
  type LinkContext,
  splitAemPathLinks,
} from './linkTargets';
import { renderLinkSegment } from './linkSegmentDom';
import { el } from '../lib/dom';
import { statusLightVariant } from './tableCells';
import type { TableExportData } from './tableExport';

/**
 * The DOM rendering of a `presentation: 'report'` tool's settled message:
 * one structured message of collapsible sections, each holding its findings as
 * collapsible entries, each entry holding its evidence
 * blocks (tables, checklists, a node, a nested request tree, or a text
 * paragraph). Every cell is set through `textContent`; nothing here parses
 * model- or page-authored markup, and a raw HTML snippet is drawn as a
 * `<code>` block, never as markup.
 *
 * The accordion *state* (which rubrics are collapsed, which one entry is open)
 * lives in the transcript view (`transcriptView.ts`), exactly like a tool-call
 * billet's expansion: this module renders the structure once, and the caller
 * applies the state in place via {@link applyReportState}, so a settled report
 * is never rebuilt on an unrelated repaint.
 */

/** The report's own accordion state, owned by the transcript view. */
export interface ReportState {
  /** Rubric titles the reader has collapsed (rubrics are expanded by default). */
  readonly collapsedRubrics: ReadonlySet<string>;
  /** The one entry id currently expanded (entries are collapsed by default). */
  readonly expandedEntry: string | undefined;
}

/** A comparable signature of a report message, for the caller's render cache. */
export function reportSignature(message: ToolReportMessage): string {
  return JSON.stringify(message);
}

/** One report table's shell and the data its Copy/Export gutter serializes. */
export interface ReportTableExport {
  readonly shell: HTMLElement;
  readonly data: TableExportData;
}

/** What {@link renderReportMessage} produces: the nodes to paint and the tables a gutter can act on. */
export interface RenderedReport {
  readonly nodes: readonly HTMLElement[];
  readonly tables: readonly ReportTableExport[];
}

/** Collects the table exports while the report is rendered. */
type TableSink = ReportTableExport[];

/** The `data-*` attribute holding a rubric's title on its **toggle**. */
const RUBRIC_ATTR = 'data-report-rubric';
/** The attribute holding a rubric's title on its **body** (a distinct value, so a click on the body or its contents never looks like a toggle click). */
const RUBRIC_BODY_ATTR = 'data-report-rubric-body';
/** The `data-*` attribute holding an entry's id on its **toggle**. */
const ENTRY_ATTR = 'data-report-entry';
/** The attribute holding an entry's id on its **body**. */
const ENTRY_BODY_ATTR = 'data-report-entry-body';

function formatMs(value: number): string {
  return `${String(Math.round(value))} ms`;
}

function formatBytes(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1024) return `${String(Math.round(value))} B`;
  if (absolute < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** A cell's display text, for cells that are not themselves structured (a status light's word). */
function cellText(cell: ToolReportCell): string {
  switch (cell.kind) {
    case 'text':
      return cell.value;
    case 'selector':
      return [cell.label, cell.selector, cell.snippet, cell.explanation]
        .filter((part) => part !== undefined && part !== '')
        .join(' — ');
    case 'list':
      return cell.items
        .map(cellText)
        .filter((part) => part !== '')
        .join('; ');
  }
}

/**
 * The linkified text of a plain `text` cell, plus the linkify carry-over. This
 * mirrors the `format_table` cell rule exactly: a cell with no link is plain
 * wrapped text; a cell containing an absolute URL or an AEM path renders its
 * segments through the shared linkifier.
 */
function renderText(
  value: string,
  header: string,
  context: LinkContext,
  state: AemLinkifyState,
): { readonly nodes: readonly Node[]; readonly linkState: AemLinkifyState } {
  const linked = splitAemPathLinks(value, context, state);
  const nextState = linked.state;
  if (!linked.segments.some((segment) => segment.kind === 'link')) {
    const span = el('span', { text: value });
    span.className =
      header === 'Value' || header === 'Citation'
        ? 'chat-table-message__clamp'
        : 'chat-table-message__wrap';
    return { nodes: [span], linkState: nextState };
  }
  return {
    nodes: linked.segments.map((segment) => renderLinkSegment(document, segment)),
    linkState: nextState,
  };
}

/** A failing element: label, a clickable selector, its raw HTML as code, and the explanation. */
function renderSelector(cell: Extract<ToolReportCell, { kind: 'selector' }>): HTMLElement {
  const node = el('span', { attrs: { class: 'chat-report-cell__node' } });
  if (cell.label !== undefined) {
    node.append(el('span', { attrs: { class: 'chat-report-cell__label' }, text: cell.label }));
  }
  node.append(
    el('button', {
      attrs: {
        type: 'button',
        class: 'chat-report-selector',
        'data-daisy-selector': cell.selector,
        title: 'Show in the page',
      },
      text: cell.selector,
    }),
  );
  if (cell.snippet !== undefined) {
    node.append(el('code', { attrs: { class: 'chat-report-cell__snippet' }, text: cell.snippet }));
  }
  if (cell.explanation !== undefined) {
    node.append(
      el('span', { attrs: { class: 'chat-report-cell__explanation' }, text: cell.explanation }),
    );
  }
  return node;
}

/**
 * One report-table cell, as nodes plus the linkify carry-over. A `status`
 * column draws a status light; otherwise the cell's own `kind` decides: plain
 * linkified text, a failing element, or a list of paragraphs (sub-items).
 */
function renderCell(
  cell: ToolReportCell,
  columnKind: 'text' | 'status',
  header: string,
  context: LinkContext,
  state: AemLinkifyState,
): { readonly nodes: readonly Node[]; readonly linkState: AemLinkifyState } {
  if (columnKind === 'status') {
    const text = cellText(cell);
    if (text.trim() === '') return { nodes: [], linkState: state };
    return {
      nodes: [
        el('sp-status-light', {
          attrs: {
            class: 'chat-report-table__status',
            size: 's',
            variant: statusLightVariant(text),
          },
          text,
        }),
      ],
      linkState: state,
    };
  }
  switch (cell.kind) {
    case 'text':
      return renderText(cell.value, header, context, state);
    case 'selector':
      return { nodes: [renderSelector(cell)], linkState: state };
    case 'list': {
      const container = el('div', { attrs: { class: 'chat-report-cell__list' } });
      let nextState = state;
      for (const item of cell.items) {
        const rendered = renderCell(item, 'text', header, context, nextState);
        nextState = rendered.linkState;
        container.append(
          el('p', {
            attrs: { class: 'chat-report-cell__list-item' },
            children: rendered.nodes,
          }),
        );
      }
      return { nodes: [container], linkState: nextState };
    }
  }
}

/** One report table block: an `sp-table` over its typed rows, with a leading `#` index. */
function renderTableBlock(
  block: Extract<ToolReportBlock, { kind: 'table' }>,
  context: LinkContext,
  tables: TableSink,
): HTMLElement {
  // A table block is a `chat-table-message` shell (the same class a
  // `format_table` run renders), so the shared gutter (`tableHover.ts`) gives it
  // the Copy/Export popover; the title uses the shell's own title class so the
  // gutter's "table-only message" test passes.
  const shell = el('div', { attrs: { class: 'chat-table-message chat-report-table' } });
  const kinds = block.columns.map((column) => column.kind ?? 'text');
  if (block.title !== undefined) {
    shell.append(el('p', { attrs: { class: 'chat-table-message__title' }, text: block.title }));
  }
  if (block.rows.length > 0) {
    const head = el('sp-table-head', {});
    head.append(el('sp-table-head-cell', { text: '#' }));
    for (const column of block.columns) {
      head.append(el('sp-table-head-cell', { text: column.label }));
    }
    const body = el('sp-table-body', {});
    let linkState = EMPTY_AEM_LINKIFY_STATE;
    block.rows.forEach((row, index) => {
      const rowEl = el('sp-table-row', {});
      rowEl.append(
        el('sp-table-cell', {
          attrs: { class: 'chat-report-table__index' },
          text: String(index + 1),
        }),
      );
      block.columns.forEach((column, columnIndex) => {
        const cell = el('sp-table-cell', {});
        const rendered = renderCell(
          row[columnIndex] ?? { kind: 'text', value: '' },
          kinds[columnIndex] ?? 'text',
          column.label,
          context,
          linkState,
        );
        linkState = rendered.linkState;
        cell.append(...rendered.nodes);
        rowEl.append(cell);
      });
      body.append(rowEl);
    });
    const table = el('sp-table', { attrs: { class: 'chat-report-table__table', size: 's' } });
    table.append(head, body);
    shell.append(table);
  }
  tables.push({
    shell,
    data: {
      columns: block.columns.map((column) => column.label),
      rows: block.rows.map((row) =>
        block.columns.map((_, index) => cellText(row[index] ?? { kind: 'text', value: '' })),
      ),
      total: undefined,
    },
  });
  return shell;
}

/** A checklist block: each labelled check on its own line. */
function renderChecklistBlock(block: Extract<ToolReportBlock, { kind: 'checklist' }>): HTMLElement {
  const shell = el('div', { attrs: { class: 'chat-report-checklist' } });
  for (const item of block.items) {
    shell.append(
      el('p', {
        attrs: { class: 'chat-report-checklist__item' },
        children: [
          el('span', { attrs: { class: 'chat-report-checklist__label' }, text: item.label }),
          el('span', { attrs: { class: 'chat-report-checklist__value' }, text: item.value }),
        ],
      }),
    );
  }
  return shell;
}

/** A standalone element (the LCP element, etc.), not inside a table. */
function renderNodeBlock(block: Extract<ToolReportBlock, { kind: 'node' }>): HTMLElement {
  const node = el('div', { attrs: { class: 'chat-report-node' } });
  if (block.label !== undefined) {
    node.append(el('span', { attrs: { class: 'chat-report-cell__label' }, text: block.label }));
  }
  if (block.selector !== undefined) {
    node.append(
      el('button', {
        attrs: {
          type: 'button',
          class: 'chat-report-selector',
          'data-daisy-selector': block.selector,
          title: 'Show in the page',
        },
        text: block.selector,
      }),
    );
  }
  if (block.snippet !== undefined) {
    node.append(el('code', { attrs: { class: 'chat-report-cell__snippet' }, text: block.snippet }));
  }
  if (block.explanation !== undefined) {
    node.append(
      el('span', { attrs: { class: 'chat-report-cell__explanation' }, text: block.explanation }),
    );
  }
  return node;
}

/** Flattens a request tree into indented rows (depth-first). */
function flattenTree(
  nodes: readonly ToolReportTreeNode[],
  depth: number,
  out: { readonly node: ToolReportTreeNode; readonly depth: number }[],
): void {
  for (const node of nodes) {
    out.push({ node, depth });
    flattenTree(node.children, depth + 1, out);
  }
}

/** A nested request tree, drawn as an indented table (Request / Duration / Transfer size). */
function renderTreeBlock(
  block: Extract<ToolReportBlock, { kind: 'tree' }>,
  tables: TableSink,
): HTMLElement {
  const shell = el('div', { attrs: { class: 'chat-table-message chat-report-table' } });
  if (block.title !== undefined) {
    shell.append(el('p', { attrs: { class: 'chat-table-message__title' }, text: block.title }));
  }
  const rows: { readonly node: ToolReportTreeNode; readonly depth: number }[] = [];
  flattenTree(block.roots, 0, rows);
  if (rows.length > 0) {
    const head = el('sp-table-head', {});
    head.append(el('sp-table-head-cell', { text: '#' }));
    head.append(el('sp-table-head-cell', { text: 'Request' }));
    head.append(el('sp-table-head-cell', { text: 'Duration' }));
    head.append(el('sp-table-head-cell', { text: 'Transfer size' }));
    const body = el('sp-table-body', {});
    rows.forEach(({ node, depth }, index) => {
      const rowEl = el('sp-table-row', {});
      rowEl.append(
        el('sp-table-cell', {
          attrs: { class: 'chat-report-table__index' },
          text: String(index + 1),
        }),
      );
      const request = el('sp-table-cell', {});
      request.append(
        el('span', {
          attrs: { class: 'chat-report-tree__request' },
          text: node.url,
        }),
      );
      request.style.setProperty('--tree-depth', String(depth));
      rowEl.append(request);
      rowEl.append(
        el('sp-table-cell', {
          text: node.durationMs === undefined ? '' : formatMs(node.durationMs),
        }),
      );
      rowEl.append(
        el('sp-table-cell', {
          text: node.transferBytes === undefined ? '' : formatBytes(node.transferBytes),
        }),
      );
      body.append(rowEl);
    });
    const table = el('sp-table', { attrs: { class: 'chat-report-table__table', size: 's' } });
    table.append(head, body);
    shell.append(table);
  }
  tables.push({
    shell,
    data: {
      columns: ['Request', 'Duration', 'Transfer size'],
      rows: rows.map(({ node, depth }) => [
        `${'  '.repeat(depth)}${node.url}`,
        node.durationMs === undefined ? '' : formatMs(node.durationMs),
        node.transferBytes === undefined ? '' : formatBytes(node.transferBytes),
      ]),
      total: undefined,
    },
  });
  return shell;
}

/** One evidence block under an entry. */
function renderBlock(block: ToolReportBlock, context: LinkContext, tables: TableSink): HTMLElement {
  switch (block.kind) {
    case 'table':
      return renderTableBlock(block, context, tables);
    case 'checklist':
      return renderChecklistBlock(block);
    case 'node':
      return renderNodeBlock(block);
    case 'tree':
      return renderTreeBlock(block, tables);
    case 'text': {
      // A text block is a paragraph of the tool's own prose (a finding with no
      // items carries its explanation here); linkify it the same way a table
      // cell is, so the "Learn more" URL in it is clickable like every other.
      const rendered = renderText(block.value, '', context, EMPTY_AEM_LINKIFY_STATE);
      return el('p', { attrs: { class: 'chat-report-text' }, children: rendered.nodes });
    }
  }
}

function renderEntry(entry: ToolReportEntry, context: LinkContext, tables: TableSink): HTMLElement {
  const shell = el('div', { attrs: { class: 'chat-report-entry' } });
  const toggle = el('button', {
    attrs: {
      type: 'button',
      class: 'chat-report-entry__toggle',
      [ENTRY_ATTR]: entry.id,
      'aria-expanded': 'false',
      title: 'Show details',
    },
  });
  toggle.append(
    el('sp-icon-chevron-down', { attrs: { class: 'chat-report-entry__chevron', size: 's' } }),
    el('span', { attrs: { class: 'chat-report-entry__title' }, text: entry.title }),
  );
  if (entry.displayValue !== undefined) {
    toggle.append(
      el('span', { attrs: { class: 'chat-report-entry__value' }, text: entry.displayValue }),
    );
  }
  const body = el('div', {
    attrs: { class: 'chat-report-entry__body', [ENTRY_BODY_ATTR]: entry.id, hidden: '' },
  });
  for (const block of entry.blocks) {
    body.append(renderBlock(block, context, tables));
  }
  shell.append(toggle, body);
  return shell;
}

function renderSection(
  section: ToolReportSection,
  context: LinkContext,
  tables: TableSink,
): HTMLElement {
  const shell = el('div', { attrs: { class: 'chat-report-section' } });
  const toggle = el('button', {
    attrs: {
      type: 'button',
      class: 'chat-report-section__toggle',
      [RUBRIC_ATTR]: section.title,
      'aria-expanded': 'true',
      title: 'Hide section',
    },
  });
  toggle.append(
    el('sp-icon-chevron-down', { attrs: { class: 'chat-report-section__chevron', size: 's' } }),
    el('span', { attrs: { class: 'chat-report-section__title' }, text: section.title }),
  );
  const body = el('div', {
    attrs: { class: 'chat-report-section__body', [RUBRIC_BODY_ATTR]: section.title },
  });
  for (const entry of section.entries) {
    body.append(renderEntry(entry, context, tables));
  }
  shell.append(toggle, body);
  return shell;
}

/**
 * Renders the whole report message's **content** - the summary table and the
 * rubric sections - as the nodes to put inside the report's shell, plus each
 * table's shell and export data so the caller can hang Copy/Export off it.
 * Rubrics render expanded and entries collapsed; the caller then applies its
 * state with {@link applyReportState}.
 *
 * The nodes are returned rather than wrapped in a container so the transcript
 * can make the assistant-message shell itself the `.chat-report-message` (the
 * same shape a `format_table` message uses), with no redundant nested wrapper.
 */
export function renderReportMessage(
  message: ToolReportMessage,
  context: LinkContext,
): RenderedReport {
  const nodes: HTMLElement[] = [];
  const tables: TableSink = [];
  if (message.summary !== undefined) {
    nodes.push(renderTableBlock(message.summary, context, tables));
  }
  for (const section of message.sections) {
    nodes.push(renderSection(section, context, tables));
  }
  return { nodes, tables };
}

/**
 * Applies an accordion state to an already-rendered report, in place, so a
 * settled report is never rebuilt when the reader collapses or expands a
 * heading.
 */
export function applyReportState(container: HTMLElement, state: ReportState): void {
  for (const toggle of Array.from(container.querySelectorAll<HTMLElement>(`[${RUBRIC_ATTR}]`))) {
    const title = toggle.getAttribute(RUBRIC_ATTR) ?? '';
    const collapsed = state.collapsedRubrics.has(title);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('title', collapsed ? 'Show section' : 'Hide section');
    toggle.classList.toggle('chat-report-section__toggle--collapsed', collapsed);
    const body = container.querySelector<HTMLElement>(`[${RUBRIC_BODY_ATTR}="${title}"]`);
    if (body !== null) body.hidden = collapsed;
  }
  for (const toggle of Array.from(container.querySelectorAll<HTMLElement>(`[${ENTRY_ATTR}]`))) {
    const id = toggle.getAttribute(ENTRY_ATTR) ?? '';
    const expanded = state.expandedEntry === id;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('title', expanded ? 'Hide details' : 'Show details');
    toggle.classList.toggle('chat-report-entry__toggle--expanded', expanded);
    const body = container.querySelector<HTMLElement>(`[${ENTRY_BODY_ATTR}="${id}"]`);
    if (body !== null) body.hidden = !expanded;
  }
}
