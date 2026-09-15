// Intentional rule-violation fixture. Do NOT fix this file - it exists only
// to prove the `no-restricted-globals` shared-globals rule (eslint.config.mjs)
// actually fires. It is excluded from `eslint .` (see the top-level
// `ignores` entry for `tests/fixtures/**`) and must be linted directly with
// `npx eslint --no-ignore tests/fixtures/eslint-violations/shared-globals-violation.ts`.
export function forbiddenBrowserGlobal(): string {
  return document.title;
}

export function forbiddenNodeGlobal(): string {
  return process.platform;
}
