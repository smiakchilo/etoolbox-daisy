/**
 * The vocabulary of the `page_audit` capability: what a tool asks the
 * application to audit, and what the application answers. The audit itself (a
 * hidden browser window running Lighthouse) lives in the **page-audit add-on**,
 * downloaded on first use; the tool sees only these types, so it stays free of
 * Electron and of Lighthouse.
 */

import type { ToolReportBlock } from './toolRenderer';

/** The Lighthouse categories an audit can score. */
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
   * application resolves it; the tool never builds an origin.
   */
  readonly url: string | undefined;
  readonly categories: readonly PageAuditCategory[];
  readonly formFactor: PageAuditFormFactor;
}

export interface PageAuditScore {
  readonly category: PageAuditCategory;
  /** 0 to 1, or `null` when Lighthouse could not score the category. */
  readonly score: number | null;
}

/** One column of an issue's evidence table, named by Lighthouse's own heading. */
export interface PageAuditEvidenceColumn {
  readonly key: string;
  readonly label: string;
}

/**
 * What exactly failed, as Lighthouse itself reported it: a sequence of report
 * blocks - usually one table (the failing elements with their selector and
 * snippet, the insecure URLs, the deprecated APIs and where they are called,
 * the console messages, ...), but an insight can carry several (a table plus
 * the element it names, a checklist, a nested request tree). The application
 * paints these under the issue's heading; they are also data for the user and
 * the model reading them afterwards.
 *
 * Never empty: an audit Lighthouse reports no items for carries its own
 * explanation of the problem as a single text block instead (see the add-on).
 */
export type PageAuditEvidence = readonly ToolReportBlock[];

/**
 * One audit that reported something to fix: an audit whose score is below 1, or
 * a weight-0 `informative` insight Lighthouse measured a saving for (the
 * performance category's actionable findings in Lighthouse 13). Its `score` is
 * `null` when Lighthouse gives it no score.
 */
export interface PageAuditFailure {
  readonly category: PageAuditCategory;
  readonly id: string;
  readonly title: string;
  /** 0 to 1, or `null` for an insight Lighthouse does not score. */
  readonly score: number | null;
  readonly displayValue?: string;
  readonly evidence: PageAuditEvidence;
}

export interface PageAuditReport {
  readonly kind: 'report';
  /** The URL that was audited, after the application resolved it. */
  readonly url: string;
  readonly formFactor: PageAuditFormFactor;
  readonly scores: readonly PageAuditScore[];
  /** The audits that reported something to fix, most important first. */
  readonly failures: readonly PageAuditFailure[];
  /** Lighthouse's own message when the page could not be audited properly. */
  readonly runtimeError?: string;
}

export type PageAuditFailureKind =
  | 'blocked'
  | 'cancelled'
  | 'failed'
  | 'invalid_url'
  | 'no_page'
  | 'timeout'
  /**
   * The page-audit add-on is not installed and could not be downloaded (or is
   * not the version/API version this build pins). Distinct from `failed`: no
   * audit was attempted, and retrying later may succeed.
   */
  | 'unavailable';

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
