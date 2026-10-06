import { describe, expect, it } from 'vitest';
import { describeGenericArgs, parameterRows } from '../../../../src/shared';

/**
 * `parameterRows` is the single permitted way a tool builds
 * `ToolCallDetails.parameters` - the summary + ordered label/value rows pattern
 * `aem_query`'s renderer established. Every tool renderer builds through it
 * (AGENTS.md section 5), so its "drop absent rows, keep the order" behaviour is
 * load-bearing.
 */
describe('parameterRows', () => {
  it('keeps the written order and drops only rows whose value is undefined', () => {
    expect(
      parameterRows([
        ['First', 'a'],
        ['Skipped', undefined],
        ['Empty is kept', ''],
        ['Third', 'c'],
      ]),
    ).toEqual([
      { label: 'First', value: 'a' },
      { label: 'Empty is kept', value: '' },
      { label: 'Third', value: 'c' },
    ]);
  });

  it('returns an empty list when every value is absent', () => {
    expect(parameterRows([['A', undefined]])).toEqual([]);
  });
});

describe('describeGenericArgs (the fallback)', () => {
  it('renders one label/value row per argument, in argument order', () => {
    expect(describeGenericArgs({ foo: 'bar', count: 3 })).toEqual({
      summary: undefined,
      parameters: [
        { label: 'foo', value: 'bar' },
        { label: 'count', value: '3' },
      ],
    });
  });

  it('still describes an argument-less call, so no tool is ever invisible', () => {
    expect(describeGenericArgs({})).toEqual({
      summary: undefined,
      parameters: [{ label: 'Arguments', value: '(none)' }],
    });
  });
});
