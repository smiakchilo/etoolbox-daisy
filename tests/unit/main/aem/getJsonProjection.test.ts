import { describe, expect, it } from 'vitest';
import {
  projectGetJsonResult,
  type ProjectedResourceData,
} from '../../../../src/main/aem/getJsonProjection';
import {
  aemGetJsonArgsSchema,
  type AemGetJsonArgs,
} from '../../../../src/shared/contracts/toolContracts';
import { requestIdSchema } from '../../../../src/shared/contracts/ids';
import { toolResultSchema } from '../../../../src/shared/contracts/toolResult';
import type { AemGetJsonSuccess } from '../../../../src/shared/contracts/toolResult';
import type { JsonObject } from '../../../../src/main/aem/responseValidation';

const REQUEST_ID = requestIdSchema.parse('req-1');
const SOURCE_ORIGIN = 'https://author.example';

function args(overrides: Partial<AemGetJsonArgs> = {}): AemGetJsonArgs {
  return aemGetJsonArgsSchema.parse({ path: '/content/foo', ...overrides });
}

function project(data: JsonObject, argsOverrides: Partial<AemGetJsonArgs> = {}) {
  return projectGetJsonResult({
    data,
    args: args(argsOverrides),
    requestId: REQUEST_ID,
    sourceOrigin: SOURCE_ORIGIN,
    serverRevision: 1,
    fetchedAt: 1_000,
  });
}

describe('projectGetJsonResult', () => {
  it("classifies a key by its value's JSON shape: nested objects are children, everything else is a property", () => {
    const result = project(
      {
        'jcr:title': 'Home',
        count: 3,
        flag: true,
        missing: null,
        tags: ['a', 'b'],
        'jcr:content': { 'jcr:title': 'child' },
      },
      { includeChildren: true },
    );

    const data = result.data as ProjectedResourceData;
    expect(data.properties).toEqual({
      'jcr:title': 'Home',
      count: 3,
      flag: true,
      missing: null,
      tags: ['a', 'b'],
    });
    expect(data.childNodes).toEqual([{ name: 'jcr:content' }]);
  });

  it('returns only immediate children, never a recursive grandchild tree', () => {
    const result = project(
      {
        'jcr:content': {
          'jcr:title': 'Home',
          par: {
            'jcr:primaryType': 'nt:unstructured',
          },
        },
      },
      { includeChildren: true },
    );

    const data = result.data as ProjectedResourceData;
    expect(data.childNodes).toEqual([{ name: 'jcr:content' }]);
    expect(JSON.stringify(data)).not.toContain('par');
    expect(JSON.stringify(data)).not.toContain('nt:unstructured');
  });

  it('returns only the requested properties when a selection is given', () => {
    const result = project(
      { 'jcr:title': 'Home', 'jcr:description': 'About us', count: 3 },
      { properties: ['jcr:title', 'count'] },
    );

    const data = result.data as ProjectedResourceData;
    expect(data.properties).toEqual({ 'jcr:title': 'Home', count: 3 });
    expect(result.selection).toEqual({ kind: 'selected', properties: ['jcr:title', 'count'] });
  });

  it('returns every property when no selection is given', () => {
    const result = project({ 'jcr:title': 'Home', count: 3 });

    const data = result.data as ProjectedResourceData;
    expect(data.properties).toEqual({ 'jcr:title': 'Home', count: 3 });
    expect(result.selection).toEqual({ kind: 'all' });
  });

  it('omits a requested property that does not exist, rather than failing the whole request', () => {
    const result = project(
      { 'jcr:title': 'Home' },
      { properties: ['jcr:title', 'does-not-exist'] },
    );

    const data = result.data as ProjectedResourceData;
    expect(data.properties).toEqual({ 'jcr:title': 'Home' });
    expect('does-not-exist' in data.properties).toBe(false);
    // The requested list still names it, so comparing selection.properties
    // against the returned property keys is what makes "asked for, not
    // found" discoverable, rather than the request failing outright.
    expect(result.selection).toEqual({
      kind: 'selected',
      properties: ['jcr:title', 'does-not-exist'],
    });
  });

  it('keeps a requested property whose value is null, because absent and null are different facts', () => {
    // The lookup that assembles a selection cannot use truthiness or a bare
    // nullish check to decide whether a property was found: `null` is a
    // legitimate JCR property value, and silently dropping it would report
    // the property as absent from the node when it is present and empty.
    const result = project(
      { 'jcr:title': null, other: 'x' },
      { properties: ['jcr:title', 'genuinely-absent'] },
    );

    const data = result.data as ProjectedResourceData;
    expect('jcr:title' in data.properties).toBe(true);
    expect(data.properties['jcr:title']).toBeNull();
    expect('genuinely-absent' in data.properties).toBe(false);
  });

  it('does not return a child node as though it were a property when its name is requested', () => {
    // `jcr:content` is the name an agent is most likely to ask for by reflex,
    // and on a depth-1 body it is a child object rather than a property. It
    // must not leak into `properties` - that would hand back the child's whole
    // subtree under the one key the selection was supposed to narrow.
    const result = project(
      { 'jcr:content': { 'jcr:title': 'Home', nested: { deep: 1 } }, 'jcr:primaryType': 'cq:Page' },
      { properties: ['jcr:content'] },
    );

    const data = result.data as ProjectedResourceData;
    expect(data.properties).toEqual({});
  });

  it('omits children entirely and marks them as not requested when includeChildren is false', () => {
    const result = project({ 'jcr:content': { 'jcr:title': 'Home' } }, { includeChildren: false });

    const data = result.data as ProjectedResourceData;
    expect('childNodes' in data).toBe(false);
    expect(result.children).toEqual({ requested: false });
  });

  it('omits children entirely and marks them as not requested when includeChildren is left unset', () => {
    const result = project({ 'jcr:content': { 'jcr:title': 'Home' } });

    const data = result.data as ProjectedResourceData;
    expect('childNodes' in data).toBe(false);
    expect(result.children).toEqual({ requested: false });
  });

  it('reports the actual number of children returned, matching the names it hands back', () => {
    // `returned` is what tells a model how much of the node it has seen. A
    // count that does not match the accompanying names is worse than no count,
    // because the model has no way to notice the discrepancy.
    const result = project(
      {
        'jcr:primaryType': 'cq:Page',
        'jcr:content': { 'jcr:title': 'Home' },
        en: { 'jcr:title': 'English' },
        de: { 'jcr:title': 'German' },
      },
      { includeChildren: true },
    );

    const data = result.data as ProjectedResourceData;
    expect(data.childNodes?.map((child) => child.name)).toEqual(['jcr:content', 'en', 'de']);
    expect(result.children).toEqual({ requested: true, returned: 3, hasMore: false });
  });

  it('reports zero returned children as an explicit count, distinct from never having looked', () => {
    const notRequested = project({ 'jcr:title': 'Home' }, { includeChildren: false });
    const requestedButEmpty = project({ 'jcr:title': 'Home' }, { includeChildren: true });

    expect(notRequested.children).toEqual({ requested: false });
    expect(requestedButEmpty.children).toEqual({ requested: true, returned: 0, hasMore: false });
    // `requested: false` has no `returned` field at all - it is not merely
    // `returned: 0` - so "did not look" and "looked, found none" cannot be
    // confused by reading this field alone.
    expect('returned' in notRequested.children).toBe(false);
  });

  it('never truncates a payload larger than 1 MiB', () => {
    const bigValue = 'x'.repeat(2_000_000);
    const result = project({ big: bigValue, small: 1 });

    const data = result.data as ProjectedResourceData;
    expect(JSON.stringify(result).length).toBeGreaterThan(1024 * 1024);
    expect(data.properties['big']).toBe(bigValue);
    expect((data.properties['big'] as string).length).toBe(2_000_000);
  });

  it("does not embed a child's own properties or descendants in its child entry", () => {
    const result = project(
      {
        'jcr:content': {
          'jcr:title': 'Home',
          count: 42,
          grandchild: { 'jcr:primaryType': 'nt:unstructured' },
        },
      },
      { includeChildren: true },
    );

    const data = result.data as ProjectedResourceData;
    expect(data.childNodes).toEqual([{ name: 'jcr:content' }]);
    const childEntry = data.childNodes?.[0];
    expect(childEntry).toBeDefined();
    expect(Object.keys(childEntry as object)).toEqual(['name']);
  });

  it('preserves colon-containing and underscore-prefixed property names unmangled', () => {
    const result = project({
      'jcr:primaryType': 'cq:Page',
      'sling:resourceType': 'site/components/page',
      _customFlag: true,
    });

    const data = result.data as ProjectedResourceData;
    expect(data.properties).toEqual({
      'jcr:primaryType': 'cq:Page',
      'sling:resourceType': 'site/components/page',
      _customFlag: true,
    });
    expect(Object.keys(data.properties)).toEqual([
      'jcr:primaryType',
      'sling:resourceType',
      '_customFlag',
    ]);
  });

  it('never throws and returns a well-formed result for an empty resource body', () => {
    let result: AemGetJsonSuccess | undefined;
    expect(() => {
      result = project({});
    }).not.toThrow();

    const data = result?.data as ProjectedResourceData;
    expect(data.properties).toEqual({});
    expect('childNodes' in data).toBe(false);
    expect(result?.selection).toEqual({ kind: 'all' });
    expect(result?.children).toEqual({ requested: false });
  });

  it('produces a result that satisfies the shared tool result contract exactly', () => {
    const result = project(
      { 'jcr:title': 'Home', 'jcr:content': { 'jcr:title': 'child' } },
      { includeChildren: true },
    );

    expect(() => toolResultSchema.parse(result)).not.toThrow();
    expect(Object.keys(result).sort()).toEqual(
      [
        'ok',
        'operation',
        'requestId',
        'sourceOrigin',
        'serverRevision',
        'path',
        'fetchedAt',
        'data',
        'selection',
        'children',
      ].sort(),
    );
  });
});
