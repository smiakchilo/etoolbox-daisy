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
  type ToolReportMessage,
  type ToolReportSection,
  type ToolReportTableBlock,
  type ToolReportTreeNode,
} from '../../shared';
import { createPageAudit } from './pageAudit';
import {
  PAGE_AUDIT_CATEGORIES,
  PAGE_AUDIT_FORM_FACTORS,
  type PageAuditCategory,
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

export const PAGE_AUDIT_DEFAULT_FORM_FACTOR: PageAuditFormFactor = 'mobile';

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

export const pageAuditSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('page_audit'),
    requestId: requestIdSchema,
    url: z.string(),
    formFactor: z.enum(PAGE_AUDIT_FORM_FACTORS),
    scores: z.array(
      z.object({ category: categorySchema, score: z.number().min(0).max(100).nullable() }).strict(),
    ),
    failures: z.array(
      z
        .object({
          category: categorySchema,
          id: z.string(),
          title: z.string(),
          score: z.number().min(0).max(100).nullable(),
          displayValue: z.string().optional(),
          evidence: evidenceSchema,
        })
        .strict(),
    ),
    runtimeError: z.string().optional(),
    auditedAt: z.number().int().nonnegative(),
  })
  .strict();

export type PageAuditSuccess = z.infer<typeof pageAuditSuccessSchema>;

// ---------------------------------------------------------------------------
// The model's copy of the report
// ---------------------------------------------------------------------------

/** A report cell's display text, as the model reads it (the same joining the report paints). */
function reportCellText(cell: ToolReportCell): string {
  switch (cell.kind) {
    case 'text':
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
  const scores = result.scores
    .map((entry) => `${entry.category} ${entry.score === null ? 'n/a' : String(entry.score)}`)
    .join(', ');
  const head = `Audited ${result.url} (${result.formFactor}): ${scores}. ${String(result.failures.length)} audit issue(s)`;
  const runtime =
    result.runtimeError === undefined ? '' : `\nLighthouse reported: ${result.runtimeError}`;
  if (result.failures.length === 0) return `${head}${runtime}`;
  const lines = result.failures.map((failure) => {
    const title =
      `- [${failure.category}] ${failure.title} (${failure.id})` +
      `${failure.score === null ? '' : ` score ${String(failure.score)}`}` +
      `${failure.displayValue === undefined ? '' : `: ${failure.displayValue}`}`;
    const evidence = renderEvidenceForModel(
      failure.evidence as unknown as readonly ToolReportBlock[],
    );
    if (evidence === '') return title;
    const indented = evidence
      .split('\n')
      .map((line) => (line === '' ? '' : `    ${line}`))
      .join('\n');
    return `${title}\n${indented}`;
  });
  return `${head}${runtime}\n${lines.join('\n')}`;
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

function summaryTable(scores: PageAuditSuccess['scores']): ToolReportTableBlock {
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

/** The structured report message the transcript paints under the settled billet. */
export function buildPageAuditReport(result: PageAuditSuccess): ToolReportMessage {
  const sections: ToolReportSection[] = [];
  for (const category of CATEGORY_ORDER) {
    const entries: ToolReportEntry[] = result.failures
      .filter((failure) => failure.category === category)
      .map((failure) => ({
        id: `${failure.category}:${failure.id}`,
        title: failure.title,
        ...(failure.displayValue === undefined ? {} : { displayValue: failure.displayValue }),
        ...(failure.score === null ? {} : { score: failure.score }),
        blocks: failure.evidence as unknown as readonly ToolReportBlock[],
      }));
    if (entries.length === 0) continue;
    sections.push({ title: CATEGORY_LABELS[category] ?? category, entries });
  }
  return {
    summary: result.scores.length === 0 ? undefined : summaryTable(result.scores),
    sections,
  };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

const ERROR_MESSAGES = {
  blocked: 'The page is on a local, private or internal address and cannot be audited',
  cancelled: 'The audit was cancelled',
  failed: 'The page could not be audited',
  invalid_url: 'The URL must be an absolute http(s) address or a path starting with "/"',
  no_page: 'The browser pane is not showing a page, and no URL was given',
  timeout: 'The audit did not finish before the deadline',
} as const satisfies Record<PageAuditFailureKind, string>;

interface ErrorMapping {
  readonly code: 'ACCESS_DENIED' | 'CANCELLED' | 'NETWORK_ERROR' | 'INVALID_ARGUMENT' | 'TIMEOUT';
  readonly retryable: boolean;
  readonly requiredAction: 'none' | 'select_server';
}

const ERROR_MAPPINGS: Readonly<Record<PageAuditFailureKind, ErrorMapping>> = {
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
          toolHost.reportToolProgress?.(context.toolCallId, 'Auditing the page');
          const outcome = await run(
            {
              url: envelope.args.url,
              categories: envelope.args.categories ?? PAGE_AUDIT_CATEGORIES,
              formFactor: envelope.args.formFactor ?? PAGE_AUDIT_DEFAULT_FORM_FACTOR,
            },
            context.signal,
            (stage) => toolHost.reportToolProgress?.(context.toolCallId, stage),
          );
          if (outcome.kind !== 'report') {
            const mapping = ERROR_MAPPINGS[outcome.kind];
            return {
              ok: false,
              error: createToolError(
                mapping.code,
                ERROR_MESSAGES[outcome.kind],
                newRequestId(toolHost.idGenerator),
                { retryable: mapping.retryable, requiredAction: mapping.requiredAction },
              ),
            };
          }
          return {
            ok: true,
            operation: 'page_audit',
            requestId: envelope.requestId,
            url: outcome.url,
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
              ...(failure.displayValue === undefined ? {} : { displayValue: failure.displayValue }),
              evidence: failure.evidence,
            })),
            ...(outcome.runtimeError === undefined ? {} : { runtimeError: outcome.runtimeError }),
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
