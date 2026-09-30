// Intentional rule-violation fixture. Do NOT fix this file - it exists only
// to prove the agent-folder boundary rule (eslint.config.mjs) actually fires:
// an agent folder may not import another agent (`../other-agent/...`) nor the
// application (`../../main/...`). It is excluded from `eslint .` and must be
// linted directly with
// `npx eslint --no-ignore tests/fixtures/eslint-violations/agent-boundary-violation.ts`
// (expect exactly two errors).
import { agent } from '../other-agent/agent';
import { createLogger } from '../../main/logger';

export const forbidden = [agent, createLogger];
