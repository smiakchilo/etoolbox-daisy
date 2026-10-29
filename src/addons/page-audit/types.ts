import type { ToolReportBlock } from '../../shared';

/**
 * The vocabulary of one audit: what the tool asks for, and what the runner
 * answers.
 *
 * Everything here belongs to this add-on. The application knows the tool only
 * from its pins entry (its name, its descriptor, its billet), and reads its
 * result as data - so deleting this folder takes the whole capability with it.
 */

/** The categories an audit can score. */
export const PAGE_AUDIT_CATEGORIES = [
  'performance',
  'accessibility',
  'best-practices',
  'seo',
] as const;

export type PageAuditCategory = (typeof PAGE_AUDIT_CATEGORIES)[number];

export const PAGE_AUDIT_FORM_FACTORS = ['mobile', 'desktop'] as const;

export type PageAuditFormFactor = (typeof PAGE_AUDIT_FORM_FACTORS)[number];

export interface PageAuditRequest {
  /**
   * What to audit: an absolute http(s) URL, a path starting with `/` (read on the
   * host the pane is showing), or absent for the page the pane is showing. The
   * host resolves it; the tool never builds an origin.
   */
  readonly url: string | undefined;
  readonly categories: readonly PageAuditCategory[];
  readonly formFactor: PageAuditFormFactor;
}

export interface PageAuditScore {
  readonly category: PageAuditCategory;
  /** 0 to 1, or `null` when the run could not score the category. */
  readonly score: number | null;
}

/** One column of an issue's evidence table, named by the run's own heading. */
export interface PageAuditEvidenceColumn {
  readonly key: string;
  readonly label: string;
}

/**
 * What exactly failed, as the run itself reported it: a sequence of report
 * blocks - usually one table (the failing elements with their selector and
 * snippet, the insecure URLs, the deprecated APIs and where they are called,
 * the console messages, ...), but an insight can carry several (a table plus
 * the element it names, a checklist, a nested request tree).
 *
 * Never empty: an audit the run reports no items for carries its own
 * explanation of the problem as a single text block instead (see `evidence.ts`).
 */
export type PageAuditEvidence = readonly ToolReportBlock[];

/**
 * One audit that reported something to fix: an audit whose score is below 1, or
 * an unscored insight the run measured a saving for. Its `score` is `null` when
 * it has none.
 */
export interface PageAuditFailure {
  readonly category: PageAuditCategory;
  readonly id: string;
  readonly title: string;
  /** 0 to 1, or `null` for an insight the run does not score. */
  readonly score: number | null;
  readonly displayValue?: string;
  readonly evidence: PageAuditEvidence;
}

export interface PageAuditReport {
  readonly kind: 'report';
  /** The URL that was audited, after the host resolved it. */
  readonly url: string;
  readonly formFactor: PageAuditFormFactor;
  readonly scores: readonly PageAuditScore[];
  /** The audits that reported something to fix, most important first. */
  readonly failures: readonly PageAuditFailure[];
  /** The run's own message when the page could not be audited properly. */
  readonly runtimeError?: string;
}

export type PageAuditFailureKind =
  'blocked' | 'cancelled' | 'failed' | 'invalid_url' | 'no_page' | 'timeout';

export interface PageAuditFailed {
  readonly kind: PageAuditFailureKind;
  readonly message?: string;
}

export type PageAuditOutcome = PageAuditFailed | PageAuditReport;

/**
 * Runs one audit. Never rejects: every failure is an outcome. `progress`, when
 * given, is told which stage the audit has reached, as a short phrase.
 */
export type PageAuditRunner = (
  request: PageAuditRequest,
  signal: AbortSignal | undefined,
  progress?: (stage: string) => void,
) => Promise<PageAuditOutcome>;
