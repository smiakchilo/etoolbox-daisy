// Intentional rule-violation fixture. Do NOT fix this file - it exists only
// to prove the `no-restricted-imports` tool-boundary rule (eslint.config.mjs)
// actually fires: a tool folder may not import another tool (`../aem-query/...`)
// nor the application (`../../main/...`). It is excluded from `eslint .` and
// must be linted directly with
// `npx eslint --no-ignore tests/fixtures/eslint-violations/tool-boundary-violation.ts`
// (expect exactly two errors).
import { tool } from '../aem-query/tool';
import { createLogger } from '../../main/logger';

export const forbidden = [tool, createLogger];
