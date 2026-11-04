import type { BrowserWindow, Session } from 'electron';
import { z } from 'zod';
import {
  type AddonHost,
  type AddonToolFactory,
  createToolError,
  createToolExecutor,
  envelopeCommonShape,
  type JsonValue,
  newRequestId,
  requestIdSchema,
  type ToolExecutor,
  type ToolOutcome,
  type ToolReportBlock,
  type ToolReportCell,
  type ToolReportEntry,
  type ToolReportEvidence,
  type ToolReportMessage,
  type ToolReportSection,
  type ToolReportTableBlock,
  type ToolReportTreeNode,
  type ToolStatusVariant,
} from '../../shared';
import { createPageAudit } from './pageAudit';
import {
  PAGE_AUDIT_CATEGORIES,
  PAGE_AUDIT_FORM_FACTORS,
  type PageAuditCategory,
  type PageAuditFailed,
  type PageAuditFailureKind,
  type PageAuditFormFactor,
  type PageAuditRunner,
} from './types';

/**
 * The audit tool: one page's full report, **with its evidence**.
 *
 * The result is data - the category scores and every audit that did not pass,
 * each carrying the evidence the run reported (failing elements, URLs,
 * messages) - plus the structured report the transcript paints (`data.report`,
 * see `toolRenderer.ts`). The model is given the same evidence as text, because
 * a tool's `textResultForLlm` is all it sees.
 *
 * The report is built here, not in the renderer: the add-on owns what its report
 * looks like, and the application only knows the generic report shape.
 */

/**
 * The order the two form factors are measured in when the model names neither:
 * desktop first, then mobile, sequentially. A named `formFactor` runs only that
 * one.
 */
export const PAGE_AUDIT_RUN_ORDER: readonly PageAuditFormFactor[] = ['desktop', 'mobile'];

export const pageAuditArgsSchema = z
  .object({
    url: z.string().trim().min(1).max(2000).optional(),
    categories: z
      .array(z.enum(PAGE_AUDIT_CATEGORIES))
      .min(1)
      .max(PAGE_AUDIT_CATEGORIES.length)
      .optional(),
    formFactor: z.enum(PAGE_AUDIT_FORM_FACTORS).optional(),
  })
  .strict();

export type PageAuditArgs = z.infer<typeof pageAuditArgsSchema>;

const categorySchema = z.enum(PAGE_AUDIT_CATEGORIES);

export const pageAuditRequestSchema = z
  .object({
    operation: z.literal('page_audit'),
    ...envelopeCommonShape,
    args: pageAuditArgsSchema,
  })
  .strict();

export type PageAuditRequestEnvelope = z.infer<typeof pageAuditRequestSchema>;

/**
 * The evidence blocks a failure carries. They are produced by this add-on
 * (trusted main-process code), never by the model, so they are validated
 * loosely here (one opaque value per block) rather than re-declaring the whole
 * report shape a second time in this file.
 */
const evidenceSchema = z.array(z.unknown()).readonly();

const auditScoreSchema = z
  .object({ category: categorySchema, score: z.number().min(0).max(100).nullable() })
  .strict();

const auditFailureSchema = z
  .object({
    category: categorySchema,
    id: z.string(),
    title: z.string(),
    score: z.number().min(0).max(100).nullable(),
    displayValue: z.string().optional(),
    evidence: evidenceSchema,
  })
  .strict();

/** One form factor's measurement: its scores, findings, and its own problems. */
const auditRunSchema = z
  .object({
    formFactor: z.enum(PAGE_AUDIT_FORM_FACTORS),
    scores: z.array(auditScoreSchema),
    failures: z.array(auditFailureSchema),
    /**
     * The run could not complete (timeout, sign-in, network). Only present when
     * the other requested run succeeded; an all-failed call is a tool error.
     */
    error: z.string().optional(),
    /** Lighthouse's own message for a run that completed with a problem. */
    runtimeError: z.string().optional(),
  })
  .strict();

export const pageAuditSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('page_audit'),
    requestId: requestIdSchema,
    url: z.string(),
    runs: z.array(auditRunSchema).min(1).max(2),
    /** `desktop`, `mobile` or `desktop, mobile` - the billet's Form factor row. */
    formFactorLabel: z.string(),
    auditedAt: z.number().int().nonnegative(),
  })
  .strict();

export type PageAuditSuccess = z.infer<typeof pageAuditSuccessSchema>;
export type PageAuditRun = PageAuditSuccess['runs'][number];
export type PageAuditFailureResult = PageAuditRun['failures'][number];

// ---------------------------------------------------------------------------
// The model's copy of the report
// ---------------------------------------------------------------------------

/** A report cell's display text, as the model reads it (the same joining the report paints). */
function reportCellText(cell: ToolReportCell): string {
  switch (cell.kind) {
    case 'text':
      return cell.value;
    case 'status':
      return cell.value;
    case 'selector':
      return uniqueParts([cell.label, cell.selector, cell.snippet, cell.explanation]).join(' — ');
    case 'list':
      return cell.items
        .map(reportCellText)
        .filter((part) => part !== '')
        .join('; ');
  }
}

function uniqueParts(parts: readonly (string | undefined)[]): string[] {
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

function flattenReportTree(
  nodes: readonly ToolReportTreeNode[],
  depth: number,
  out: { readonly node: ToolReportTreeNode; readonly depth: number }[],
): void {
  for (const node of nodes) {
    out.push({ node, depth });
    flattenReportTree(node.children, depth + 1, out);
  }
}

/**
 * One evidence block as the text the model reads. The report itself is painted
 * from the structured block data (the renderer owns the markup); this is the
 * same evidence in a plain form the model can reason about and refer to when the
 * user asks about a finding.
 */
function renderEvidenceBlockForModel(block: ToolReportBlock): string {
  switch (block.kind) {
    case 'table':
      return block.rows
        .map((row) =>
          block.columns
            .map((column, index) => {
              const text = reportCellText(row[index] ?? { kind: 'text', value: '' });
              return text === '' ? '' : `${column.label}: ${text}`;
            })
            .filter((part) => part !== '')
            .join(' | '),
        )
        .filter((line) => line !== '')
        .join('\n');
    case 'checklist':
      return block.items.map((item) => `${item.label}: ${item.value}`).join('\n');
    case 'node':
      return uniqueParts([block.label, block.selector, block.snippet, block.explanation]).join(
        ' — ',
      );
    case 'tree': {
      const rows: { readonly node: ToolReportTreeNode; readonly depth: number }[] = [];
      flattenReportTree(block.roots, 0, rows);
      return rows
        .map(({ node, depth }) => {
          const meta = [
            node.durationMs === undefined ? '' : `${String(Math.round(node.durationMs))} ms`,
            node.transferBytes === undefined ? '' : `${String(node.transferBytes)} B`,
          ]
            .filter((part) => part !== '')
            .join(', ');
          return `${'  '.repeat(depth)}${node.url}${meta === '' ? '' : ` (${meta})`}`;
        })
        .join('\n');
    }
    case 'text':
      return block.value;
  }
}

function renderEvidenceForModel(evidence: readonly ToolReportBlock[]): string {
  return evidence
    .map(renderEvidenceBlockForModel)
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * The model-facing report text. It carries the scores and, for every failed
 * audit, its evidence in plain form - the selectors, snippets, URLs, messages -
 * so the model can discuss, clarify or fix what the report found. (The chat
 * paints the report from the same structured blocks; this is the copy the model
 * is handed.)
 */
export function renderPageAuditSuccess(result: PageAuditSuccess): string {
  if (result.runs.length === 1) {
    const run = result.runs[0];
    if (run === undefined) return `Audited ${result.url}`;
    const head = `Audited ${result.url} (${run.formFactor}): ${describeRunScores(run)}. ${String(
      run.failures.length,
    )} audit issue(s)`;
    const runtime =
      run.runtimeError === undefined ? '' : `\nLighthouse reported: ${run.runtimeError}`;
    return `${head}${runtime}${describeFailuresForModel(run.failures)}`;
  }
  const issues = result.runs.reduce((count, run) => count + run.failures.length, 0);
  const head = `Audited ${result.url} (${result.formFactorLabel}). ${String(
    issues,
  )} audit issue(s)`;
  const parts = result.runs.map((run) => {
    if (run.error !== undefined) return `\n${run.formFactor} run failed: ${run.error}`;
    const runtime =
      run.runtimeError === undefined ? '' : `; Lighthouse reported: ${run.runtimeError}`;
    return `\n${run.formFactor}: ${describeRunScores(run)}${runtime}${describeFailuresForModel(
      run.failures,
      4,
    )}`;
  });
  return `${head}${parts.join('')}`;
}

function describeRunScores(run: PageAuditRun): string {
  return run.scores
    .map((entry) => `${entry.category} ${entry.score === null ? 'n/a' : String(entry.score)}`)
    .join(', ');
}

function describeFailuresForModel(failures: readonly PageAuditFailureResult[], indent = 0): string {
  if (failures.length === 0) return '';
  const pad = ' '.repeat(indent);
  const bodyPad = ' '.repeat(indent + 4);
  const lines = failures.map((failure) => {
    const title =
      `${pad}- [${failure.category}] ${failure.title} (${failure.id})` +
      `${failure.score === null ? '' : ` score ${String(failure.score)}`}` +
      `${failure.displayValue === undefined ? '' : `: ${failure.displayValue}`}`;
    const evidence = renderEvidenceForModel(
      failure.evidence as unknown as readonly ToolReportBlock[],
    );
    if (evidence === '') return title;
    const indented = evidence
      .split('\n')
      .map((line) => (line === '' ? '' : `${bodyPad}${line}`))
      .join('\n');
    return `${title}\n${indented}`;
  });
  return `\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// The painted report (the transcript's `presentation: 'report'` message)
// ---------------------------------------------------------------------------

/** How a category is named in the report's score summary. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best Practices',
  seo: 'SEO',
};

/** The report's own order, so a section appears even when its category is not scored first. */
const CATEGORY_ORDER = PAGE_AUDIT_CATEGORIES;

function statusFor(score: number | null): 'pass' | 'warn' | 'fail' {
  if (score === null) return 'warn';
  if (score >= 90) return 'pass';
  if (score >= 50) return 'warn';
  return 'fail';
}

/** The status-light colour a score earns (the same thresholds as {@link statusFor}). */
function scoreVariant(score: number | null): ToolStatusVariant {
  if (score === null) return 'neutral';
  if (score >= 90) return 'positive';
  if (score >= 50) return 'notice';
  return 'negative';
}

/** The first value when every entry agrees, else `undefined` (a merged finding shows no single figure). */
function commonValue<T>(values: readonly (T | undefined)[]): T | undefined {
  if (values.length === 0) return undefined;
  const first = values[0];
  return values.every((value) => value === first) ? first : undefined;
}

/** The lead table: one score column per run, or the single run's Score + Status. */
function summaryTable(runs: readonly PageAuditRun[]): ToolReportTableBlock | undefined {
  if (runs.length === 1) {
    const run = runs[0];
    if (run === undefined || run.scores.length === 0) return undefined;
    return {
      kind: 'table',
      columns: [
        { key: 'category', label: 'Category' },
        { key: 'score', label: 'Score' },
        { key: 'status', label: 'Status', kind: 'status' },
      ],
      rows: run.scores.map((entry) => [
        { kind: 'text', value: CATEGORY_LABELS[entry.category] ?? entry.category },
        { kind: 'text', value: entry.score === null ? 'n/a' : String(entry.score) },
        { kind: 'text', value: statusFor(entry.score) },
      ]),
    };
  }
  const categories =
    runs.find((run) => run.scores.length > 0)?.scores.map((entry) => entry.category) ?? [];
  if (categories.length === 0) return undefined;
  return {
    kind: 'table',
    columns: [
      { key: 'category', label: 'Category' },
      ...runs.map((run) => ({
        key: run.formFactor,
        label: run.formFactor === 'desktop' ? 'Desktop' : 'Mobile',
        kind: 'status' as const,
      })),
    ],
    rows: categories.map((category) => [
      { kind: 'text', value: CATEGORY_LABELS[category] ?? category },
      ...runs.map((run): ToolReportCell => {
        const entry = run.scores.find((score) => score.category === category);
        if (run.error !== undefined || entry === undefined || entry.score === null) {
          return { kind: 'text', value: '—' };
        }
        return { kind: 'status', value: String(entry.score), variant: scoreVariant(entry.score) };
      }),
    ]),
  };
}

/** One audit's entry while the report is assembled across runs. */
interface MergedFinding {
  readonly title: string;
  readonly failures: PageAuditFailureResult[];
  readonly runs: RunEvidence[];
}

/** One run's evidence for a finding, before it is merged with the other device's. */
interface RunEvidence {
  readonly formFactor: PageAuditFormFactor;
  readonly blocks: readonly ToolReportBlock[];
}

function blocksEqual(a: ToolReportBlock, b: ToolReportBlock): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rowsEqual(a: readonly ToolReportCell[], b: readonly ToolReportCell[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The row's identity across devices: its first cell - the URL, element or source
 * every Lighthouse evidence table leads with. A first cell that is itself empty
 * falls back to the whole row, so a table of bare statistics still merges.
 */
function rowKey(row: readonly ToolReportCell[]): string {
  const first = row[0];
  if (first === undefined) return JSON.stringify(row);
  switch (first.kind) {
    case 'selector':
      return `selector:${first.selector}`;
    case 'text':
      return first.value === '' ? JSON.stringify(row) : `text:${first.value}`;
    case 'status':
      return `status:${first.value}`;
    case 'list':
      return `list:${JSON.stringify(first.items)}`;
  }
}

function sameTableShape(a: ToolReportTableBlock, b: ToolReportTableBlock): boolean {
  return a.title === b.title && JSON.stringify(a.columns) === JSON.stringify(b.columns);
}

/**
 * Whether a row carries a sub-items list. Such a row is rich enough that
 * collapsing it into one both-devices row hides which device reported the
 * detail, so its device rows are kept separate even when they are identical.
 */
function hasSubItems(row: readonly ToolReportCell[]): boolean {
  return row.some((cell) => cell.kind === 'list');
}

/**
 * One table for both devices. An identical row is shown once, marked both; a
 * row the devices disagree on (same key, different values) is kept twice, one
 * per device, so neither value is lost; a row only one device reported is
 * marked that device. A row with a sub-items list keeps one row per device.
 */
function mergeTables(
  a: ToolReportTableBlock,
  b: ToolReportTableBlock,
  aFormFactor: PageAuditFormFactor,
  bFormFactor: PageAuditFormFactor,
): ToolReportTableBlock {
  const rows: (readonly ToolReportCell[])[] = [];
  const rowFormFactors: (readonly PageAuditFormFactor[])[] = [];
  const remaining = [...b.rows];
  for (const row of a.rows) {
    const key = rowKey(row);
    const exact = remaining.findIndex(
      (candidate) => rowKey(candidate) === key && rowsEqual(candidate, row),
    );
    if (exact !== -1) {
      const [same] = remaining.splice(exact, 1);
      if (same !== undefined && hasSubItems(row)) {
        rows.push(row, same);
        rowFormFactors.push([aFormFactor], [bFormFactor]);
      } else {
        rows.push(row);
        rowFormFactors.push([aFormFactor, bFormFactor]);
      }
      continue;
    }
    const sameKey = remaining.findIndex((candidate) => rowKey(candidate) === key);
    const other = sameKey === -1 ? undefined : remaining.splice(sameKey, 1)[0];
    if (other !== undefined) {
      rows.push(row, other);
      rowFormFactors.push([aFormFactor], [bFormFactor]);
      continue;
    }
    rows.push(row);
    rowFormFactors.push([aFormFactor]);
  }
  for (const row of remaining) {
    rows.push(row);
    rowFormFactors.push([bFormFactor]);
  }
  return { ...a, rows, rowFormFactors };
}

/** One evidence list, merged across the devices that reported the finding. */
function mergeEvidence(runs: readonly RunEvidence[]): ToolReportEvidence[] {
  const [first, second] = runs;
  if (first === undefined) return [];
  if (second === undefined) {
    return first.blocks.map((block) => ({ formFactors: [first.formFactor], block }));
  }
  const merged: ToolReportEvidence[] = [];
  const length = Math.max(first.blocks.length, second.blocks.length);
  for (let index = 0; index < length; index += 1) {
    const a = first.blocks[index];
    const b = second.blocks[index];
    if (a === undefined && b !== undefined) {
      merged.push({ formFactors: [second.formFactor], block: b });
      continue;
    }
    if (b === undefined && a !== undefined) {
      merged.push({ formFactors: [first.formFactor], block: a });
      continue;
    }
    if (a === undefined || b === undefined) continue;
    if (a.kind === 'table' && b.kind === 'table' && sameTableShape(a, b)) {
      merged.push({
        formFactors: [first.formFactor, second.formFactor],
        block: mergeTables(a, b, first.formFactor, second.formFactor),
      });
      continue;
    }
    if (a.kind === b.kind && blocksEqual(a, b)) {
      merged.push({ formFactors: [first.formFactor, second.formFactor], block: a });
      continue;
    }
    merged.push({ formFactors: [first.formFactor], block: a });
    merged.push({ formFactors: [second.formFactor], block: b });
  }
  return merged;
}

/**
 * A checklist is really a two-column `Item | Result` table (Lighthouse's
 * document-latency insight), so it is rendered and merged as one: the device
 * mark sits per item, and an observed value that differs between devices keeps
 * its own row instead of duplicating the whole list.
 */
function checklistAsTable(block: ToolReportBlock): ToolReportBlock {
  if (block.kind !== 'checklist') return block;
  return {
    kind: 'table',
    columns: [
      { key: 'item', label: 'Item' },
      { key: 'result', label: 'Result' },
    ],
    rows: block.items.map((item) => [
      { kind: 'text', value: item.label },
      { kind: 'text', value: item.value },
    ]),
  };
}

/** The structured report message the transcript paints under the settled billet. */
export function buildPageAuditReport(result: PageAuditSuccess): ToolReportMessage {
  const measured = result.runs.filter((run) => run.error === undefined);
  const sections: ToolReportSection[] = [];
  for (const category of CATEGORY_ORDER) {
    // Merge the same audit across runs by its id, then merge its evidence.
    const merged = new Map<string, MergedFinding>();
    for (const run of measured) {
      for (const failure of run.failures) {
        if (failure.category !== category) continue;
        const evidence: RunEvidence = {
          formFactor: run.formFactor,
          blocks: (failure.evidence as unknown as readonly ToolReportBlock[]).map(checklistAsTable),
        };
        const existing = merged.get(failure.id);
        if (existing === undefined) {
          merged.set(failure.id, { title: failure.title, failures: [failure], runs: [evidence] });
        } else {
          existing.failures.push(failure);
          existing.runs.push(evidence);
        }
      }
    }
    if (merged.size === 0) continue;
    const entries: ToolReportEntry[] = [...merged.entries()].map(([id, finding]) => {
      const displayValue = commonValue(finding.failures.map((failure) => failure.displayValue));
      const score = commonValue(
        finding.failures.map((failure) => (failure.score === null ? undefined : failure.score)),
      );
      return {
        id: `${category}:${id}`,
        title: finding.title,
        ...(displayValue === undefined ? {} : { displayValue }),
        ...(score === undefined ? {} : { score }),
        evidence: mergeEvidence(finding.runs),
      };
    });
    sections.push({ title: CATEGORY_LABELS[category] ?? category, entries });
  }
  const failedNotes = result.runs
    .filter((run) => run.error !== undefined)
    .map((run) => `The ${run.formFactor} run failed: ${run.error ?? ''}`);
  return {
    summary: summaryTable(result.runs),
    ...(failedNotes.length === 0 ? {} : { note: failedNotes.join(' ') }),
    url: result.url,
    sections,
  };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

const ERROR_MESSAGES = {
  auth_required: 'The host showed its sign-in page instead of the requested page',
  blocked: 'The page is on a local, private or internal address and cannot be audited',
  cancelled: 'The audit was cancelled',
  failed: 'The page could not be audited',
  invalid_url: 'The URL must be an absolute http(s) address or a path starting with "/"',
  no_page: 'The browser pane is not showing a page, and no URL was given',
  timeout: 'The audit did not finish before the deadline',
} as const satisfies Record<PageAuditFailureKind, string>;

interface ErrorMapping {
  readonly code:
    | 'ACCESS_DENIED'
    | 'AUTH_REQUIRED'
    | 'CANCELLED'
    | 'NETWORK_ERROR'
    | 'INVALID_ARGUMENT'
    | 'TIMEOUT';
  readonly retryable: boolean;
  readonly requiredAction: 'none' | 'select_server' | 'sign_in_to_host';
}

const ERROR_MAPPINGS: Readonly<Record<PageAuditFailureKind, ErrorMapping>> = {
  auth_required: { code: 'AUTH_REQUIRED', retryable: false, requiredAction: 'sign_in_to_host' },
  blocked: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  cancelled: { code: 'CANCELLED', retryable: true, requiredAction: 'none' },
  failed: { code: 'NETWORK_ERROR', retryable: true, requiredAction: 'none' },
  invalid_url: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  no_page: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
  timeout: { code: 'TIMEOUT', retryable: true, requiredAction: 'none' },
};

/** Lighthouse scores are 0 to 1; the model and the table read 0 to 100. */
function toPercent(score: number | null): number | null {
  return score === null ? null : Math.round(score * 100);
}

/**
 * The executor, built over one runner. Separated from the host so the add-on's
 * own tests can drive it with a scripted run instead of a real window.
 */
export function createPageAuditExecutorFactory(run: PageAuditRunner): AddonToolFactory {
  return (toolHost): ToolExecutor => {
    return (args, context) =>
      createToolExecutor({
        operation: 'page_audit',
        argsSchema: pageAuditArgsSchema,
        requestSchema: pageAuditRequestSchema,
        render: renderPageAuditSuccess,
        toPayload: (result): JsonValue =>
          ({
            ...result,
            report: buildPageAuditReport(result),
            textResultForLlm: renderPageAuditSuccess(result),
            resultType: 'success',
          }) as unknown as JsonValue,
        execute: async (
          envelope: PageAuditRequestEnvelope,
        ): Promise<ToolOutcome<PageAuditSuccess>> => {
          // Absent form factor = both, in a stable order; a named one runs alone.
          const requested =
            envelope.args.formFactor === undefined
              ? PAGE_AUDIT_RUN_ORDER
              : [envelope.args.formFactor];
          const categories = envelope.args.categories ?? PAGE_AUDIT_CATEGORIES;
          const runs: PageAuditRun[] = [];
          const failures: PageAuditFailed[] = [];
          let auditedUrl = '';
          for (const formFactor of requested) {
            toolHost.reportToolProgress?.(context.toolCallId, `Analyzing ${formFactor}`);
            const outcome = await run(
              { url: envelope.args.url, categories, formFactor },
              context.signal,
              (stage) => toolHost.reportToolProgress?.(context.toolCallId, stage),
            );
            if (outcome.kind === 'report') {
              auditedUrl = outcome.url;
              runs.push({
                formFactor: outcome.formFactor,
                scores: outcome.scores.map((entry) => ({
                  category: entry.category,
                  score: toPercent(entry.score),
                })),
                failures: outcome.failures.map((failure) => ({
                  category: failure.category,
                  id: failure.id,
                  title: failure.title,
                  score: toPercent(failure.score),
                  ...(failure.displayValue === undefined
                    ? {}
                    : { displayValue: failure.displayValue }),
                  evidence: failure.evidence,
                })),
                ...(outcome.runtimeError === undefined
                  ? {}
                  : { runtimeError: outcome.runtimeError }),
              });
            } else {
              // A failed run is a note on the report when the other succeeded;
              // when both fail the whole call is the error below.
              failures.push(outcome);
              runs.push({
                formFactor,
                scores: [],
                failures: [],
                error: ERROR_MESSAGES[outcome.kind],
              });
            }
          }
          if (runs.every((runResult) => runResult.error !== undefined)) {
            const failure = failures[0];
            if (failure === undefined) {
              return {
                ok: false,
                error: createToolError(
                  'NETWORK_ERROR',
                  'The page audit failed',
                  newRequestId(toolHost.idGenerator),
                  { retryable: true, requiredAction: 'none' },
                ),
              };
            }
            const mapping = ERROR_MAPPINGS[failure.kind];
            return {
              ok: false,
              error: createToolError(
                mapping.code,
                ERROR_MESSAGES[failure.kind],
                newRequestId(toolHost.idGenerator),
                { retryable: mapping.retryable, requiredAction: mapping.requiredAction },
              ),
            };
          }
          return {
            ok: true,
            operation: 'page_audit',
            requestId: envelope.requestId,
            url: auditedUrl,
            runs,
            formFactorLabel: runs.map((runResult) => runResult.formFactor).join(', '),
            auditedAt: toolHost.clock(),
          };
        },
        runtimeDeps: {},
        currentContext: toolHost.currentContext,
        clock: toolHost.clock,
        idGenerator: toolHost.idGenerator,
        failureFallbackMessage: 'The page audit failed',
      })(args, context);
  };
}

/**
 * The tool's factory, as `activate` returns it: one runner for the add-on's
 * lifetime (all calls queue behind it), and the model-facing executor the
 * proxy forwards to.
 */
export function createPageAuditToolFactory(
  host: AddonHost<BrowserWindow, Session>,
): AddonToolFactory {
  return createPageAuditExecutorFactory(createPageAudit(host));
}

/** The categories and form factors this build offers, for the add-on's own tests. */
export type { PageAuditCategory, PageAuditFormFactor };
