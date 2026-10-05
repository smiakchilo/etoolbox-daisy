import { z } from 'zod';

import {
  err,
  modelCatalogEntrySchema,
  ok,
  type ModelCatalogEntry,
  type Result,
} from '../../shared';

/**
 * Reads OpenRouter's model catalogue (`models.list()`) and projects it onto
 * this application's own {@link ModelCatalogEntry} DTO.
 *
 * Non-strict on purpose, exactly like Copilot's `modelCatalog.ts`: OpenRouter's
 * `Model` carries pricing, architecture, benchmarks and more that this
 * projection discards, and the platform is free to add fields in any release.
 * A `.strict()` schema here would empty the model picker on a routine upgrade.
 */

const sdkModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    reasoning: z
      .object({
        // Null means "no allowlist - all gateway effort values accepted"; this
        // projection surfaces only an explicit list, so null yields none.
        supportedEfforts: z.array(z.string().min(1)).nullish(),
        defaultEffort: z.string().min(1).nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export interface ModelCatalogError {
  /** Application-authored text, safe to log. Never raw SDK error content. */
  readonly message: string;
}

const UNEXPECTED_SHAPE = 'OpenRouter returned a model list of an unexpected shape.';

/**
 * A default the model does not itself list is dropped rather than trusted -
 * mirroring Copilot's projection, so a stored effort can never be one
 * `isReasoningEffortValidFor` would reject on save.
 */
function toCatalogEntry(model: z.infer<typeof sdkModelSchema>): ModelCatalogEntry | undefined {
  const supportedReasoningEfforts = [...(model.reasoning?.supportedEfforts ?? [])];
  const defaultEffort = model.reasoning?.defaultEffort;
  const defaultReasoningEffort =
    defaultEffort !== undefined &&
    defaultEffort !== null &&
    supportedReasoningEfforts.includes(defaultEffort)
      ? defaultEffort
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
 * Orders two projected entries by display name, case-insensitively, with the id
 * as a stable tie-breaker. OpenRouter's list is enormous and the API guarantees
 * no order, so an unsorted picker is effectively unusable; sorting here keeps
 * the shared `ModelCatalogEntry` free of ordinal metadata the renderer does not
 * otherwise need.
 */
function compareCatalogEntries(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  const byName = a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true });
  return byName !== 0 ? byName : a.id.localeCompare(b.id, 'en', { sensitivity: 'base' });
}

/**
 * Validates and projects a raw `models.list()` response. Exported separately so
 * the projection is unit-testable against fixtures with no client involved.
 */
export function projectOpenRouterModelCatalog(
  raw: unknown,
): Result<ModelCatalogEntry[], ModelCatalogError> {
  const parsed = z.array(z.unknown()).safeParse(raw);
  if (!parsed.success) return err({ message: UNEXPECTED_SHAPE });

  const entries: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed.data) {
    const model = sdkModelSchema.safeParse(candidate);
    if (!model.success) continue;
    if (seen.has(model.data.id)) continue;
    const entry = toCatalogEntry(model.data);
    if (entry === undefined) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  entries.sort(compareCatalogEntries);
  return ok(entries);
}

/** The one method this module needs from the client. */
export interface ModelCatalogSource {
  listModels(): Promise<unknown>;
}

/**
 * Reads and projects the catalogue, converting a thrown transport failure into
 * a `Result`. A rejection is ordinary (network, auth, timeout) and is reported
 * as an error the UI renders without touching the stored selection.
 */
export async function loadOpenRouterModelCatalog(
  source: ModelCatalogSource,
): Promise<Result<ModelCatalogEntry[], ModelCatalogError>> {
  let raw: unknown;
  try {
    raw = await source.listModels();
  } catch {
    return err({ message: 'Could not read the list of OpenRouter models.' });
  }
  return projectOpenRouterModelCatalog(raw);
}
