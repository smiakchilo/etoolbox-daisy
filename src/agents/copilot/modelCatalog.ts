import { z } from 'zod';
import {
  type ModelCatalogEntry,
  type Result,
  err,
  modelCatalogEntrySchema,
  ok,
} from '../../shared';

/**
 * Reads the Copilot model catalogue through the SDK and projects it to this
 * application's own `ModelCatalogEntry` DTO (implementation-plan.md step 09:
 * "Obtain model lists/capabilities from the SDK").
 *
 * Lives under `src/agent/` because that is the only directory permitted to
 * depend on the Copilot SDK (ESLint-enforced). The dependency here is
 * structural rather than an import: {@link ModelCatalogSource} describes just
 * `listModels()`, so a real `CopilotClient` satisfies it without this module
 * naming an SDK type, and a unit test can supply a plain object.
 */

/**
 * The one method this module needs from `CopilotClient`. Returns `unknown`
 * rather than `ModelInfo[]`: the value is produced by a separate runtime
 * process over an RPC boundary, so it is untrusted input and is validated
 * below before use, exactly as IPC payloads are everywhere else in this
 * codebase.
 */
export interface ModelCatalogSource {
  listModels(): Promise<unknown>;
}

/**
 * The subset of the SDK's `ModelInfo` this application projects from.
 *
 * Non-strict, unlike the schemas in `src/shared/contracts`: every other schema
 * in this codebase rejects unknown keys because an unexpected key signals a
 * tampered or mis-versioned document. Here the opposite is true - `ModelInfo`
 * carries `billing`, `policy` and `limits` that this projection deliberately
 * discards, and the SDK is free to add more in any patch release. Rejecting
 * those would make a routine SDK upgrade empty the model picker.
 *
 * `capabilities` is optional and loosely typed for the same reason: this
 * module only ever reads `supports.reasoningEffort` out of it.
 */
const sdkModelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  capabilities: z
    .object({
      supports: z.object({ reasoningEffort: z.boolean().optional() }).loose().optional(),
    })
    .loose()
    .optional(),
  supportedReasoningEfforts: z.array(z.string().min(1)).optional(),
  defaultReasoningEffort: z.string().min(1).optional(),
});

export const MODEL_CATALOG_ERROR_KINDS = ['unavailable', 'malformed'] as const;
export type ModelCatalogErrorKind = (typeof MODEL_CATALOG_ERROR_KINDS)[number];

export interface ModelCatalogError {
  readonly kind: ModelCatalogErrorKind;
  /** Application-authored text, safe to log. Never raw SDK error content. */
  readonly message: string;
}

/**
 * Flattens the SDK's two-field reasoning-capability reporting into the single
 * array `ModelCatalogEntry` declares.
 *
 * The two fields can disagree, and the resolution is deliberately the
 * conservative one in both directions:
 *
 *  - `supports.reasoningEffort === false` wins over a non-empty
 *    `supportedReasoningEfforts`. Offering a level the model does not accept
 *    produces a request the runtime rejects at send time, which would surface
 *    to the user as a failed turn rather than as a greyed-out option.
 *  - `supports.reasoningEffort === true` with no `supportedReasoningEfforts`
 *    yields an empty list, not a guessed one. The SDK's own `ReasoningEffort`
 *    union (`"low" | "medium" | "high" | "xhigh" | "max"`) is the *type-level*
 *    set of all levels any model might accept, not the set this model does;
 *    substituting it here would re-introduce exactly the hard-coded list that
 *    `modelIdSchema`/`reasoningEffortSchema` were kept open-ended to avoid.
 */
function resolveSupportedEfforts(model: z.infer<typeof sdkModelInfoSchema>): string[] {
  if (model.capabilities?.supports?.reasoningEffort === false) return [];
  return [...(model.supportedReasoningEfforts ?? [])];
}

/**
 * Projects one validated SDK model, or `undefined` if the projection cannot
 * satisfy this application's own contract (e.g. an id longer than
 * `modelIdSchema` permits). Dropping one unusable entry is preferable to
 * failing the whole catalogue: the remaining models are still perfectly
 * selectable.
 */
function toCatalogEntry(model: z.infer<typeof sdkModelInfoSchema>): ModelCatalogEntry | undefined {
  const supportedReasoningEfforts = resolveSupportedEfforts(model);
  // A default the model does not itself list is dropped rather than trusted:
  // it would otherwise be preselected in the picker and then rejected by
  // `isReasoningEffortValidFor` on save, with nothing explaining why.
  const defaultReasoningEffort =
    model.defaultReasoningEffort !== undefined &&
    supportedReasoningEfforts.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : undefined;

  const parsed = modelCatalogEntrySchema.safeParse({
    id: model.id,
    name: model.name ?? model.id,
    supportedReasoningEfforts,
    ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Validates and projects a raw `listModels()` response.
 *
 * Exported separately from {@link loadModelCatalog} so the projection - the
 * part with all the capability-resolution decisions in it - is unit-testable
 * against fixture data with no client, real or fake, involved.
 */
export function projectModelCatalog(raw: unknown): Result<ModelCatalogEntry[], ModelCatalogError> {
  const parsed = z.array(z.unknown()).safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: 'malformed',
      message: 'Copilot returned a model list of an unexpected shape.',
    });
  }

  const entries: ModelCatalogEntry[] = [];
  const seenIds = new Set<string>();
  for (const candidate of parsed.data) {
    const model = sdkModelInfoSchema.safeParse(candidate);
    if (!model.success) continue;
    // Duplicate ids would render as duplicate picker options that are
    // indistinguishable to the user but resolve to one stored value.
    if (seenIds.has(model.data.id)) continue;
    const entry = toCatalogEntry(model.data);
    if (entry === undefined) continue;
    seenIds.add(entry.id);
    entries.push(entry);
  }
  return ok(entries);
}

/**
 * Reads and projects the catalogue, converting a thrown SDK/transport failure
 * into a `Result`.
 *
 * A rejection here is ordinary and expected, not exceptional: `listModels()`
 * throws when the client is not connected, and this application starts its
 * Copilot runtime in the background *after* the Settings IPC handlers are
 * registered, so opening Settings early legitimately hits that case. It is
 * reported as `unavailable` so the UI can say "not loaded yet" while leaving
 * the user's stored selection untouched.
 */
export async function loadModelCatalog(
  source: ModelCatalogSource,
): Promise<Result<ModelCatalogEntry[], ModelCatalogError>> {
  let raw: unknown;
  try {
    raw = await source.listModels();
  } catch {
    return err({
      kind: 'unavailable',
      message: 'Could not read the list of Copilot models. Copilot may still be starting.',
    });
  }
  return projectModelCatalog(raw);
}
