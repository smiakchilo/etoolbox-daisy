import type { AemGetJsonArgs } from '../../shared/contracts/toolContracts';
import type {
  AemGetJsonSuccess,
  ChildrenMetadata,
  PropertySelection,
} from '../../shared/contracts/toolResult';
import type { JsonValue } from '../../shared/contracts/agentEvents';
import type { RequestId } from '../../shared/contracts/ids';
import type { JsonObject } from './responseValidation';

/**
 * Projects a depth-1 Sling JSON body (implementation-plan.md step 06) into
 * the shape `aem_get_json` hands to the model.
 *
 * Sling's depth-1 response mixes a node's own properties and its immediate
 * children into one flat object, and nothing in the payload names which key
 * is which - JSON shape is the only signal available: a key whose value is a
 * nested object is a child node, everything else (scalar, array, `null`) is
 * a property. That is the entire classification rule this module applies;
 * it never re-derives HTTP/JSON-shape facts `classifyAemResponse` already
 * settled, and it never builds URLs.
 *
 * This function is pure and total: given any {@link JsonObject}, including
 * an empty one, it always returns a result, never throws, and never imposes
 * a size limit - the plan explicitly rejects a byte cap here, so a large
 * payload is projected in full rather than truncated.
 */

/** One immediate child node, identified by name only. */
export interface ProjectedChildEntry {
  readonly name: string;
}

/**
 * The value placed in `AemGetJsonSuccess.data`. Deliberately excludes a
 * child's own properties or descendants (rule 7): a child entry exists only
 * to be counted and named, so an agent that wants a child's content issues a
 * further `aem_get_json` call for that child's path instead of receiving an
 * uncontrolled recursive tree in one response.
 */
export interface ProjectedResourceData {
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly childNodes?: readonly ProjectedChildEntry[];
}

export interface ProjectGetJsonResultInput {
  /** The already-classified `{ kind: "ok" }` body from `classifyAemResponse`. */
  readonly data: JsonObject;
  readonly args: AemGetJsonArgs;
  readonly requestId: RequestId;
  readonly sourceOrigin: string;
  readonly serverRevision: number;
  readonly fetchedAt: number;
}

/** True for a plain nested JSON object: excludes arrays and `null`, which are also part of the `JsonValue` union. */
function isChildNode(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the `AemGetJsonSuccess` object for one already-fetched, already-
 * classified node body. Reused by nothing but the `aem_get_json` handler;
 * kept in its own module because it is the one place that owns the
 * property/child split and must stay free of I/O to be exercisable with
 * plain fixtures.
 */
export function projectGetJsonResult(input: ProjectGetJsonResultInput): AemGetJsonSuccess {
  const propertyEntries: Array<readonly [string, JsonValue]> = [];
  const childNames: string[] = [];

  for (const [key, value] of Object.entries(input.data)) {
    if (isChildNode(value)) {
      childNames.push(key);
    } else {
      propertyEntries.push([key, value]);
    }
  }

  const requestedProperties = input.args.properties;
  let selection: PropertySelection;
  let selectedProperties: Record<string, JsonValue>;

  if (requestedProperties !== undefined) {
    selection = { kind: 'selected', properties: requestedProperties };
    const propertyValues = new Map(propertyEntries);
    selectedProperties = {};
    for (const name of requestedProperties) {
      // A requested name absent here is not an error (rule 4): it is simply
      // omitted from `properties`, and `selection.properties` still records
      // that it was asked for, so comparing the two after the fact is what
      // makes "requested but not found" discoverable - the contract has no
      // separate not-found list, and does not need one.
      const value = propertyValues.get(name);
      if (value !== undefined) {
        selectedProperties[name] = value;
      }
    }
  } else {
    selection = { kind: 'all' };
    selectedProperties = Object.fromEntries(propertyEntries);
  }

  const includeChildren = input.args.includeChildren ?? false;

  // `requested: false` carries no count at all, rather than a count of zero:
  // "the agent did not ask" and "this node genuinely has no children" are
  // different facts, and collapsing them into one `returned: 0` would tell
  // an agent that already decided not to look that there is nothing there.
  const childrenMetadata: ChildrenMetadata = includeChildren
    ? { requested: true, returned: childNames.length, hasMore: false }
    : { requested: false };

  const data: ProjectedResourceData = includeChildren
    ? {
        properties: selectedProperties,
        // Every immediate child key found above, unconditionally: there is
        // no page size or byte cap to apply here, so `hasMore` above is
        // always `false` - nothing is ever held back.
        childNodes: childNames.map((name) => ({ name })),
      }
    : { properties: selectedProperties };

  return {
    ok: true,
    operation: 'aem_get_json',
    requestId: input.requestId,
    sourceOrigin: input.sourceOrigin,
    serverRevision: input.serverRevision,
    path: input.args.path,
    fetchedAt: input.fetchedAt,
    data,
    selection,
    children: childrenMetadata,
  };
}
