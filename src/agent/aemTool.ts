import type { HardenedToolPolicy } from './toolPolicy';
import { AEM_ASSISTANT_INSTRUCTIONS, TOOL_ALLOWLIST_ENTRIES } from '../shared';

/**
 * The agent-side surface for AEM tools.
 *
 * The tools themselves - argument schemas, descriptors, result shapes, URL
 * building, response reading, projection, error wording, and executors - now
 * live in one self-contained module each under `src/shared/tools/`. This file
 * only re-exports the executor entry points the composition root imports
 * (`src/main/index.ts`), and builds the SDK session policy from the registry's
 * own allowlist, so the policy can never list a tool the registry does not.
 */

export type {
  AemGetJsonExecutorConfig,
  AemGetJsonRequestEnvelope,
  AemQueryExecutorConfig,
  AemQueryRequestEnvelope,
  CurrentAemToolContext,
} from '../shared/tools';

export {
  createAemGetJsonExecutor,
  createAemQueryExecutor,
  AEM_GET_JSON_ALLOWLIST_ENTRY,
  AEM_GET_JSON_TOOL_NAME,
  AEM_QUERY_ALLOWLIST_ENTRY,
  AEM_QUERY_TOOL_NAME,
  AEM_ASSISTANT_INSTRUCTIONS,
} from '../shared/tools';

/**
 * Builds the `HardenedToolPolicy` for a real AEM session: allows exactly the
 * tools the registry declares, supplies the bundled base instruction through
 * `instructions`, and points `skillDirectories` at the application's own
 * bundled skills when one is supplied.
 *
 * `bundledSkillDirectories` is a parameter rather than something this module
 * resolves itself: the location depends on whether the app is packaged
 * (`process.resourcesPath`) or running from source, which is composition
 * knowledge that belongs in `src/main`. Omitting it leaves `enableSkills` at
 * its hardened `false` default, so skills are never enabled by accident.
 */
export function buildAemToolPolicy(
  bundledSkillDirectories?: readonly string[],
): HardenedToolPolicy {
  const base = {
    availableTools: [...TOOL_ALLOWLIST_ENTRIES],
    instructions: AEM_ASSISTANT_INSTRUCTIONS,
  };
  return bundledSkillDirectories !== undefined && bundledSkillDirectories.length > 0
    ? { ...base, bundledSkillDirectories }
    : base;
}
