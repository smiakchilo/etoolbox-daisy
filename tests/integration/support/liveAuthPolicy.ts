/**
 * Project policy for tests that perform a **real GitHub sign-in**.
 *
 * These tests drive `copilot.exe login --web-flow` against real GitHub OAuth
 * endpoints using a real account. Repeatedly re-running them while iterating
 * on step 02 produced enough sign-in attempts in quick succession to get an
 * account rate-limited ("tarpitted"), and carries a real risk of tripping
 * corporate suspicious-activity monitoring.
 *
 * They are therefore **BLOCKED** at the project owner's explicit instruction
 * (implementation-plan.md rule 8: record BLOCKED rather than weaken a
 * requirement). `DAISY_LIVE_AUTH=1` is deliberately **not** sufficient to run
 * them any more - the owner must additionally approve a real sign-in for that
 * specific run.
 *
 * What is *not* affected, because none of it touches a real account:
 *
 *  - `proxy-login.test.ts` and `proxy-runtime.test.ts` use
 *    `runSyntheticWebFlowLogin()` against a local MITM proxy with canned
 *    responses and a deliberately invalid authorization code. Fully offline.
 *  - Tests that merely need *a valid credential* can take an explicitly
 *    supplied token via `CreateHardenedClientOptions.githubToken`, which
 *    costs no OAuth traffic. (Ambient `GH_TOKEN`/`GITHUB_TOKEN` remain
 *    stripped by `copilotClient.ts` by design, so a stray token still cannot
 *    silently stand in for a login being tested.)
 *
 * The evidence these blocked tests were written to produce was already
 * gathered and recorded in `docs/verification.md` during step 02; the block
 * removes the ability to *re-run* them casually, not the evidence itself.
 *
 * To approve a single run, set the variable below to exactly `i-approve`. The
 * value is deliberately awkward so it cannot be enabled by reflex, by a
 * copied CI snippet, or by an agent following a habit.
 */
export const REAL_GITHUB_LOGIN_APPROVAL_ENV = 'DAISY_APPROVED_REAL_GITHUB_LOGIN';

/** True only when the project owner has approved real sign-ins for this run. */
export const realGithubLoginApproved = process.env[REAL_GITHUB_LOGIN_APPROVAL_ENV] === 'i-approve';

/**
 * Suffix appended to a blocked suite's name so a skipped run says *why* it
 * was skipped, rather than looking like an unset feature flag.
 */
export function realLoginSuite(title: string): string {
  return realGithubLoginApproved
    ? title
    : `${title} [BLOCKED: real GitHub sign-in disabled by project policy - see liveAuthPolicy.ts]`;
}
