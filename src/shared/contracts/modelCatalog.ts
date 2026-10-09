import { z } from 'zod';
import { modelIdSchema, reasoningEffortSchema } from './appSettings';

/**
 * The renderer-safe projection of the SDK's model list
 * (implementation-plan.md step 09: "Obtain model lists/capabilities from the
 * SDK. Show only supported reasoning levels.").
 *
 * Deliberately a *projection*, not a pass-through of the SDK's `ModelInfo`:
 * that type also carries billing/pricing, token limits and policy state, none
 * of which the Settings picker needs, and all of which would become part of
 * this application's IPC contract the moment the renderer could see them.
 * Only the three things a picker actually renders survive the trip.
 */

const MODEL_DISPLAY_NAME_MAX_LENGTH = 200;

/**
 * One selectable model.
 *
 * `supportedReasoningEfforts` is the whole capability story, flattened: the
 * SDK reports reasoning support as *two* fields that can disagree
 * (`capabilities.supports.reasoningEffort: boolean` and an optional
 * `supportedReasoningEfforts` array). A model that claims support but lists no
 * levels, or lists levels while claiming no support, would leave the UI
 * deciding which field to believe. Here there is only one field, and an empty
 * array is the single, unambiguous representation of "this model has no
 * selectable reasoning levels" - so "show only supported reasoning levels"
 * becomes "render this array", with no capability logic left in the renderer.
 */
export const modelCatalogEntrySchema = z
  .object({
    id: modelIdSchema,
    /** Human-readable label for the picker. Falls back to `id` when the SDK gives none. */
    name: z.string().min(1).max(MODEL_DISPLAY_NAME_MAX_LENGTH),
    /** Empty when this model has no selectable reasoning levels. */
    supportedReasoningEfforts: z.array(reasoningEffortSchema),
    /** Only present when the model both supports reasoning effort and names a default. */
    defaultReasoningEffort: reasoningEffortSchema.optional(),
  })
  .strict();

export type ModelCatalogEntry = Readonly<z.infer<typeof modelCatalogEntrySchema>>;

/**
 * Everything the Settings window needs to render the model section in one
 * round trip: what may be chosen and what is currently chosen.
 *
 * There is deliberately no "changes are locked while a turn is in flight" flag
 * any more. A model/effort change is read at the start of the next prompt (see
 * `sdkAgentService.ts`), so it already takes effect on the next turn without
 * disturbing the one running; the pickers stay enabled throughout. The
 * runtime-shaping settings on the Agents tab (proxy, token, active provider)
 * follow the same "applies on the next turn" rule, with their recycle deferred
 * while a turn is live - see `agentComposition.ts`'s deferred recycler.
 */
export const modelSelectionStateSchema = z
  .object({
    models: z.array(modelCatalogEntrySchema),
    /** The active agent's stored `model`, or `null` when none is chosen. */
    selectedModel: modelIdSchema.nullable(),
    /** The active agent's stored `reasoningEffort`, or `null`. */
    selectedReasoningEffort: reasoningEffortSchema.nullable(),
    /**
     * True when the catalogue could not be read from the SDK (Copilot still
     * starting, signed out, runtime unavailable). `models` is then empty, and
     * that emptiness means "unknown", not "no models exist" - a distinction
     * the UI must make, because the second would justify clearing the user's
     * stored choice and the first must never do so.
     */
    catalogUnavailable: z.boolean(),
  })
  .strict();

export type ModelSelectionState = Readonly<
  Omit<z.infer<typeof modelSelectionStateSchema>, 'models'>
> & {
  readonly models: readonly ModelCatalogEntry[];
};

export function parseModelSelectionState(candidate: unknown): ModelSelectionState {
  return modelSelectionStateSchema.parse(candidate);
}

/**
 * The reasoning levels that may be offered for `modelId`, per the catalogue.
 *
 * Returns an empty array for a model that is absent from the catalogue, which
 * is the same answer as "this model supports no reasoning levels" on purpose:
 * both mean "offer nothing", and an unknown model is precisely the case where
 * guessing a level list would be least defensible.
 */
export function supportedReasoningEffortsFor(
  models: readonly ModelCatalogEntry[],
  modelId: string | null,
): readonly string[] {
  if (modelId === null) return [];
  return models.find((model) => model.id === modelId)?.supportedReasoningEfforts ?? [];
}

/**
 * Whether `reasoningEffort` may be stored alongside `modelId`.
 *
 * `null` - "no explicit reasoning effort; let the runtime resolve it from the
 * model's own configuration" - is always valid, including for a model that
 * supports no levels at all. Anything else must appear in that model's own
 * supported list, which is what stops a level that was valid for the
 * previously selected model from surviving a model change.
 */
export function isReasoningEffortValidFor(
  models: readonly ModelCatalogEntry[],
  modelId: string | null,
  reasoningEffort: string | null,
): boolean {
  if (reasoningEffort === null) return true;
  return supportedReasoningEffortsFor(models, modelId).includes(reasoningEffort);
}
