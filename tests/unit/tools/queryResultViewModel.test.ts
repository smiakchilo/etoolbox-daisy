// noinspection HtmlDeprecatedAttribute,HtmlRequiredAltAttribute,HtmlUnknownTarget

import { describe, expect, it } from 'vitest';
import { readQueryResultTable } from '../../../src/tools/aem-query/renderer/queryResultViewModel';
import type { JsonValue } from '../../../src/shared';

function queryResult(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    ok: true,
    operation: 'aem_query',
    requestId: 'req-1',
    sourceOrigin: 'https://aem.example.com',
    serverRevision: 1,
    predicates: { path: '/content/site' },
    fetchedAt: 1_700_000_000_000,
    rows: [
      { 'jcr:path': '/content/site/a', 'jcr:title': 'Alpha' },
      { 'jcr:path': '/content/site/b', 'jcr:title': 'Beta' },
    ],
    selection: { kind: 'selected', properties: ['jcr:path', 'jcr:title'] },
    pagination: {
      offset: 0,
      limit: 25,
      returned: 2,
      hasMore: false,
      total: { accuracy: 'exact', value: 2 },
    },
    ...overrides,
  };
}

describe('readQueryResultTable - which payloads produce a table', () => {
  it('builds a table from an aem_query result', () => {
    const table = readQueryResultTable('aem_query', queryResult());
    expect(table?.columns).toEqual(['jcr:path', 'jcr:title']);
    expect(table?.rows).toEqual([
      ['/content/site/a', 'Alpha'],
      ['/content/site/b', 'Beta'],
    ]);
  });

  it('returns nothing for a different tool, even if the payload would parse', () => {
    expect(readQueryResultTable('aem_get_json', queryResult())).toBeUndefined();
  });

  it('returns nothing for an aem_get_json result under the query tool name', () => {
    const getJson: JsonValue = {
      ok: true,
      operation: 'aem_get_json',
      path: '/content/site/a',
      data: { 'jcr:title': 'Alpha' },
    };
    expect(readQueryResultTable('aem_query', getJson)).toBeUndefined();
  });

  it('degrades to no table rather than throwing on a malformed payload', () => {
    expect(readQueryResultTable('aem_query', undefined)).toBeUndefined();
    expect(readQueryResultTable('aem_query', null)).toBeUndefined();
    expect(readQueryResultTable('aem_query', 'not an object')).toBeUndefined();
    expect(readQueryResultTable('aem_query', [1, 2, 3])).toBeUndefined();
    expect(readQueryResultTable('aem_query', { operation: 'aem_query' })).toBeUndefined();
    expect(
      readQueryResultTable('aem_query', { operation: 'aem_query', rows: 'nope' }),
    ).toBeUndefined();
  });

  it('survives a result whose pagination block is missing entirely', () => {
    const table = readQueryResultTable(
      'aem_query',
      queryResult({ pagination: null as unknown as JsonValue }),
    );
    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(2);
  });
});

describe('readQueryResultTable - columns', () => {
  it('puts jcr:path first even when AEM returned it later in the row', () => {
    const table = readQueryResultTable(
      'aem_query',
      queryResult({
        rows: [{ 'jcr:title': 'Alpha', 'jcr:primaryType': 'cq:Page', 'jcr:path': '/a' }],
      }),
    );
    expect(table?.columns[0]).toBe('jcr:path');
  });

  it('keeps the remaining columns in the order AEM returned them', () => {
    const table = readQueryResultTable(
      'aem_query',
      queryResult({
        rows: [{ 'jcr:path': '/a', zebra: 'z', apple: 'a' }],
      }),
    );
    expect(table?.columns).toEqual(['jcr:path', 'zebra', 'apple']);
  });

  it('unions columns across rows so a property only some rows have still shows', () => {
    const table = readQueryResultTable(
      'aem_query',
      queryResult({
        rows: [
          { 'jcr:path': '/a', 'jcr:title': 'Alpha' },
          { 'jcr:path': '/b', 'cq:template': '/apps/t' },
        ],
      }),
    );
    expect(table?.columns).toEqual(['jcr:path', 'jcr:title', 'cq:template']);
    expect(table?.rows).toEqual([
      ['/a', 'Alpha', ''],
      ['/b', '', '/apps/t'],
    ]);
  });
});

describe('readQueryResultTable - cells', () => {
  it('renders numbers and booleans rather than blanking them', () => {
    const table = readQueryResultTable(
      'aem_query',
      queryResult({ rows: [{ 'jcr:path': '/a', depth: 3, hidden: false }] }),
    );
    expect(table?.rows[0]).toEqual(['/a', '3', 'false']);
  });

  it('renders a multi-valued property as JSON instead of losing it', () => {
    const table = readQueryResultTable(
      'aem_query',
      queryResult({ rows: [{ 'jcr:path': '/a', 'cq:tags': ['one', 'two'] }] }),
    );
    expect(table?.rows[0]?.[1]).toBe('["one","two"]');
  });

  it('renders a null property as an empty cell', () => {
    const table = readQueryResultTable(
      'aem_query',
      queryResult({ rows: [{ 'jcr:path': '/a', 'jcr:title': null }] }),
    );
    expect(table?.rows[0]).toEqual(['/a', '']);
  });

  it('does not interpret a property value as markup', () => {
    // The view model returns plain strings; it is the view's job to set them
    // as textContent. What matters here is that nothing is stripped or
    // transformed - the author's literal value reaches the cell.
    const table = readQueryResultTable(
      'aem_query',
      queryResult({ rows: [{ 'jcr:path': '/a', 'jcr:title': '<img src=x onerror=alert(1)>' }] }),
    );
    expect(table?.rows[0]?.[1]).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('readQueryResultTable - pagination status', () => {
  function statusFor(pagination: JsonValue): string {
    return readQueryResultTable('aem_query', queryResult({ pagination }))?.status ?? '';
  }

  it('states the range actually shown, one-based', () => {
    expect(
      statusFor({
        offset: 25,
        limit: 25,
        returned: 25,
        hasMore: true,
        total: { accuracy: 'estimated', value: 900 },
      }),
    ).toMatch(/Showing 26\u201350/);
  });

  it('marks an estimated total as approximate', () => {
    const status = statusFor({
      offset: 0,
      limit: 25,
      returned: 25,
      hasMore: true,
      total: { accuracy: 'estimated', value: 900 },
    });
    expect(status).toMatch(/approximately 900 matches/);
    expect(status).not.toMatch(/(?<!approximately )\b900 matches/);
  });

  it('states an exact total without hedging', () => {
    const status = statusFor({
      offset: 0,
      limit: 25,
      returned: 2,
      hasMore: false,
      total: { accuracy: 'exact', value: 2 },
    });
    expect(status).toMatch(/2 matches/);
    expect(status).not.toMatch(/approximately/);
  });

  it('says the total is unknown rather than inventing one', () => {
    const status = statusFor({
      offset: 0,
      limit: 25,
      returned: 25,
      hasMore: true,
      total: { accuracy: 'unknown' },
    });
    expect(status).toMatch(/unknown number of matches/);
  });

  it('says more results exist when hasMore is true', () => {
    expect(
      statusFor({
        offset: 0,
        limit: 25,
        returned: 25,
        hasMore: true,
        total: { accuracy: 'estimated', value: 900 },
      }),
    ).toMatch(/More results exist/);
  });

  it('says this is the last page only when hasMore is definitively false', () => {
    expect(
      statusFor({
        offset: 0,
        limit: 25,
        returned: 2,
        hasMore: false,
        total: { accuracy: 'exact', value: 2 },
      }),
    ).toMatch(/last page/);
  });

  it('does not claim the last page when hasMore is unknown', () => {
    const status = statusFor({
      offset: 0,
      limit: 25,
      returned: 25,
      hasMore: 'unknown',
      total: { accuracy: 'unknown' },
    });
    expect(status).toMatch(/unknown/i);
    expect(status).not.toMatch(/last page/);
  });

  it('reports an empty page honestly instead of showing a 1-0 range', () => {
    const status = statusFor({
      offset: 0,
      limit: 25,
      returned: 0,
      hasMore: false,
      total: { accuracy: 'exact', value: 0 },
    });
    expect(status).toMatch(/No matches on this page/);
    expect(status).not.toMatch(/Showing/);
  });
});

describe('readQueryResultTable - mayHaveMore', () => {
  it('is false only when hasMore is definitively false', () => {
    const last = readQueryResultTable('aem_query', queryResult());
    expect(last?.mayHaveMore).toBe(false);
  });

  it('is true when more pages exist', () => {
    const more = readQueryResultTable(
      'aem_query',
      queryResult({
        pagination: {
          offset: 0,
          limit: 25,
          returned: 25,
          hasMore: true,
          total: { accuracy: 'estimated', value: 900 },
        },
      }),
    );
    expect(more?.mayHaveMore).toBe(true);
  });

  it('is true when hasMore is unknown - an unknown is not a no', () => {
    const unknown = readQueryResultTable(
      'aem_query',
      queryResult({
        pagination: {
          offset: 0,
          limit: 25,
          returned: 25,
          hasMore: 'unknown',
          total: { accuracy: 'unknown' },
        },
      }),
    );
    expect(unknown?.mayHaveMore).toBe(true);
  });

  it('is not derived from the row count', () => {
    // A full page that is also the last page: row count alone would say
    // "probably more", `hasMore` says otherwise and must win.
    const full = readQueryResultTable(
      'aem_query',
      queryResult({
        rows: Array.from({ length: 25 }, (_unused, index) => ({
          'jcr:path': `/content/site/${String(index)}`,
        })),
        pagination: {
          offset: 0,
          limit: 25,
          returned: 25,
          hasMore: false,
          total: { accuracy: 'exact', value: 25 },
        },
      }),
    );
    expect(full?.mayHaveMore).toBe(false);
  });
});
