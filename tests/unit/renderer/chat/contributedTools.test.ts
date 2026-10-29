import { describe, expect, it } from 'vitest';
import {
  type JsonValue,
  type ToolReportMessage,
  TOOL_REPORT_PAYLOAD_KEY,
} from '../../../../src/shared';
import type { AddonPins } from '../../../../src/shared/addons/pins';
import {
  contributeToolRenderers,
  describeContributedCall,
  readContributedReport,
} from '../../../../src/renderer/src/chat/contributedTools';
import { createToolRendererRegistry } from '../../../../src/renderer/src/chat/toolRegistry';

/**
 * A contributed tool's transcript view: its billet comes from the pins (a data
 * spec, not code), and a `presentation: 'report'` result is read through the
 * generic `data.report` convention. Nothing here names an add-on.
 */

const BILLET = {
  summary: { path: 'target', fallback: 'Current page' },
  rows: [
    { label: 'Target', value: { path: 'target', fallback: 'Current page' } },
    { label: 'Kinds', value: { path: 'kinds', join: ', ' } },
    { label: 'Mode', value: { path: 'mode' } },
    { label: 'Count', value: { path: 'count' } },
  ],
};

const PINS: AddonPins = {
  'example-addon': {
    identity: '0123456789abcdef',
    apiVersion: 1,
    contributions: {
      tools: [
        {
          name: 'example_tool',
          descriptor: {
            name: 'example_tool',
            description: 'An example.',
            parameters: { type: 'object', properties: {} },
          },
          allowlistEntry: 'custom:example_tool',
          instructions: 'Use it.',
          billet: BILLET,
        },
        {
          name: 'example_report',
          descriptor: {
            name: 'example_report',
            description: 'An example report.',
            parameters: { type: 'object', properties: {} },
          },
          allowlistEntry: 'custom:example_report',
          instructions: 'Use it.',
          presentation: 'report',
        },
      ],
      skills: [],
    },
  },
};

const REPORT: ToolReportMessage = {
  summary: {
    kind: 'table',
    columns: [{ key: 'name', label: 'Name' }],
    rows: [[{ kind: 'text', value: 'one' }]],
  },
  sections: [{ title: 'Section', entries: [{ id: 'a:b', title: 'Entry', blocks: [] }] }],
};

describe('a contributed billet', () => {
  it('reads the summary and every row from the call’s own arguments', () => {
    const details = describeContributedCall(BILLET, {
      target: '/content/a.html',
      kinds: ['one', 'two'],
      mode: 'fast',
      count: 3,
    });

    expect(details.summary).toBe('/content/a.html');
    expect(details.parameters).toEqual([
      { label: 'Target', value: '/content/a.html' },
      { label: 'Kinds', value: 'one, two' },
      { label: 'Mode', value: 'fast' },
      { label: 'Count', value: '3' },
    ]);
  });

  it('falls back, and omits a row whose value is still empty', () => {
    const details = describeContributedCall(BILLET, {});

    expect(details.summary).toBe('Current page');
    expect(details.parameters).toEqual([{ label: 'Target', value: 'Current page' }]);
  });

  it('falls back to the generic argument dump when the pins carry no billet', () => {
    const details = describeContributedCall(undefined, { target: 'x' });

    expect(details.summary).toBeUndefined();
    expect(details.parameters).toEqual([{ label: 'Arguments', value: 'target: x' }]);
  });
});

describe('a contributed tool in the registry', () => {
  it('renders its billet through the pins', () => {
    const registry = createToolRendererRegistry({}, contributeToolRenderers(PINS));

    expect([...registry.toolNames].sort()).toEqual(['example_report', 'example_tool']);
    expect(registry.describeCall('example_tool', { target: '/content/a.html' }).summary).toBe(
      '/content/a.html',
    );
  });

  it('declares the presentation the pins name, and no report reader otherwise', () => {
    const registry = createToolRendererRegistry({}, contributeToolRenderers(PINS));

    expect(registry.presentationOf('example_report')).toBe('report');
    expect(registry.presentationOf('example_tool')).toBe('billet');
    expect(registry.readReportMessage('example_tool', {})).toBeUndefined();
  });

  it('paints the report a settled result carries under data.report', () => {
    const registry = createToolRendererRegistry({}, contributeToolRenderers(PINS));
    const data = { ok: true, [TOOL_REPORT_PAYLOAD_KEY]: REPORT } as unknown as JsonValue;

    expect(registry.readReportMessage('example_report', {}, data)).toEqual(REPORT);
  });

  it('paints nothing for a result without a report', () => {
    const registry = createToolRendererRegistry({}, contributeToolRenderers(PINS));

    expect(registry.readReportMessage('example_report', {}, { ok: true })).toBeUndefined();
    expect(readContributedReport(undefined)).toBeUndefined();
    expect(readContributedReport({ report: { sections: 'no' } })).toBeUndefined();
  });

  it('replays a journal from before reports existed as a plain billet', () => {
    // A stored call from an older payload carries the evidence at the top level
    // and no `report` key at all. There is no compatibility reader: the report is
    // simply not painted, and the ordinary billet remains.
    const registry = createToolRendererRegistry({}, contributeToolRenderers(PINS));
    const oldResult = {
      ok: true,
      url: 'https://example.com/',
      scores: [{ category: 'performance', score: 90 }],
      failures: [],
      textResultForLlm: 'done',
      resultType: 'success',
    } as unknown as JsonValue;

    expect(registry.readReportMessage('example_report', {}, oldResult)).toBeUndefined();
    expect(registry.presentationOf('example_report')).toBe('report');
  });
});
