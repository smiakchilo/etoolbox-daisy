import { describe, expect, it } from 'vitest';
import {
  FORMAT_TABLE_TOOL_NAME,
  createFormatTableExecutor,
  formatTableArgsSchema,
  formatTableSuccessSchema,
  normalizeFormatTable,
} from '../../../src/tools/format-table/formatTable';
import { renderer } from '../../../src/tools/format-table/renderer';
import { type ToolHost } from '../../../src/shared';
import { createCountingIdGenerator } from '../../support/testIds';

function makeHost(): ToolHost {
  const ids = createCountingIdGenerator('ft');
  return {
    bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
    currentContext: () => {
      throw new Error('format_table must never ask for an AEM context');
    },
    environmentFacts: () => undefined,
    configuredHosts: () => [],
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
    clock: () => 1,
    idGenerator: ids,
    invokeTool: () => Promise.reject(new Error('not used')),
  };
}

const callContext = { toolCallId: 'call-1' as never, signal: undefined };

describe('normalizeFormatTable', () => {
  it('reads an array of rows and hoists jcr:path to the first column', () => {
    const normalized = normalizeFormatTable(
      [{ 'jcr:title': 'A', 'jcr:path': '/content/a' }],
      'new',
    );
    expect(normalized?.columns).toEqual(['Path', 'Title']);
    expect(normalized?.rows).toEqual([['/content/a', 'A']]);
    expect(normalized?.total).toBeUndefined();
  });

  it('reads an object with a rows array and maps the agreed headers', () => {
    const normalized = normalizeFormatTable(
      {
        rows: [
          {
            'jcr:path': '/content/waldo',
            property: 'jcr:content/jcr:description',
            citation: 'good',
          },
        ],
      },
      'append',
    );
    expect(normalized?.columns).toEqual(['Path', 'Property', 'Citation']);
    expect(normalized?.rows).toEqual([['/content/waldo', 'jcr:content/jcr:description', 'good']]);
    expect(normalized?.mode).toBe('append');
  });

  it('maps value -> Value too', () => {
    const normalized = normalizeFormatTable({ rows: [{ path: '/x', value: 'v' }] }, 'new');
    expect(normalized?.columns).toEqual(['Path', 'Value']);
  });

  it('drops a duplicate path column when both jcr:path and path are present', () => {
    const normalized = normalizeFormatTable([{ 'jcr:path': '/a', path: '/b', title: 'T' }], 'new');
    expect(normalized?.columns).toEqual(['Path', 'Title']);
    expect(normalized?.rows).toEqual([['/a', 'T']]);
  });

  it('maps the component-search display key to Node, with the page under Path', () => {
    const normalized = normalizeFormatTable(
      [
        { 'jcr:path': '/content/site/a', node: 'jcr:content/root/text' },
        // A blanked repeat keeps its row and its empty cell.
        { 'jcr:path': '', node: 'jcr:content/root/text_2' },
      ],
      'new',
    );
    expect(normalized?.columns).toEqual(['Path', 'Node']);
    expect(normalized?.rows).toEqual([
      ['/content/site/a', 'jcr:content/root/text'],
      ['', 'jcr:content/root/text_2'],
    ]);
  });

  it('renders a lower-bound total as an at-least line, never a bare number', () => {
    const normalized = normalizeFormatTable(
      { rows: [], pagination: { total: { accuracy: 'atLeast', value: 900 } } },
      'new',
    );
    expect(normalized?.total).toBe('Total: at least 900');
  });

  it('reads a legacy `estimated` total as the same lower bound', () => {
    const normalized = normalizeFormatTable(
      { rows: [], pagination: { total: { accuracy: 'estimated', value: 900 } } },
      'new',
    );
    expect(normalized?.total).toBe('Total: at least 900');
  });

  it('renders a lower-bound total with hasMore:true as an open-ended lower bound', () => {
    const normalized = normalizeFormatTable(
      {
        rows: [],
        pagination: { hasMore: true, total: { accuracy: 'atLeast', value: 20 } },
      },
      'new',
    );
    expect(normalized?.total).toBe('Total: 20+');
  });

  it('marks the table as counting when totalPending is set', () => {
    const normalized = normalizeFormatTable({ rows: [] }, 'new', undefined, true);
    expect(normalized?.totalPending).toBe(true);
  });

  it('accepts an exact, a zero, and a top-level total', () => {
    expect(
      normalizeFormatTable(
        { rows: [], pagination: { total: { accuracy: 'exact', value: 0 } } },
        'new',
      )?.total,
    ).toBe('Total: 0');
    expect(normalizeFormatTable({ rows: [], total: 3 }, 'new')?.total).toBe('Total: 3');
  });

  it('filters non-record rows', () => {
    const normalized = normalizeFormatTable([{ path: '/a' }, 42, null, 'x'], 'new');
    expect(normalized?.rows).toHaveLength(1);
  });

  it('returns undefined when data is neither an array nor carries a rows array', () => {
    expect(normalizeFormatTable({ notRows: 1 }, 'new')).toBeUndefined();
    expect(normalizeFormatTable('nope', 'new')).toBeUndefined();
  });

  it('accepts the result as JSON text, with or without a code fence', () => {
    const json = JSON.stringify({
      rows: [{ 'jcr:path': '/content/a' }],
      pagination: { total: { accuracy: 'exact', value: 1 } },
    });
    for (const text of [json, '```json\n' + json + '\n```']) {
      const normalized = normalizeFormatTable(text, 'new');
      expect(normalized?.rows).toEqual([['/content/a']]);
      expect(normalized?.total).toBe('Total: 1');
    }
  });

  it("accepts aem_query's rendered text, reading the rows and the total from it", () => {
    const text = [
      'AEM query against https://x (revision 1, fetched at 5)',
      'Returned 2 row(s) at offset 0 with limit 2; more results exist beyond this page - ' +
        'request the next page at a higher offset; at least 2 match(es) in total ' +
        '(a lower bound, not an exact count)',
      'Selection: none',
      'Rows: [{"jcr:path":"/content/a"},{"jcr:path":"/content/b"}]',
    ].join('\n');
    const normalized = normalizeFormatTable(text, 'new');
    expect(normalized?.rows).toEqual([['/content/a'], ['/content/b']]);
    expect(normalized?.total).toBe('Total: 2+');
  });

  it('unwraps a result nested under a wrapper key and a stringified rows array', () => {
    expect(normalizeFormatTable({ result: { rows: [{ path: '/a' }] } }, 'new')?.rows).toEqual([
      ['/a'],
    ]);
    expect(normalizeFormatTable({ rows: '[{"path":"/a"}]' }, 'new')?.rows).toEqual([['/a']]);
  });

  it('treats a single row object as a one-row table', () => {
    expect(normalizeFormatTable({ 'jcr:path': '/a', title: 'T' }, 'new')?.rows).toEqual([
      ['/a', 'T'],
    ]);
  });

  it('stringifies object and multi-valued cells rather than dropping them', () => {
    const normalized = normalizeFormatTable([{ path: '/a', tags: ['x', 'y'] }], 'new');
    expect(normalized?.rows[0]?.[1]).toBe('["x","y"]');
  });
});

describe('formatTableArgsSchema', () => {
  it('defaults mode to new', () => {
    expect(formatTableArgsSchema.parse({ data: [] }).mode).toBe('new');
  });

  it('accepts an optional totalLine of 1-200 characters', () => {
    expect(formatTableArgsSchema.parse({ data: [], totalLine: ' None ' }).totalLine).toBe('None');
    expect(formatTableArgsSchema.safeParse({ data: [], totalLine: ' ' }).success).toBe(false);
    expect(formatTableArgsSchema.safeParse({ data: [], totalLine: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('accepts an optional totalPending flag', () => {
    expect(formatTableArgsSchema.parse({ data: [] }).totalPending).toBeUndefined();
    expect(formatTableArgsSchema.parse({ data: [], totalPending: true }).totalPending).toBe(true);
  });

  it('rejects an unknown key (strict)', () => {
    expect(formatTableArgsSchema.safeParse({ data: [], extra: 1 }).success).toBe(false);
  });
});

describe('createFormatTableExecutor', () => {
  it('returns a structured acknowledgement with the row count', async () => {
    const executor = createFormatTableExecutor(makeHost());
    const result = await executor(
      { data: { rows: [{ path: '/a' }, { path: '/b' }] } },
      callContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = formatTableSuccessSchema.parse(result.value);
    expect(payload.operation).toBe(FORMAT_TABLE_TOOL_NAME);
    expect(payload.rowCount).toBe(2);
    expect(payload.mode).toBe('new');
    expect(payload.textResultForLlm).toBe('Presented 2 rows.');
  });

  it('fails with INVALID_ARGUMENT when data is not a rows container', async () => {
    const executor = createFormatTableExecutor(makeHost());
    const result = await executor({ data: { notRows: true } }, callContext);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('fails with INVALID_ARGUMENT on an unknown argument', async () => {
    const executor = createFormatTableExecutor(makeHost());
    const result = await executor({ data: [], nope: 1 }, callContext);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('format_table transcript composition', () => {
  it('is presented as a message, never a billet', () => {
    expect(renderer.presentation).toBe('message');
    expect(renderer.readTableMessage).toBeTypeOf('function');
  });

  it('reads the table from the call arguments, defaulting the mode to new', () => {
    const message = renderer.readTableMessage?.({ data: { rows: [{ 'jcr:path': '/a' }] } });
    expect(message?.mode).toBe('new');
    expect(message?.table.columns).toEqual(['Path']);
    expect(message?.table.rows).toEqual([['/a']]);
  });

  it('reads an explicit append mode and the total line', () => {
    const message = renderer.readTableMessage?.({
      data: {
        rows: [{ 'jcr:path': '/a' }],
        pagination: { total: { accuracy: 'exact', value: 1 } },
      },
      mode: 'append',
    });
    expect(message?.mode).toBe('append');
    expect(message?.total).toBe('Total: 1');
  });

  it('reads the totalPending flag off the call arguments', () => {
    expect(renderer.readTableMessage?.({ data: { rows: [] } })?.totalPending).toBe(false);
    expect(
      renderer.readTableMessage?.({ data: { rows: [] }, totalPending: true })?.totalPending,
    ).toBe(true);
  });

  it('lets totalLine replace the derived total, and ignores a blank one', () => {
    const data = {
      rows: [{ 'jcr:path': '/a' }],
      pagination: { total: { accuracy: 'exact', value: 9 } },
    };
    expect(renderer.readTableMessage?.({ data, totalLine: '  Total: 1 so far ' })?.total).toBe(
      'Total: 1 so far',
    );
    expect(renderer.readTableMessage?.({ data, totalLine: ' ' })?.total).toBe('Total: 9');
    expect(
      renderer.readTableMessage?.({
        data: { rows: [] },
        totalLine: 'Did not find any relevant results so far',
      })?.total,
    ).toBe('Did not find any relevant results so far');
  });

  it('describes the call as N rows (the collapsed safety net)', () => {
    const details = renderer.describeCall({
      data: { rows: [{ 'jcr:path': '/a' }, { 'jcr:path': '/b' }] },
    });
    expect(details.summary).toBe('2 rows');
    expect(details.parameters).toEqual([{ label: 'Rows', value: '2' }]);
  });

  it('returns undefined for a call it does not recognise', () => {
    expect(renderer.readTableMessage?.({})).toBeUndefined();
  });
});
