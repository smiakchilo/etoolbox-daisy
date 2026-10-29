import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyReportState,
  renderReportMessage,
} from '../../../../src/renderer/src/chat/reportView';
import type { ToolReportMessage } from '../../../../src/shared';
import { EMPTY_LINK_CONTEXT } from '../../../../src/renderer/src/chat/linkTargets';

/**
 * A report message's DOM: its collapsible rubric sections and audit
 * entries, and the evidence blocks under them - a table with a selector link
 * and code snippet, a checklist, a node, a request tree. The accordion state is
 * applied in place by `applyReportState`, mirroring a tool-call billet.
 */

const dom = new JSDOM();
globalThis.document = dom.window.document;

afterAll(() => {
  globalThis.document = undefined as unknown as Document;
});

/** Renders the report's content into a container, the way the transcript shell holds it. */
function renderInto(): HTMLElement {
  const container = document.createElement('div');
  container.append(...renderReportMessage(REPORT, EMPTY_LINK_CONTEXT).nodes);
  return container;
}

const REPORT: ToolReportMessage = {
  summary: {
    kind: 'table',
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'score', label: 'Score' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    rows: [
      [
        { kind: 'text', value: 'Performance' },
        { kind: 'text', value: '70' },
        { kind: 'text', value: 'warn' },
      ],
    ],
  },
  sections: [
    {
      title: 'Performance',
      entries: [
        {
          id: 'performance:target-size',
          title: 'Touch targets do not have sufficient size or spacing',
          displayValue: '3 failing elements',
          blocks: [
            {
              kind: 'table',
              columns: [{ key: 'node', label: 'Failing Elements' }],
              rows: [
                [
                  {
                    kind: 'selector',
                    selector: 'div#tile > h6.title',
                    snippet: '<h6 class="title">Hello</h6>',
                    label: 'h6',
                  },
                ],
              ],
            },
            {
              kind: 'text',
              value:
                'Learn more about the Total Blocking Time metric (https://developer.chrome.com/docs/tbt/).',
            },
          ],
        },
        {
          id: 'performance:duplicated-js',
          title: 'Duplicated JavaScript',
          blocks: [
            {
              kind: 'table',
              columns: [
                { key: 'source', label: 'Source' },
                { key: 'sub', label: 'Sub items' },
              ],
              rows: [
                [
                  { kind: 'text', value: 'lodash' },
                  {
                    kind: 'list',
                    items: [
                      { kind: 'text', value: 'https://cdn.example/a.js' },
                      { kind: 'text', value: 'https://cdn.example/b.js' },
                    ],
                  },
                ],
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('renderReportMessage', () => {
  it('renders rubric sections and audit entries, rubrics expanded and entries collapsed', () => {
    const container = renderInto();

    const section = container.querySelector('.chat-report-section');
    expect(section?.querySelector('.chat-report-section__title')?.textContent).toBe('Performance');
    expect(section?.querySelector('.chat-report-section__body')?.getAttribute('hidden')).toBeNull();

    const entry = container.querySelector('.chat-report-entry');
    expect(entry?.querySelector('.chat-report-entry__title')?.textContent).toContain(
      'Touch targets',
    );
    expect(entry?.querySelector('.chat-report-entry__value')?.textContent).toBe(
      '3 failing elements',
    );
    expect(entry?.querySelector('.chat-report-entry__body')?.hasAttribute('hidden')).toBe(true);
  });

  it('renders a failing element as a selector link and a code snippet', () => {
    const container = renderInto();

    const selector = container.querySelector('button[data-daisy-selector]');
    expect(selector?.getAttribute('data-daisy-selector')).toBe('div#tile > h6.title');
    expect(selector?.textContent).toBe('div#tile > h6.title');
    expect(container.querySelector('.chat-report-cell__snippet')?.textContent).toBe(
      '<h6 class="title">Hello</h6>',
    );
  });

  it('renders a list cell as separate paragraphs', () => {
    const container = renderInto();

    const list = container.querySelector('.chat-report-cell__list');
    expect(list?.querySelectorAll('.chat-report-cell__list-item')).toHaveLength(2);
  });

  it('renders the summary table with a status light column', () => {
    const container = renderInto();

    expect(container.querySelector('.chat-report-table sp-table')).not.toBeNull();
    expect(container.querySelector('.chat-report-table__status')?.textContent).toBe('warn');
  });

  it('linkifies a text block, so its "Learn more" URL is a real anchor', () => {
    const container = renderInto();

    const paragraph = container.querySelector('.chat-report-text');
    expect(paragraph?.textContent).toContain('Learn more about the Total Blocking Time metric');
    const link = paragraph?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://developer.chrome.com/docs/tbt/');
    expect(link?.getAttribute('data-daisy-external')).toBe('');
  });

  it('reports each table with the data its Copy/Export gutter serializes', () => {
    const rendered = renderReportMessage(REPORT, EMPTY_LINK_CONTEXT);

    const entryTable = rendered.tables.find(
      (table) => table.data.columns[0] === 'Failing Elements',
    );
    expect(entryTable).toBeDefined();
    expect(entryTable?.data.rows[0]?.[0]).toContain('div#tile > h6.title');
    // The shell is a `chat-table-message`, the class the shared gutter discovers.
    expect(entryTable?.shell.classList.contains('chat-table-message')).toBe(true);
    expect(entryTable?.shell.querySelector('.chat-table-message__title, sp-table')).not.toBeNull();
  });
});

describe('applyReportState', () => {
  it('collapses a rubric and expands exactly one entry', () => {
    const container = renderInto();

    applyReportState(container, {
      collapsedRubrics: new Set(['Performance']),
      expandedEntry: 'performance:target-size',
    });

    const sectionToggle = container.querySelector(
      '[data-report-rubric="Performance"]',
    ) as HTMLElement;
    expect(sectionToggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector<HTMLElement>('.chat-report-section__body')?.hasAttribute('hidden'),
    ).toBe(true);

    const entryToggle = container.querySelector(
      '[data-report-entry="performance:target-size"]',
    ) as HTMLElement;
    expect(entryToggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      container
        .querySelector<HTMLElement>('[data-report-entry-body="performance:target-size"]')
        ?.hasAttribute('hidden'),
    ).toBe(false);
    // The other entry stays collapsed (the accordion holds one open).
    expect(
      container
        .querySelector<HTMLElement>('[data-report-entry-body="performance:duplicated-js"]')
        ?.hasAttribute('hidden'),
    ).toBe(true);
  });

  it('gives a toggle and its body distinct attributes, so a click inside never looks like a toggle', () => {
    const container = renderInto();
    const sectionBody = container.querySelector('.chat-report-section__body');
    // The body must not answer `closest('[data-report-rubric]')` (the toggle's
    // selector): otherwise clicking a link inside it toggles the section.
    expect(sectionBody?.hasAttribute('data-report-rubric')).toBe(false);
    expect(sectionBody?.hasAttribute('data-report-rubric-body')).toBe(true);
  });
});
