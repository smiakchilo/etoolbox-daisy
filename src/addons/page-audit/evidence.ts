import type {
  ToolReportBlock,
  ToolReportCell,
  ToolReportColumn,
  ToolReportNodeBlock,
  ToolReportTableBlock,
  ToolReportTreeBlock,
  ToolReportTreeNode,
} from '../../shared';

/**
 * Turns one failed Lighthouse audit into the **report blocks** the transcript
 * paints under it: usually one table, but an insight can carry several - a
 * table plus the element it names, a checklist, a nested request tree. Each
 * block is typed data, never markup: the renderer draws a table's columns and
 * rows, a failing element's label/selector/snippet/explanation, and a tree as
 * an indented table.
 *
 * The shapes are Lighthouse's own (`types/lhr/audit-details.d.ts`): a `table`
 * or `opportunity` carries headings and items, a `list` carries sections or
 * bare items, a `checklist` a label/value map, a `network-tree` a nested chain
 * map. Debug data, screenshots, filmstrips and treemaps are not evidence a
 * reader can act on (a screenshot is a base64 image), so an audit carrying only
 * those falls back to Lighthouse's own explanation of the problem.
 */

/** One column heading of a Lighthouse details table. */
export interface LighthouseHeading {
  readonly key?: string | null;
  readonly label?: unknown;
  readonly valueType?: string;
  readonly displayUnit?: string;
  readonly subItemsHeading?: { readonly key?: string; readonly valueType?: string };
}

/** The `details` member of a Lighthouse audit result. */
export interface LighthouseDetails {
  readonly type?: string;
  readonly headings?: unknown;
  readonly items?: unknown;
  readonly debugData?: unknown;
}

/** The parts of an audit result the evidence needs. */
export interface LighthouseAudit {
  readonly title: string;
  readonly description?: unknown;
  readonly displayValue?: string;
  readonly metricSavings?: unknown;
  readonly details?: LighthouseDetails;
}

/**
 * `format_table` (which paints report tables through the same machinery) caps a
 * table at 20 columns and a column label at 60 characters, so the evidence is
 * shaped to fit rather than being refused.
 */
const MAX_COLUMNS = 20;
const MAX_LABEL_LENGTH = 60;
/**
 * A ceiling on one cell's text, not on how many items are listed: Lighthouse
 * itself truncates a console error's text at 10 KB, and a stack trace that long
 * in one table cell makes the row unreadable. The evidence keeps every item; a
 * single over-long value ends in an ellipsis.
 */
const MAX_CELL_LENGTH = 2000;

const SUB_ITEMS_COLUMN_KEY = 'evidence-sub-items';
const SUB_ITEMS_COLUMN_LABEL = 'Sub items';

type KeyedHeading = LighthouseHeading & { readonly key: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

/** A localized string, a number, a boolean, or the object form of an ICU message. */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (!isRecord(value)) return undefined;
  return asText(value['value']) ?? asText(value['displayString']) ?? asText(value['text']);
}

/** The non-empty parts, once each, in order - the same snippet twice reads as a mistake. */
function unique(parts: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    if (part === undefined || part === '') continue;
    if (seen.has(part)) continue;
    seen.add(part);
    kept.push(part);
  }
  return kept;
}

function humanBytes(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1024) return `${String(Math.round(value))} B`;
  if (absolute < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** A number with the unit Lighthouse's own report shows it in. */
function formatNumber(value: number, valueType: string | undefined, displayUnit?: string): string {
  if (valueType === 'bytes') return humanBytes(value);
  if (valueType === 'ms' || valueType === 'timespanMs') return `${String(Math.round(value))} ms`;
  const unit = displayUnit?.trim();
  if (unit === undefined || unit === '') return String(value);
  return unit === '%' ? `${String(value)}%` : `${String(value)} ${unit}`;
}

function cellText(text: string): string {
  return text.length <= MAX_CELL_LENGTH ? text : `${text.slice(0, MAX_CELL_LENGTH - 1)}…`;
}

/** `url:line:column`, rendered one-indexed the way Lighthouse's report does. */
function sourceLocationText(value: Record<string, unknown>): string {
  const url = asText(value['url']);
  const line = value['line'];
  const column = value['column'];
  const location =
    url === undefined
      ? undefined
      : typeof line !== 'number'
        ? url
        : typeof column === 'number'
          ? `${url}:${String(line + 1)}:${String(column)}`
          : `${url}:${String(line + 1)}`;
  const original = isRecord(value['original']) ? value['original'] : undefined;
  const file = original === undefined ? undefined : (asText(original['file']) ?? '(unmapped)');
  const originalLine = original?.['line'];
  const originalColumn = original?.['column'];
  const mapped =
    file === undefined
      ? undefined
      : typeof originalLine !== 'number'
        ? file
        : typeof originalColumn === 'number'
          ? `${file}:${String(originalLine + 1)}:${String(originalColumn)}`
          : `${file}:${String(originalLine + 1)}`;
  if (location === undefined) return mapped ?? '';
  return mapped === undefined ? location : `${location} (source-mapped from ${mapped})`;
}

function linkText(value: Record<string, unknown>): string {
  const text = asText(value['text']);
  const url = asText(value['url']);
  if (text === undefined) return url ?? '';
  return url === undefined || url === text ? text : `${text} (${url})`;
}

function isEmptyCell(cell: ToolReportCell): boolean {
  switch (cell.kind) {
    case 'text':
      return cell.value === '';
    case 'selector':
      return cell.selector === '' && (cell.snippet ?? '') === '' && (cell.label ?? '') === '';
    case 'list':
      return cell.items.length === 0;
  }
}

/** The display text of a cell, for joining a sub-item's parts into one paragraph. */
function textOfCell(cell: ToolReportCell): string {
  switch (cell.kind) {
    case 'text':
      return cell.value;
    case 'selector':
      return unique([cell.label, cell.selector, cell.snippet, cell.explanation]).join(' — ');
    case 'list':
      return cell.items
        .map(textOfCell)
        .filter((part) => part !== '')
        .join('; ');
  }
}

/** A failing element: what it is, how to find it, what it looks like, why it failed. */
function selectorCell(value: Record<string, unknown>): ToolReportCell {
  const selector = asText(value['selector']);
  const snippet = asText(value['snippet']);
  const label = asText(value['nodeLabel']);
  const explanation = asText(value['explanation']);
  if (selector === undefined) {
    // A node without a selector still reads as text (label/snippet/explanation).
    const text = unique([label, snippet, explanation]).join(' — ');
    return { kind: 'text', value: cellText(text) };
  }
  return {
    kind: 'selector',
    selector,
    ...(snippet === undefined ? {} : { snippet: cellText(snippet) }),
    ...(label === undefined ? {} : { label }),
    ...(explanation === undefined ? {} : { explanation: cellText(explanation) }),
  };
}

/** One value of a Lighthouse details item, as a typed cell the renderer draws. */
function formatCell(value: unknown, valueType?: string, displayUnit?: string): ToolReportCell {
  if (value === undefined || value === null) return { kind: 'text', value: '' };
  if (typeof value === 'string') {
    // A `thumbnail` column carries a base64 data URL: an image, not evidence
    // anyone can read in a cell.
    return value.startsWith('data:image/')
      ? { kind: 'text', value: '' }
      : { kind: 'text', value: cellText(value) };
  }
  if (typeof value === 'number') {
    return { kind: 'text', value: formatNumber(value, valueType, displayUnit) };
  }
  if (typeof value === 'boolean') return { kind: 'text', value: value ? 'yes' : 'no' };
  const array = asArray(value);
  if (array !== undefined) {
    return {
      kind: 'text',
      value: cellText(
        array
          .map((entry) => textOfCell(formatCell(entry, valueType, displayUnit)))
          .filter((part) => part !== '')
          .join('; '),
      ),
    };
  }
  if (!isRecord(value)) {
    try {
      return { kind: 'text', value: cellText(JSON.stringify(value) ?? '') };
    } catch {
      return { kind: 'text', value: '' };
    }
  }

  // The value's own `type` wins over the heading's `valueType`, exactly as in
  // Lighthouse's own report renderer.
  switch (asText(value['type'])) {
    case 'node':
      return selectorCell(value);
    case 'source-location':
      return { kind: 'text', value: cellText(sourceLocationText(value)) };
    case 'link':
      return { kind: 'text', value: cellText(linkText(value)) };
    case 'url':
    case 'code':
    case 'text':
      return { kind: 'text', value: cellText(asText(value['value']) ?? '') };
    case 'numeric':
      return typeof value['value'] === 'number'
        ? { kind: 'text', value: formatNumber(value['value'], valueType, displayUnit) }
        : { kind: 'text', value: '' };
    case 'baseline-status':
      return {
        kind: 'text',
        value: cellText(asText(value['displayString']) ?? asText(value['status']) ?? ''),
      };
    case 'subitems': {
      const items = asArray(value['items']) ?? [];
      const cells = items
        .map((entry) => formatCell(entry, valueType, displayUnit))
        .filter((cell) => !isEmptyCell(cell));
      return { kind: 'list', items: cells };
    }
    default: {
      // An ICU message object, or a shape Lighthouse added and we do not know:
      // show what it carries rather than dropping the evidence.
      const direct = asText(value);
      if (direct !== undefined) return { kind: 'text', value: cellText(direct) };
      try {
        return { kind: 'text', value: cellText(JSON.stringify(value)) };
      } catch {
        return { kind: 'text', value: '' };
      }
    }
  }
}

function columnLabel(heading: LighthouseHeading, fallbackKey: string): string {
  const label = asText(heading.label) ?? fallbackKey;
  return label.length <= MAX_LABEL_LENGTH ? label : `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

/** The nested rows a table row carries (`subItems`), one paragraph per item. */
function subItemsCell(
  record: Record<string, unknown>,
  headings: readonly LighthouseHeading[],
): ToolReportCell | undefined {
  const raw = record['subItems'];
  const items = isRecord(raw) ? asArray(raw['items']) : asArray(raw);
  if (items === undefined || items.length === 0) return undefined;
  const cells = items.flatMap((item): ToolReportCell[] => {
    const sub = isRecord(item) ? item : undefined;
    let text: string;
    if (sub === undefined) {
      text = textOfCell(formatCell(item));
    } else {
      const values = headings.flatMap((heading) => {
        const subHeading = heading.subItemsHeading;
        if (subHeading?.key === undefined) return [];
        return textOfCell(formatCell(sub[subHeading.key], subHeading.valueType));
      });
      text = values.length === 0 ? textOfCell(formatCell(item)) : unique(values).join(' — ');
    }
    return text === '' ? [] : [{ kind: 'text', value: cellText(text) }];
  });
  const kept = cells.filter((cell) => !isEmptyCell(cell));
  return kept.length === 0 ? undefined : { kind: 'list', items: kept };
}

/**
 * Every heading of a details table. A heading with a `null` key builds no
 * column, but still declares how its sub-items read (`legacy-javascript` keeps
 * the deprecated signal in one), so it is kept for that.
 */
function readHeadings(headings: unknown): readonly LighthouseHeading[] {
  return (asArray(headings) ?? []).filter(isRecord);
}

function keyedHeadings(headings: readonly LighthouseHeading[]): readonly KeyedHeading[] {
  return headings.filter(
    (heading): heading is KeyedHeading => typeof heading.key === 'string' && heading.key !== '',
  );
}

/** A `table`/`opportunity` details object: one table block, one column per heading. */
function tableBlock(headings: unknown, items: unknown): ToolReportTableBlock | undefined {
  const all = readHeadings(headings);
  const keyed = keyedHeadings(all);
  const records = (asArray(items) ?? []).filter(isRecord);
  if (keyed.length === 0 || records.length === 0) return undefined;

  const columns: ToolReportColumn[] = [];
  const byKey = new Map<string, KeyedHeading>();
  for (const heading of keyed) {
    if (byKey.has(heading.key) || columns.length >= MAX_COLUMNS) continue;
    byKey.set(heading.key, heading);
    columns.push({ key: heading.key, label: columnLabel(heading, heading.key) });
  }

  const subItems = records.map((record) => subItemsCell(record, all));
  const hasSubItems = subItems.some((cell) => cell !== undefined);
  const rows: ToolReportCell[][] = records.map((record, index) => {
    const row: ToolReportCell[] = [];
    for (const column of columns) {
      const heading = byKey.get(column.key);
      row.push(formatCell(record[column.key], heading?.valueType, heading?.displayUnit));
    }
    if (hasSubItems) row.push(subItems[index] ?? { kind: 'text', value: '' });
    return row;
  });

  return {
    kind: 'table',
    columns: hasSubItems
      ? [...columns, { key: SUB_ITEMS_COLUMN_KEY, label: SUB_ITEMS_COLUMN_LABEL }]
      : columns,
    rows,
  };
}

interface ListSection {
  readonly title: string | undefined;
  readonly value: unknown;
}

function listSections(items: unknown): readonly ListSection[] {
  return (asArray(items) ?? []).flatMap((item) => {
    if (!isRecord(item)) return [{ title: undefined, value: item }];
    if (item['type'] !== 'list-section') return [{ title: undefined, value: item }];
    return [
      {
        title: asText(item['title']) ?? asText(item['description']),
        value: item['value'],
      },
    ];
  });
}

/** A `checklist` details object: each labelled check with its result. */
function checklistBlock(items: unknown): ToolReportBlock | undefined {
  if (!isRecord(items)) return undefined;
  const entries: { readonly label: string; readonly value: string }[] = [];
  for (const [key, entry] of Object.entries(items)) {
    const item = isRecord(entry) ? entry : undefined;
    const label = asText(item?.['label']) ?? key;
    const value = item?.['value'];
    entries.push({
      label,
      value: typeof value === 'boolean' ? (value ? 'yes' : 'no') : textOfCell(formatCell(value)),
    });
  }
  if (entries.length === 0) return undefined;
  return { kind: 'checklist', items: entries };
}

/** A `network-tree` details object: its nested request chains, flattened into an indented table. */
function networkTreeBlock(value: Record<string, unknown>): ToolReportTreeBlock | undefined {
  const chains = isRecord(value['chains']) ? value['chains'] : undefined;
  if (chains === undefined) return undefined;
  const roots = buildTreeNodes(chains);
  if (roots.length === 0) return undefined;
  return { kind: 'tree', roots };
}

function buildTreeNodes(chains: Record<string, unknown>): ToolReportTreeNode[] {
  const nodes: ToolReportTreeNode[] = [];
  for (const entry of Object.values(chains)) {
    if (!isRecord(entry)) continue;
    const url = asText(entry['url']);
    if (url === undefined) continue;
    const duration = entry['navStartToEndTime'];
    const bytes = entry['transferSize'];
    nodes.push({
      url,
      ...(typeof duration === 'number' ? { durationMs: duration } : {}),
      ...(typeof bytes === 'number' ? { transferBytes: bytes } : {}),
      ...(entry['isLongest'] === true ? { isLongest: true } : {}),
      children: isRecord(entry['children']) ? buildTreeNodes(entry['children']) : [],
    });
  }
  return nodes;
}

/** A `node` value rendered as a standalone block (a list's element section). */
function nodeBlock(value: Record<string, unknown>): ToolReportNodeBlock {
  const cell = selectorCell(value);
  if (cell.kind !== 'selector') {
    return { kind: 'node', explanation: textOfCell(cell) };
  }
  return {
    kind: 'node',
    ...(cell.label === undefined ? {} : { label: cell.label }),
    selector: cell.selector,
    ...(cell.snippet === undefined ? {} : { snippet: cell.snippet }),
    ...(cell.explanation === undefined ? {} : { explanation: cell.explanation }),
  };
}

/** Applies a list-section title to a titled block (a table or tree), or prepends it to a text block. */
function titledBlock(block: ToolReportBlock, title: string | undefined): ToolReportBlock {
  if (title === undefined) return block;
  if (block.kind === 'table') return { ...block, title };
  if (block.kind === 'tree') return { ...block, title };
  if (block.kind === 'checklist' || block.kind === 'node') return block;
  return { ...block, value: `${title} — ${block.value}` };
}

/** A `list` details object: one block per section (a table, a checklist, a tree, a node). */
function listBlocks(items: unknown): ToolReportBlock[] | undefined {
  const sections = listSections(items);
  if (sections.length === 0) return undefined;
  const blocks: ToolReportBlock[] = [];
  for (const section of sections) {
    const value = isRecord(section.value) ? section.value : undefined;
    if (value === undefined) {
      const cell = formatCell(section.value);
      const text =
        section.title === undefined
          ? textOfCell(cell)
          : unique([section.title, textOfCell(cell)]).join(' — ');
      if (text !== '') blocks.push({ kind: 'text', value: cellText(text) });
      continue;
    }
    const type = asText(value['type']);
    if (
      type === 'table' ||
      type === 'opportunity' ||
      (type === undefined && value['headings'] !== undefined)
    ) {
      const table = tableBlock(value['headings'], value['items']);
      if (table !== undefined) blocks.push(titledBlock(table, section.title));
      continue;
    }
    if (type === 'checklist') {
      const checklist = checklistBlock(value['items']);
      if (checklist !== undefined) blocks.push(titledBlock(checklist, section.title));
      continue;
    }
    if (type === 'network-tree') {
      const tree = networkTreeBlock(value);
      if (tree !== undefined) blocks.push(titledBlock(tree, section.title));
      continue;
    }
    // A node (the LCP element), or a shape Lighthouse added: a node block, or text.
    if (type === 'node') {
      const node = nodeBlock(value);
      blocks.push(
        section.title === undefined
          ? node
          : { ...node, label: unique([section.title, node.label]).join(' — ') },
      );
      continue;
    }
    const cell = formatCell(value);
    const text =
      section.title === undefined
        ? textOfCell(cell)
        : unique([section.title, textOfCell(cell)]).join(' — ');
    if (text !== '') blocks.push({ kind: 'text', value: cellText(text) });
  }
  return blocks.length === 0 ? undefined : blocks;
}

/**
 * The explanation Lighthouse gives for an audit that reports no items, with a
 * markdown link turned into text plus its address (the address is linkified when
 * the report paints the block) so it stays readable.
 *
 * The entry's heading already names the audit and shows its display value, so
 * this is only Lighthouse's own explanation - repeating the title and the value
 * here used to flatten three separate facts into one run.
 */
export function describeProblem(audit: LighthouseAudit): string {
  const description = asText(audit.description)?.replace(/\[([^\]]+)]\(([^)\s]+)\)/g, '$1 ($2)');
  return description ?? asText(audit.title) ?? 'This audit did not pass';
}

/**
 * Whether Lighthouse itself computed a saving for this audit. A weight-0
 * `informative` insight (the performance category's only actionable audits in
 * Lighthouse 13) is worth showing exactly when it named one: a millisecond
 * saving on a metric (`metricSavings`) or a byte saving (`wastedBytes` in the
 * details' debug data). A breakdown-only insight explains a metric rather than
 * reporting something to fix, so it stays out.
 */
export function hasMeasuredSaving(audit: LighthouseAudit): boolean {
  const savings = audit.metricSavings;
  if (
    isRecord(savings) &&
    Object.values(savings).some(
      (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
    )
  ) {
    return true;
  }
  const debugData = audit.details?.debugData;
  return (
    isRecord(debugData) &&
    typeof debugData['wastedBytes'] === 'number' &&
    debugData['wastedBytes'] > 0
  );
}

/** The evidence blocks for one failed audit. Never empty. */
export function auditEvidence(audit: LighthouseAudit): ToolReportBlock[] {
  const details = audit.details;
  if (details !== undefined) {
    const blocks =
      (details.type === 'table' ||
      details.type === 'opportunity' ||
      (details.type === undefined && details.headings !== undefined)
        ? (() => {
            const table = tableBlock(details.headings, details.items);
            return table === undefined ? undefined : [table];
          })()
        : undefined) ??
      (details.type === 'list' ? listBlocks(details.items) : undefined) ??
      (details.type === 'checklist'
        ? (() => {
            const checklist = checklistBlock(details.items);
            return checklist === undefined ? undefined : [checklist];
          })()
        : undefined);
    if (blocks !== undefined) return blocks;
  }
  return [{ kind: 'text', value: cellText(describeProblem(audit)) }];
}
