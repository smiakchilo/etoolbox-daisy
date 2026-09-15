// Intentional rule-violation fixture. Do NOT fix this file - it exists only
// to prove the `no-restricted-imports` shared-purity rule (eslint.config.mjs)
// actually fires. It is excluded from `eslint .` (see the top-level
// `ignores` entry for `tests/fixtures/**`) and must be linted directly with
// `npx eslint --no-ignore tests/fixtures/eslint-violations/shared-purity-violation.ts`.
import { app } from 'electron';

export function forbidden(): string {
  return app.getName();
}
