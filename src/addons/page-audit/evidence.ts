import type { PageAuditEvidence, PageAuditEvidenceColumn } from '../../shared';

/**
 * Turns one failed Lighthouse audit into the **evidence table** the report
 * paints under it: the columns Lighthouse itself declares and one row per item
 * (a failing element with its selector and snippet, an insecure URL, a
 * deprecated API and where it is called, a console message, ...).
 *
 * The shapes are Lighthouse's own (`types/lhr/audit-details.d.ts`): a `table`
 * or `opportunity` carries headings and items, a `list` carries sections or
 * bare items, a `checklist` a label/value map. Debug data, screenshots,
 * filmstrips and treemaps are not evidence a reader can act on (a screenshot is
 * a base64 image), so an audit carrying only those falls back to Lighthouse's
 * own explanation of the problem - the same row every audit with no items gets.
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
 * `format_table` (which paints this) caps a table at 20 columns and a column
 * label at 60 characters, so the evidence is shaped to fit rather than being
 * refused.
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

const FALLBACK_COLUMN_KEY = 'detail';
const FALLBACK_COLUMN_LABEL = 'What to fix';
const SUB_ITEMS_COLUMN_KEY = 'evidence-sub-items';
const SUB_ITEMS_COLUMN_LABEL = 'Sub items';

type Row = Record<string, string>;

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

/** A failing element: what it is, how to find it, what it looks like, why it failed. */
function nodeText(node: Record<string, unknown>): string {
  return unique([
    asText(node['nodeLabel']),
    asText(node['selector']),
    asText(node['snippet']),
    asText(node['explanation']),
  ]).join(' — ');
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

/** One value of a Lighthouse details item, as the cell text a reader can act on. */
export function formatValue(value: unknown, valueType?: string, displayUnit?: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    // A `thumbnail` column carries a base64 data URL: an image, not evidence
    // anyone can read in a cell.
    return value.startsWith('data:image/') ? '' : value;
  }
  if (typeof value === 'number') return formatNumber(value, valueType, displayUnit);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const array = asArray(value);
  if (array !== undefined) {
    return array
      .map((entry) => formatValue(entry, valueType, displayUnit))
      .filter((part) => part !== '')
      .join('; ');
  }
  if (!isRecord(value)) {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }

  // The value's own `type` wins over the heading's `valueType`, exactly as in
  // Lighthouse's own report renderer.
  switch (asText(value['type'])) {
    case 'node':
      return nodeText(value);
    case 'source-location':
      return sourceLocationText(value);
    case 'link':
      return linkText(value);
    case 'url':
    case 'code':
    case 'text':
      return asText(value['value']) ?? '';
    case 'numeric':
      return typeof value['value'] === 'number'
        ? formatNumber(value['value'], valueType, displayUnit)
        : '';
    case 'baseline-status':
      return asText(value['displayString']) ?? asText(value['status']) ?? '';
    case 'subitems': {
      const items = asArray(value['items']) ?? [];
      return items
        .map((entry) => formatValue(entry, valueType))
        .filter((part) => part !== '')
        .join('; ');
    }
    default: {
      // An ICU message object, or a shape Lighthouse added and we do not know:
      // show what it carries rather than dropping the evidence.
      const direct = asText(value);
      if (direct !== undefined) return direct;
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
  }
}

function columnLabel(heading: LighthouseHeading, fallbackKey: string): string {
  const label = asText(heading.label) ?? fallbackKey;
  return label.length <= MAX_LABEL_LENGTH ? label : `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

function cellText(text: string): string {
  return text.length <= MAX_CELL_LENGTH ? text : `${text.slice(0, MAX_CELL_LENGTH - 1)}…`;
}

/** The nested rows a table row carries (`subItems`), in one trailing cell. */
function subItemsCell(
  record: Record<string, unknown>,
  headings: readonly LighthouseHeading[],
): string {
  const raw = record['subItems'];
  const items = isRecord(raw) ? asArray(raw['items']) : asArray(raw);
  if (items === undefined || items.length === 0) return '';
  const parts = items.flatMap((item) => {
    const sub = isRecord(item) ? item : undefined;
    if (sub === undefined) return [formatValue(item)];
    const values = headings.flatMap((heading) => {
      const subHeading = heading.subItemsHeading;
      if (subHeading?.key === undefined) return [];
      const value = formatValue(sub[subHeading.key], subHeading.valueType);
      return value === '' ? [] : [value];
    });
    return [values.length === 0 ? formatValue(item) : unique(values).join(' — ')];
  });
  return unique(parts).join('; ');
}

type KeyedHeading = LighthouseHeading & { readonly key: string };

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

/** A `table`/`opportunity` details object: one row per item, one column per heading. */
function tableEvidence(headings: unknown, items: unknown): PageAuditEvidence | undefined {
  const all = readHeadings(headings);
  const keyed = keyedHeadings(all);
  const records = (asArray(items) ?? []).filter(isRecord);
  if (keyed.length === 0 || records.length === 0) return undefined;

  const columns: PageAuditEvidenceColumn[] = [];
  const byKey = new Map<string, KeyedHeading>();
  for (const heading of keyed) {
    if (byKey.has(heading.key) || columns.length >= MAX_COLUMNS) continue;
    byKey.set(heading.key, heading);
    columns.push({ key: heading.key, label: columnLabel(heading, heading.key) });
  }

  const subItems = records.map((record) => cellText(subItemsCell(record, all)));
  const hasSubItems = subItems.some((cell) => cell !== '');
  const rows: Row[] = records.map((record, index) => {
    const row: Row = {};
    for (const column of columns) {
      const heading = byKey.get(column.key);
      row[column.key] = cellText(
        formatValue(record[column.key], heading?.valueType, heading?.displayUnit),
      );
    }
    if (hasSubItems) row[SUB_ITEMS_COLUMN_KEY] = subItems[index] ?? '';
    return row;
  });

  return {
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

/** A `list` details object: its sections, each with its own title and table. */
function listEvidence(items: unknown): PageAuditEvidence | undefined {
  const sections = listSections(items);
  if (sections.length === 0) return undefined;

  const tables = sections.flatMap((section) => {
    const value = isRecord(section.value) ? section.value : undefined;
    if (value === undefined || value['type'] !== 'table') return [];
    const evidence = tableEvidence(value['headings'], value['items']);
    return evidence === undefined ? [] : [{ title: section.title, evidence }];
  });

  if (tables.length === sections.length) {
    const columns: PageAuditEvidenceColumn[] = [];
    const seen = new Set<string>();
    for (const table of tables) {
      for (const column of table.evidence.columns) {
        if (seen.has(column.key) || columns.length >= MAX_COLUMNS) continue;
        seen.add(column.key);
        columns.push(column);
      }
    }
    const titled = tables.some((table) => table.title !== undefined);
    const rows: Row[] = [];
    for (const table of tables) {
      for (const row of table.evidence.rows) {
        const shaped: Row = {};
        for (const column of columns) shaped[column.key] = row[column.key] ?? '';
        if (titled) shaped[SUB_ITEMS_COLUMN_KEY] = table.title ?? '';
        rows.push(shaped);
      }
    }
    return {
      columns: titled ? [...columns, { key: SUB_ITEMS_COLUMN_KEY, label: 'Section' }] : columns,
      rows,
    };
  }

  const rows: Row[] = sections.map((section) => ({
    [FALLBACK_COLUMN_KEY]: cellText(
      unique([section.title, formatValue(section.value)]).join(' — '),
    ),
  }));
  if (rows.every((row) => row[FALLBACK_COLUMN_KEY] === '')) return undefined;
  return {
    columns: [{ key: FALLBACK_COLUMN_KEY, label: FALLBACK_COLUMN_LABEL }],
    rows,
  };
}

/** A `checklist` details object: each labelled check with its result. */
function checklistEvidence(items: unknown): PageAuditEvidence | undefined {
  if (!isRecord(items)) return undefined;
  const rows: Row[] = Object.entries(items).map(([key, entry]) => {
    const item = isRecord(entry) ? entry : undefined;
    const label = asText(item?.['label']) ?? key;
    const value = item?.['value'];
    return {
      [FALLBACK_COLUMN_KEY]: cellText(
        `${label}: ${typeof value === 'boolean' ? (value ? 'yes' : 'no') : formatValue(value)}`,
      ),
    };
  });
  if (rows.length === 0) return undefined;
  return {
    columns: [{ key: FALLBACK_COLUMN_KEY, label: FALLBACK_COLUMN_LABEL }],
    rows,
  };
}

/**
 * The explanation Lighthouse gives for an audit that reports no items, with a
 * markdown link turned into text plus its address so the cell stays readable.
 */
export function describeProblem(audit: LighthouseAudit): string {
  const description = asText(audit.description)?.replace(/\[([^\]]+)]\(([^)\s]+)\)/g, '$1 ($2)');
  return (
    unique([description, audit.displayValue, audit.title]).join(' ') || 'This audit did not pass'
  );
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

/** The evidence for one failed audit. Never empty. */
export function auditEvidence(audit: LighthouseAudit): PageAuditEvidence {
  const details = audit.details;
  if (details !== undefined) {
    const evidence =
      (details.type === 'table' ||
      details.type === 'opportunity' ||
      (details.type === undefined && details.headings !== undefined)
        ? tableEvidence(details.headings, details.items)
        : undefined) ??
      (details.type === 'list' ? listEvidence(details.items) : undefined) ??
      (details.type === 'checklist' ? checklistEvidence(details.items) : undefined);
    if (evidence !== undefined) return evidence;
  }
  return {
    columns: [{ key: FALLBACK_COLUMN_KEY, label: FALLBACK_COLUMN_LABEL }],
    rows: [{ [FALLBACK_COLUMN_KEY]: cellText(describeProblem(audit)) }],
  };
}
