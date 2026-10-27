import { describe, expect, it } from 'vitest';
import { renderer } from '../../../../src/tools/page-audit/renderer';
import type { JsonValue } from '../../../../src/shared';

/**
 * `readReportMessage` turns the page_audit result back into the structured
 * report the transcript paints: a summary score table, then one rubric section
 * per non-empty category holding its audits' evidence blocks.
 */

const RESULT: JsonValue = {
  ok: true,
  operation: 'page_audit',
  url: 'https://author.example/page.html',
  formFactor: 'desktop',
  scores: [
    { category: 'performance', score: 70 },
    { category: 'accessibility', score: 95 },
    { category: 'seo', score: 100 },
  ],
  failures: [
    {
      category: 'performance',
      id: 'largest-contentful-paint',
      title: 'Largest Contentful Paint',
      score: 33,
      displayValue: '3.0 s',
      evidence: [
        {
          kind: 'table',
          columns: [{ key: 'label', label: 'Subpart' }],
          rows: [[{ kind: 'text', value: 'Time to first byte' }]],
        },
      ],
    },
    {
      category: 'accessibility',
      id: 'target-size',
      title: 'Touch targets do not have sufficient size or spacing',
      score: 0,
      evidence: [{ kind: 'text', value: 'Fix it.' }],
    },
  ],
};

describe('page_audit readReportMessage', () => {
  it('builds the summary score table and rubric sections in category order', () => {
    const report = renderer.readReportMessage?.({}, RESULT);

    expect(report?.summary?.columns.map((column) => column.label)).toEqual([
      'Category',
      'Score',
      'Status',
    ]);
    expect(report?.sections.map((section) => section.title)).toEqual([
      'Performance',
      'Accessibility',
    ]);
  });

  it('keys each entry by category:id and carries its evidence blocks verbatim', () => {
    const report = renderer.readReportMessage?.({}, RESULT);

    expect(report?.sections[0]?.entries[0]).toMatchObject({
      id: 'performance:largest-contentful-paint',
      title: 'Largest Contentful Paint',
      displayValue: '3.0 s',
      score: 33,
      blocks: [{ kind: 'table', rows: [[{ kind: 'text', value: 'Time to first byte' }]] }],
    });
    expect(report?.sections[1]?.entries[0]?.blocks).toEqual([{ kind: 'text', value: 'Fix it.' }]);
  });

  it('returns undefined for a result that is not a settled page_audit success', () => {
    expect(renderer.readReportMessage?.({}, { ok: false })).toBeUndefined();
    expect(renderer.readReportMessage?.({}, undefined)).toBeUndefined();
  });
});
