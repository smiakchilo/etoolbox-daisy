// Intentional rule-violation fixture. Do NOT fix this file - it exists only
// to prove the "SDK only inside an agent folder" `no-restricted-imports` rule
// (eslint.config.mjs) actually fires for code outside `src/agents/<name>/`. Excluded
// from `eslint .` via the top-level `tests/fixtures/**` ignore; lint it
// directly with
// `npx eslint --no-ignore tests/fixtures/eslint-violations/sdk-outside-agent-violation.ts`.
import { Client } from '@github/copilot-sdk';

export function forbidden(): unknown {
  return Client;
}
