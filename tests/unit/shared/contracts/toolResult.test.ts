import { describe, expect, it } from 'vitest';
import { createToolError } from '../../../../src/shared/contracts/errors';
import { requestIdSchema } from '../../../../src/shared/contracts/ids';
import {
  parseToolResult,
  renderToolResultForModel,
  serializeToolResult,
  toolResultSchema,
  type AemGetJsonSuccess,
  type AemQuerySuccess,
  type PropertySelection,
  type ToolErrorResult,
} from '../../../../src/shared/contracts/toolResult';

const REQUEST_ID = requestIdSchema.parse('req-1');

// Each helper is asserted to the specific branch it constructs. `toolResultSchema.parse`
// returns the full `ToolResult` union regardless of which literal branch actually matched,
// so without this the tests below could only access fields common to every branch.
function getJsonSuccess(overrides: Partial<Record<string, unknown>> = {}): AemGetJsonSuccess {
  return toolResultSchema.parse({
    ok: true,
    operation: 'aem_get_json',
    requestId: REQUEST_ID,
    sourceOrigin: 'https://author.example',
    serverRevision: 1,
    path: '/content/foo',
    fetchedAt: 1_000,
    data: { 'jcr:title': 'Foo' },
    selection: { kind: 'all' },
    children: { requested: false },
    ...overrides,
  }) as AemGetJsonSuccess;
}

function querySuccess(overrides: Partial<Record<string, unknown>> = {}): AemQuerySuccess {
  return toolResultSchema.parse({
    ok: true,
    operation: 'aem_query',
    requestId: REQUEST_ID,
    sourceOrigin: 'https://author.example',
    serverRevision: 1,
    predicates: { path: '/content' },
    fetchedAt: 1_000,
    rows: [],
    selection: { kind: 'all' },
    pagination: {
      offset: 0,
      limit: 50,
      returned: 0,
      hasMore: false,
      total: { accuracy: 'unknown' },
    },
    ...overrides,
  }) as AemQuerySuccess;
}

function errorResult(): ToolErrorResult {
  return toolResultSchema.parse({
    ok: false,
    error: createToolError('NOT_FOUND', 'No such node.', REQUEST_ID),
  }) as ToolErrorResult;
}

describe('toolResultSchema - success/error cannot be confused', () => {
  it('accepts a success result carrying zero rows', () => {
    const result = querySuccess({
      rows: [],
      pagination: {
        offset: 0,
        limit: 50,
        returned: 0,
        hasMore: false,
        total: { accuracy: 'unknown' },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an error result with no rows/data at all', () => {
    const result = errorResult();
    expect(result.ok).toBe(false);
  });

  it('rejects an error-shaped object that also carries a success field (rows)', () => {
    // A regression that let an error result carry `rows` would make an error
    // indistinguishable from "a query that matched nothing" downstream.
    const parsed = toolResultSchema.safeParse({
      ok: false,
      error: createToolError('NOT_FOUND', 'No such node.', REQUEST_ID),
      rows: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a success-shaped object that also carries an error field', () => {
    const parsed = toolResultSchema.safeParse({
      ok: true,
      operation: 'aem_query',
      requestId: REQUEST_ID,
      sourceOrigin: 'https://author.example',
      serverRevision: 1,
      predicates: { path: '/content' },
      fetchedAt: 1_000,
      rows: [],
      selection: { kind: 'all' },
      pagination: {
        offset: 0,
        limit: 50,
        returned: 0,
        hasMore: false,
        total: { accuracy: 'unknown' },
      },
      error: createToolError('NOT_FOUND', 'No such node.', REQUEST_ID),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty array standing in for an error (wrong shape entirely)', () => {
    expect(toolResultSchema.safeParse([]).success).toBe(false);
  });

  it('rejects a bare ok:false with no error payload', () => {
    expect(toolResultSchema.safeParse({ ok: false }).success).toBe(false);
  });
});

describe('PropertySelection', () => {
  it("distinguishes 'all properties returned' from 'only these were selected'", () => {
    const all = getJsonSuccess({ selection: { kind: 'all' } });
    const selected = getJsonSuccess({
      selection: { kind: 'selected', properties: ['jcr:title'] },
      data: { 'jcr:title': 'Foo' },
    });
    expect(all.ok && all.selection).toEqual({ kind: 'all' });
    expect(selected.ok && selected.selection).toEqual({
      kind: 'selected',
      properties: ['jcr:title'],
    });
  });

  it('is assignable to the field it documents without a cast (regression: exported type used to be readonly-array-incompatible with the schema output)', () => {
    // A hand-written `PropertySelection` with `readonly string[]` previously
    // could not be assigned to `AemGetJsonSuccess["selection"]`, which infers
    // `string[]` from the schema. This constructs a value using only the
    // exported type and assigns it to the field - a type error here means
    // the drift regressed, no runtime assertion needed to catch it.
    const built: PropertySelection = { kind: 'selected', properties: ['jcr:title'] };
    const result: AemGetJsonSuccess = getJsonSuccess({ selection: built });
    expect(result.selection).toEqual(built);
  });
});

describe('ChildrenMetadata', () => {
  it('accepts children.requested: false with no count/hasMore fields', () => {
    const result = getJsonSuccess({ children: { requested: false } });
    expect(result.ok && result.children).toEqual({ requested: false });
  });

  it('accepts children.requested: true carrying returned and hasMore', () => {
    const result = getJsonSuccess({
      children: { requested: true, returned: 12, hasMore: 'unknown' },
    });
    expect(result.ok && result.children).toEqual({
      requested: true,
      returned: 12,
      hasMore: 'unknown',
    });
  });

  it('rejects children.requested: true missing returned/hasMore (no bare boolean stand-in)', () => {
    // A regression here would look like the old `includesChildren: true` shape
    // - accepted, but unable to say whether the child list was complete.
    const parsed = toolResultSchema.safeParse({
      ok: true,
      operation: 'aem_get_json',
      requestId: REQUEST_ID,
      sourceOrigin: 'https://author.example',
      serverRevision: 1,
      path: '/content/foo',
      fetchedAt: 1_000,
      data: {},
      selection: { kind: 'all' },
      children: { requested: true },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a bare boolean in place of the children metadata object', () => {
    const parsed = toolResultSchema.safeParse({
      ok: true,
      operation: 'aem_get_json',
      requestId: REQUEST_ID,
      sourceOrigin: 'https://author.example',
      serverRevision: 1,
      path: '/content/foo',
      fetchedAt: 1_000,
      data: {},
      selection: { kind: 'all' },
      children: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('pagination metadata', () => {
  it("accepts hasMore: true, false, and the explicit 'unknown' state", () => {
    for (const hasMore of [true, false, 'unknown'] as const) {
      const result = querySuccess({
        pagination: { offset: 0, limit: 50, returned: 50, hasMore, total: { accuracy: 'unknown' } },
      });
      expect(result.ok && result.pagination.hasMore).toBe(hasMore);
    }
  });

  it("rejects a hasMore value other than true/false/'unknown'", () => {
    const parsed = toolResultSchema.safeParse({
      ok: true,
      operation: 'aem_query',
      requestId: REQUEST_ID,
      sourceOrigin: 'https://author.example',
      serverRevision: 1,
      predicates: {},
      fetchedAt: 1_000,
      rows: [],
      selection: { kind: 'all' },
      pagination: {
        offset: 0,
        limit: 50,
        returned: 0,
        hasMore: 'maybe',
        total: { accuracy: 'unknown' },
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('total matches accuracy', () => {
  it.each(['exact', 'estimated'] as const)('accepts a counted %s total', (accuracy) => {
    const result = querySuccess({
      pagination: {
        offset: 0,
        limit: 50,
        returned: 1,
        hasMore: false,
        total: { accuracy, value: 7 },
      },
    });
    expect(result.ok && result.pagination.total).toEqual({ accuracy, value: 7 });
  });

  it('accepts an unknown total with no count at all', () => {
    const result = querySuccess({
      pagination: {
        offset: 0,
        limit: 50,
        returned: 1,
        hasMore: false,
        total: { accuracy: 'unknown' },
      },
    });
    expect(result.ok && result.pagination.total).toEqual({ accuracy: 'unknown' });
  });

  it.each(['exact', 'estimated'] as const)(
    'rejects a %s total that carries no count',
    (accuracy) => {
      const parsed = toolResultSchema.safeParse({
        ok: true,
        operation: 'aem_query',
        requestId: REQUEST_ID,
        sourceOrigin: 'https://author.example',
        serverRevision: 1,
        predicates: {},
        fetchedAt: 1_000,
        rows: [],
        selection: { kind: 'all' },
        pagination: { offset: 0, limit: 50, returned: 0, hasMore: false, total: { accuracy } },
      });
      expect(parsed.success).toBe(false);
    },
  );

  it('rejects an unknown total that smuggles a count in anyway', () => {
    const parsed = toolResultSchema.safeParse({
      ok: true,
      operation: 'aem_query',
      requestId: REQUEST_ID,
      sourceOrigin: 'https://author.example',
      serverRevision: 1,
      predicates: {},
      fetchedAt: 1_000,
      rows: [],
      selection: { kind: 'all' },
      pagination: {
        offset: 0,
        limit: 50,
        returned: 0,
        hasMore: false,
        total: { accuracy: 'unknown', value: 9 },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects pagination metadata with no total at all', () => {
    const parsed = toolResultSchema.safeParse({
      ok: true,
      operation: 'aem_query',
      requestId: REQUEST_ID,
      sourceOrigin: 'https://author.example',
      serverRevision: 1,
      predicates: {},
      fetchedAt: 1_000,
      rows: [],
      selection: { kind: 'all' },
      pagination: { offset: 0, limit: 50, returned: 0, hasMore: false },
    });
    expect(parsed.success).toBe(false);
  });

  it('qualifies an estimated total in the model-facing text', () => {
    const text = renderToolResultForModel(
      querySuccess({
        pagination: {
          offset: 0,
          limit: 50,
          returned: 50,
          hasMore: true,
          total: { accuracy: 'estimated', value: 1234 },
        },
      }),
    );
    expect(text).toMatch(/approximately 1234/);
    expect(text).toMatch(/estimated, not an exact count/);
  });

  it('states an unknown total plainly rather than omitting it', () => {
    const text = renderToolResultForModel(
      querySuccess({
        pagination: {
          offset: 0,
          limit: 50,
          returned: 50,
          hasMore: true,
          total: { accuracy: 'unknown' },
        },
      }),
    );
    expect(text).toMatch(/total number of matches is unknown/i);
  });
});

describe('renderToolResultForModel', () => {
  it("preserves the 'more results exist' signal for hasMore: true", () => {
    const result = querySuccess({
      rows: [{ path: '/content/a' }],
      pagination: {
        offset: 0,
        limit: 1,
        returned: 1,
        hasMore: true,
        total: { accuracy: 'unknown' },
      },
    });
    const text = renderToolResultForModel(result);
    expect(text).toMatch(/more results exist/i);
  });

  it('states no further results exist for hasMore: false', () => {
    const result = querySuccess({
      pagination: {
        offset: 0,
        limit: 50,
        returned: 0,
        hasMore: false,
        total: { accuracy: 'unknown' },
      },
    });
    const text = renderToolResultForModel(result);
    expect(text).toMatch(/no further results exist/i);
  });

  it("states the more-results signal is unknown for hasMore: 'unknown'", () => {
    const result = querySuccess({
      pagination: {
        offset: 0,
        limit: 50,
        returned: 50,
        hasMore: 'unknown',
        total: { accuracy: 'unknown' },
      },
    });
    const text = renderToolResultForModel(result);
    expect(text).toMatch(/unknown/i);
  });

  it('renders an error result as an error, never as a zero-row success', () => {
    const text = renderToolResultForModel(errorResult());
    expect(text).toMatch(/error/i);
    expect(text).not.toMatch(/Returned 0 row/i);
  });

  it('renders a zero-row success as a success, never as an error', () => {
    const text = renderToolResultForModel(
      querySuccess({
        rows: [],
        pagination: {
          offset: 0,
          limit: 50,
          returned: 0,
          hasMore: false,
          total: { accuracy: 'unknown' },
        },
      }),
    );
    expect(text).not.toMatch(/AEM tool error/i);
    expect(text).toMatch(/Returned 0 row/i);
  });

  it("preserves the 'more children exist' signal for a get_json result", () => {
    const result = getJsonSuccess({
      children: { requested: true, returned: 50, hasMore: true },
    });
    const text = renderToolResultForModel(result);
    expect(text).toMatch(/more results exist/i);
  });

  it("states the children signal is unknown when hasMore is 'unknown'", () => {
    const result = getJsonSuccess({
      children: { requested: true, returned: 50, hasMore: 'unknown' },
    });
    const text = renderToolResultForModel(result);
    expect(text).toMatch(/unknown/i);
  });

  it('states children were not requested when children.requested is false', () => {
    const result = getJsonSuccess({ children: { requested: false } });
    const text = renderToolResultForModel(result);
    expect(text).toMatch(/not requested/i);
  });
});

describe('serialize/parse round trip', () => {
  it('round-trips a success result', () => {
    const original = querySuccess({
      rows: [{ path: '/content/a' }],
      pagination: {
        offset: 0,
        limit: 50,
        returned: 1,
        hasMore: 'unknown',
        total: { accuracy: 'unknown' },
      },
    });
    const outcome = parseToolResult(serializeToolResult(original));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual(original);
    }
  });

  it('round-trips an error result', () => {
    const original = errorResult();
    const outcome = parseToolResult(serializeToolResult(original));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual(original);
    }
  });

  it('reports failure, not a thrown exception, for malformed JSON', () => {
    const outcome = parseToolResult('{not json');
    expect(outcome.ok).toBe(false);
  });

  it('reports failure for well-formed JSON that does not match the schema', () => {
    const outcome = parseToolResult(JSON.stringify({ ok: true }));
    expect(outcome.ok).toBe(false);
  });
});
