import type { HardenedToolPolicy } from './toolPolicy';

/**
 * The agent-side surface for building an AEM session's tool policy.
 *
 * The agent knows no tool: the tools live one folder each under
 * src/tools/, are discovered by src/main/tools/registry.ts, and hand this
 * module their allowlist entries and instruction text through the composition
 * root. Keeping this file tool-agnostic is what lets a tool folder be deleted
 * without touching the agent.
 */

export interface AemToolPolicyInput {
  /** Source-qualified allowlist entries of the enabled tools (e.g. custom:aem_query). */
  readonly allowlistEntries: readonly string[];
  /** The composed session instructions (shared framing plus each tool's fragment). */
  readonly instructions: string;
}

/**
 * Builds the HardenedToolPolicy for a real AEM session: allows exactly the
 * tools it is given and supplies the base instruction through instructions.
 */
export function buildAemToolPolicy(input: AemToolPolicyInput): HardenedToolPolicy {
  return {
    availableTools: [...input.allowlistEntries],
    instructions: input.instructions,
  };
}
