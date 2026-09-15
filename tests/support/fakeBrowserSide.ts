import { originSchema } from '../../src/shared/contracts/origin';
import type { Clock, ToolRequestEnvelope } from '../../src/shared/contracts/toolContracts';
import type { ToolErrorCode } from '../../src/shared/contracts/errors';
import { toolRequestEnvelopeSchema } from '../../src/shared/contracts/toolContracts';
import type {
  ChildrenMetadata,
  HasMore,
  PaginationMetadata,
  TotalMatches,
  ToolSuccess,
} from '../../src/shared/contracts/toolResult';
import type { JsonValue } from '../../src/shared/contracts/agentEvents';
import { FixtureRepository } from './fakeAemFixtures';

/**
 * The fake browser/preload side (implementation-plan.md line 208-210: "The
 * browser validates the target again"). It receives whatever main sent as an
 * opaque `unknown` value - exactly what crosses a real IPC boundary - and
 * re-parses it with `toolRequestEnvelopeSchema`, the same validator main used
 * to build the envelope in the first place, rather than trusting that main
 * already checked it. It then serves data from a small fixture repository
 * and never touches the network.
 */
export type BrowserOutcome =
  | { readonly ok: true; readonly success: ToolSuccess }
  | { readonly ok: false; readonly code: ToolErrorCode; readonly message: string };

/**
 * `toolResult.ts` exports a hand-written `PropertySelection` type with a
 * `readonly string[]` `properties` field, but `ToolSuccess["selection"]`
 * (the type actually required by `AemGetJsonSuccess`/`AemQuerySuccess`, via
 * `z.infer` of `propertySelectionSchema`) has a mutable `string[]` instead.
 * The two are not assignable to each other for that field, so building a
 * result here uses the schema-derived type directly instead - see the
 * mismatch reported alongside this file.
 */
type SelectionMetadata = ToolSuccess['selection'];

function selectProperties(
  properties: Readonly<Record<string, JsonValue>>,
  selected: readonly string[] | undefined,
): { readonly data: Readonly<Record<string, JsonValue>>; readonly selection: SelectionMetadata } {
  if (selected === undefined) {
    return { data: properties, selection: { kind: 'all' } };
  }
  const data: Record<string, JsonValue> = {};
  for (const name of selected) {
    // No fixture property is ever the literal value `undefined` (`JsonValue`
    // excludes it), so this is equivalent to an own-property check without
    // needing a cast to recover the type `noUncheckedIndexedAccess` erases.
    const value = properties[name];
    if (value !== undefined) {
      data[name] = value;
    }
  }
  return { data, selection: { kind: 'selected', properties: [...selected] } };
}

export class FakeBrowserSide {
  /** The origin the fake browser is currently navigated to; settable to simulate navigation. */
  public currentOrigin: string;

  constructor(
    private readonly repository: FixtureRepository,
    private readonly clock: Clock,
    initialOrigin: string,
  ) {
    this.currentOrigin = originSchema.parse(initialOrigin);
  }

  handle(envelopeCandidate: unknown): BrowserOutcome {
    const parsed = toolRequestEnvelopeSchema.safeParse(envelopeCandidate);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'INVALID_ARGUMENT',
        message: parsed.error.issues[0]?.message ?? 'the tool request envelope is invalid',
      };
    }
    const envelope = parsed.data;
    return envelope.operation === 'aem_get_json'
      ? this.handleGetJson(envelope)
      : this.handleQuery(envelope);
  }

  private handleGetJson(
    envelope: Extract<ToolRequestEnvelope, { operation: 'aem_get_json' }>,
  ): BrowserOutcome {
    const node = this.repository.findNode(envelope.args.path);
    if (node === undefined) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: `No node exists at '${envelope.args.path}' on the currently active AEM instance.`,
      };
    }

    const { data, selection } = selectProperties(node.properties, envelope.args.properties);
    const children: ChildrenMetadata = envelope.args.includeChildren
      ? { requested: true, returned: node.children.length, hasMore: false }
      : { requested: false };

    const success: ToolSuccess = {
      ok: true,
      operation: 'aem_get_json',
      requestId: envelope.requestId,
      sourceOrigin: this.currentOrigin,
      serverRevision: envelope.serverRevision,
      path: envelope.args.path,
      fetchedAt: this.clock(),
      data,
      selection,
      children,
    };
    return { ok: true, success };
  }

  private handleQuery(
    envelope: Extract<ToolRequestEnvelope, { operation: 'aem_query' }>,
  ): BrowserOutcome {
    const { rows: matched, forceUnknownHasMore } = this.repository.runQuery(
      envelope.args.predicates,
    );
    const { offset, limit } = envelope.args;
    const page = matched.slice(offset, offset + limit);
    const hasMore: HasMore = forceUnknownHasMore ? 'unknown' : offset + limit < matched.length;

    const rows: JsonValue[] = [];
    let selection: SelectionMetadata = { kind: 'all' };
    for (const row of page) {
      const selected = selectProperties(row.properties, envelope.args.properties);
      selection = selected.selection;
      rows.push({ path: row.path, ...selected.data });
    }

    // Mirrors the real `classifyTotal` rule (queryResponse.ts): a count is
    // only `"exact"` when the server said there is nothing further AND this
    // page accounts for the whole total. The fixture knows the true figure,
    // but reporting it as exact regardless would make this fake easier to
    // satisfy than the production path it stands in for.
    const total: TotalMatches =
      hasMore === false && offset + page.length === matched.length
        ? { accuracy: 'exact', value: matched.length }
        : { accuracy: 'estimated', value: matched.length };

    const pagination: PaginationMetadata = {
      offset,
      limit,
      returned: page.length,
      hasMore,
      total,
    };

    const success: ToolSuccess = {
      ok: true,
      operation: 'aem_query',
      requestId: envelope.requestId,
      sourceOrigin: this.currentOrigin,
      serverRevision: envelope.serverRevision,
      predicates: envelope.args.predicates,
      fetchedAt: this.clock(),
      rows,
      selection,
      pagination,
    };
    return { ok: true, success };
  }
}
