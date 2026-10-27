import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  type ToolReportBlock,
  type ToolReportEntry,
  type ToolReportMessage,
  type ToolReportSection,
  type ToolReportTableBlock,
  asCount,
  asRecord,
  asStringArray,
  asText,
  parameterRows,
} from '../../../shared';

function describeScores(value: JsonValue | undefined): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((entry: JsonValue) => {
    const record = asRecord(entry);
    const category = asText(record?.['category']);
    if (category === undefined) return [];
    const score = asCount(record?.['score']);
    return [`${category} ${score === undefined ? 'n/a' : String(score)}`];
  });
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** How many audits did not pass - the report's own list, never a separate count. */
function countFailures(value: JsonValue | undefined): string | undefined {
  return Array.isArray(value) ? String(value.length) : undefined;
}

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const url = asText(args['url']);
  const categories = asStringArray(args['categories'])?.join(', ');
  const result = asRecord(data);

  return {
    summary: url ?? asText(result?.['url']) ?? 'Current page',
    parameters: parameterRows([
      ['URL', url ?? asText(result?.['url']) ?? '(current page)'],
      ['Categories', categories === '' ? undefined : categories],
      ['Form factor', asText(args['formFactor']) ?? asText(result?.['formFactor'])],
      ['Scores', describeScores(result?.['scores'])],
      ['Issues', countFailures(result?.['failures'])],
    ]),
  };
}

/** How a category is named in the report's score summary. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best Practices',
  seo: 'SEO',
};

/** The report's rubric order, so a section appears even when its category is not the first scored. */
const CATEGORY_ORDER = ['performance', 'accessibility', 'best-practices', 'seo'] as const;

function statusFor(score: number | null): 'pass' | 'warn' | 'fail' {
  if (score === null) return 'warn';
  if (score >= 90) return 'pass';
  if (score >= 50) return 'warn';
  return 'fail';
}

function readScore(
  raw: JsonValue,
): { readonly category: string; readonly score: number | null } | undefined {
  const record = asRecord(raw);
  const category = asText(record?.['category']);
  if (category === undefined) return undefined;
  const score = typeof record?.['score'] === 'number' ? record['score'] : null;
  return { category, score };
}

interface Failure {
  readonly category: string;
  readonly id: string;
  readonly title: string;
  readonly score: number | null;
  readonly displayValue: string | undefined;
  readonly evidence: readonly ToolReportBlock[];
}

function readFailure(raw: JsonValue): Failure | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const category = asText(record['category']);
  const id = asText(record['id']);
  const title = asText(record['title']);
  if (category === undefined || id === undefined || title === undefined) return undefined;
  return {
    category,
    id,
    title,
    score: typeof record['score'] === 'number' ? record['score'] : null,
    displayValue: asText(record['displayValue']),
    // The evidence was zod-validated when the result was produced, so it is read
    // structurally: a malformed block would have been refused at the boundary.
    evidence: Array.isArray(record['evidence'])
      ? (record['evidence'] as readonly ToolReportBlock[])
      : [],
  };
}

/** The always-visible lead: the category score table. */
function summaryTable(
  scores: readonly { readonly category: string; readonly score: number | null }[],
): ToolReportTableBlock {
  return {
    kind: 'table',
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'score', label: 'Score' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    rows: scores.map((entry) => [
      { kind: 'text', value: CATEGORY_LABELS[entry.category] ?? entry.category },
      { kind: 'text', value: entry.score === null ? 'n/a' : String(entry.score) },
      { kind: 'text', value: statusFor(entry.score) },
    ]),
  };
}

function readReportMessage(
  _args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolReportMessage | undefined {
  const result = asRecord(data);
  if (result === undefined || result['ok'] !== true || result['operation'] !== 'page_audit') {
    return undefined;
  }

  const scores = Array.isArray(result['scores'])
    ? result['scores'].flatMap((raw: JsonValue) => {
        const entry = readScore(raw);
        return entry === undefined ? [] : [entry];
      })
    : [];
  const failures = Array.isArray(result['failures'])
    ? result['failures'].flatMap((raw: JsonValue) => {
        const entry = readFailure(raw);
        return entry === undefined ? [] : [entry];
      })
    : [];

  const sections: ToolReportSection[] = [];
  for (const category of CATEGORY_ORDER) {
    const entries: ToolReportEntry[] = failures
      .filter((failure) => failure.category === category)
      .map((failure) => ({
        id: `${failure.category}:${failure.id}`,
        title: failure.title,
        ...(failure.displayValue === undefined ? {} : { displayValue: failure.displayValue }),
        ...(failure.score === null ? {} : { score: failure.score }),
        blocks: failure.evidence,
      }));
    if (entries.length === 0) continue;
    sections.push({ title: CATEGORY_LABELS[category] ?? category, entries });
  }

  return {
    summary: scores.length === 0 ? undefined : summaryTable(scores),
    sections,
  };
}

export const renderer: ToolRendererModule = {
  toolName: 'page_audit',
  presentation: 'report',
  describeCall,
  readReportMessage,
};
