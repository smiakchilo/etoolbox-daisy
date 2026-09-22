/**
 * Renders the first zod issue into a single model-facing error line.
 *
 * The issue's `path` is prefixed onto its message (`predicates.limit: expected
 * string, received number`), because zod's own message names only the *kind* of
 * failure and never the field it occurred on. Without the path, a model that
 * mis-nests a key - the common case being `limit` placed inside `predicates`
 * instead of beside it - receives an error it cannot act on and spends extra
 * turns guessing. The rendered line is capped so a pathological message cannot
 * bloat the transcript.
 */
export function firstIssueMessage(
  issues: readonly {
    readonly message: string;
    readonly path?: readonly PropertyKey[];
  }[],
  fallback: string,
): string {
  const issue = issues[0];
  if (issue === undefined || issue.message.length === 0) return fallback;
  const path = (issue.path ?? []).map((segment) => String(segment)).join('.');
  const rendered = path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  return rendered.slice(0, 500);
}
