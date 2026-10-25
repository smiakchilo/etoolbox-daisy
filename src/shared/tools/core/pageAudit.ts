/**
 * The vocabulary of the `page_audit` capability: what a tool asks the
 * application to audit, and what the application answers. The audit itself (a
 * hidden browser window running Lighthouse) lives in the **page-audit add-on**,
 * downloaded on first use; the tool sees only these types, so it stays free of
 * Electron and of Lighthouse.
 */

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

/** The most failing audits one report lists, so the result stays a table-sized answer. */
export const PAGE_AUDIT_MAX_FAILURES = 40;

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

export interface PageAuditFailure {
  readonly category: PageAuditCategory;
  readonly id: string;
  readonly title: string;
  /** 0 to 1, or `null` for an audit that has no numeric score. */
  readonly score: number | null;
  readonly displayValue?: string;
}

export interface PageAuditReport {
  readonly kind: 'report';
  /** The URL that was audited, after the application resolved it. */
  readonly url: string;
  readonly formFactor: PageAuditFormFactor;
  readonly scores: readonly PageAuditScore[];
  /** Audits that did not pass, most important first, capped at `PAGE_AUDIT_MAX_FAILURES`. */
  readonly failures: readonly PageAuditFailure[];
  /** How many audits did not pass before the cap. */
  readonly failureCount: number;
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
