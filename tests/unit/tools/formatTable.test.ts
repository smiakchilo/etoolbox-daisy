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
    requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
    clock: () => 1,
    idGenerator: ids,
  };
}

const callContext = { toolCallId: 'call-1' as never, signal: undefined };

describe('normalizeFormatTable', () => {
  it('reads an array of rows and hoists jcr:path to the first column', () => {
    const normalized = normalizeFormatTable(
      [{ 'jcr:title': 'A', 'jcr:path': '/content/a' }],
      'new',
    );
    expect(normalized?.columns).toEqual(['Path', 'Jcr Title']);
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

  it('renders the query total as a Total line, never a bare number', () => {
    const normalized = normalizeFormatTable(
      { rows: [], pagination: { total: { accuracy: 'estimated', value: 900 } } },
      'new',
    );
    expect(normalized?.total).toBe('Total: approximately 900 results');
  });

  it('renders an estimated total with hasMore:true as an open-ended lower bound', () => {
    const normalized = normalizeFormatTable(
      {
        rows: [],
        pagination: { hasMore: true, total: { accuracy: 'estimated', value: 20 } },
      },
      'new',
    );
    expect(normalized?.total).toBe('Total: 20+ results');
  });

  it('accepts an exact, a zero, and a top-level total', () => {
    expect(
      normalizeFormatTable(
        { rows: [], pagination: { total: { accuracy: 'exact', value: 0 } } },
        'new',
      )?.total,
    ).toBe('Total: 0 results');
    expect(normalizeFormatTable({ rows: [], total: 3 }, 'new')?.total).toBe('Total: 3 results');
  });

  it('filters non-record rows', () => {
    const normalized = normalizeFormatTable([{ path: '/a' }, 42, null, 'x'], 'new');
    expect(normalized?.rows).toHaveLength(1);
  });

  it('returns undefined when data is neither an array nor carries a rows array', () => {
    expect(normalizeFormatTable({ notRows: 1 }, 'new')).toBeUndefined();
    expect(normalizeFormatTable('nope', 'new')).toBeUndefined();
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
    expect(message?.total).toBe('Total: 1 result');
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
