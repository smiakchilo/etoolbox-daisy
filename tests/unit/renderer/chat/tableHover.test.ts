import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  isTableDataRow,
  tableGutterFrom,
  tableHoverActions,
} from '../../../../src/renderer/src/chat/tableHover';
import type { TableExportData } from '../../../../src/renderer/src/chat/tableExport';

/**
 * The `format_table` gutter: its two bands (the header row and the message
 * surface above it; the total line and the surface below the table), never a
 * data row or the side padding alongside the rows - and what its hover popover
 * offers.
 *
 * The real popover needs Spectrum's overlay, which never loads under jsdom;
 * this covers the two things the popover depends on - the region test and the
 * action composition - so the only part left to the E2E is the overlay itself.
 */

const dom = new JSDOM();
globalThis.document = dom.window.document;

const TABLE_MARKUP = `
  <sp-table class="chat-table-message__table">
    <sp-table-head class="head">
      <sp-table-head-cell class="head-cell">#</sp-table-head-cell>
      <sp-table-head-cell>Path</sp-table-head-cell>
    </sp-table-head>
    <sp-table-body>
      <sp-table-row><sp-table-cell class="body-cell">1</sp-table-cell></sp-table-row>
      <sp-table-row><sp-table-cell>2</sp-table-cell></sp-table-row>
    </sp-table-body>
  </sp-table>
`;

const SHELL_MARKUP = `
  <div class="chat-message chat-message--assistant chat-table-message">
    <p class="chat-table-message__title">Failed audits</p>
    ${TABLE_MARKUP}
    <p class="chat-table-message__total">
      <span class="chat-table-message__total-text">Total: 2</span>
    </p>
  </div>
`;

/**
 * A message that still looks like a table message but carries prose of its own:
 * its container forms no bands, so Copy/Export must stay on the table's own
 * chrome.
 */
const MIXED_MARKUP = `
  <div class="chat-message chat-message--assistant chat-table-message">
    <p class="chat-message__text">These pages failed the audit.</p>
    ${TABLE_MARKUP}
  </div>
`;

/** A table with no total line: its footer band anchors to the last row. */
const NO_TOTAL_MARKUP = `
  <div class="chat-message chat-message--assistant chat-table-message">
    ${TABLE_MARKUP}
  </div>
`;

/** Where the fixture's table sits in the viewport, and where its header row ends. */
const TABLE_TOP = 100;
const TABLE_BOTTOM = 300;
const HEADER_BOTTOM = 140;

let root: HTMLElement;
let mixed: HTMLElement;
let noTotal: HTMLElement;

function stubRect(element: Element, top: number, bottom: number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        x: 0,
        y: top,
        top,
        bottom,
        left: 0,
        right: 600,
        width: 600,
        height: bottom - top,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

beforeAll(() => {
  document.body.innerHTML =
    `<div id="root">${SHELL_MARKUP}</div>` +
    `<div id="mixed">${MIXED_MARKUP}</div>` +
    `<div id="no-total">${NO_TOTAL_MARKUP}</div>`;
  root = document.getElementById('root')!;
  mixed = document.getElementById('mixed')!;
  noTotal = document.getElementById('no-total')!;

  for (const scope of [root, mixed, noTotal]) {
    stubRect(scope.querySelector('.chat-table-message__table')!, TABLE_TOP, TABLE_BOTTOM);
    stubRect(scope.querySelector('.head')!, TABLE_TOP, HEADER_BOTTOM);
  }
  stubRect(root.querySelector('.chat-table-message__total')!, 312, 330);
});

function find<T extends Element>(scope: ParentNode, selector: string): T {
  const found = scope.querySelector<T>(selector);
  if (found === null) throw new Error(`fixture is missing ${selector}`);
  return found;
}

describe('tableGutterFrom', () => {
  it('resolves a header cell to the header row, its shell and the header band', () => {
    const hit = tableGutterFrom(find(root, '.head-cell'), 120);
    expect(hit?.anchor).toBe(find(root, '.head'));
    expect(hit?.anchor.tagName).toBe('SP-TABLE-HEAD');
    expect(hit?.shell).toBe(find(root, '.chat-table-message'));
    expect(hit?.band).toBe('header');
    expect(hit?.placement).toBe('top-end');
  });

  it('resolves a pointer on the header row itself', () => {
    expect(tableGutterFrom(find(root, '.head'), 120)?.anchor).toBe(find(root, '.head'));
  });

  it('resolves the total line (and its inner text) to the total element, in the footer band', () => {
    const total = find(root, '.chat-table-message__total');
    const hit = tableGutterFrom(total, 320);
    expect(hit?.anchor).toBe(total);
    expect(hit?.band).toBe('footer');
    expect(hit?.placement).toBe('top-end');
    expect(tableGutterFrom(find(root, '.chat-table-message__total-text'), 320)?.anchor).toBe(total);
  });

  it('puts the message surface above the table in the header band, anchored on the header row', () => {
    const header = find(root, '.head');
    expect(tableGutterFrom(find(root, '.chat-table-message'), TABLE_TOP - 10)).toEqual({
      anchor: header,
      shell: find(root, '.chat-table-message'),
      band: 'header',
      placement: 'top-end',
    });
    expect(tableGutterFrom(find(root, '.chat-table-message__title'), TABLE_TOP - 10)?.band).toBe(
      'header',
    );
  });

  it('puts the message surface below the table in the footer band, anchored on the total line', () => {
    const total = find(root, '.chat-table-message__total');
    const hit = tableGutterFrom(find(root, '.chat-table-message'), TABLE_BOTTOM + 1);
    expect(hit?.anchor).toBe(total);
    expect(hit?.band).toBe('footer');
    expect(hit?.placement).toBe('top-end');
  });

  it('hangs a total-less footer band below the table edge, not over its last row', () => {
    const hit = tableGutterFrom(find(noTotal, '.chat-table-message'), TABLE_BOTTOM + 1);
    expect(hit?.band).toBe('footer');
    expect(hit?.anchor).toBe(find(noTotal, '.chat-table-message__table'));
    expect(hit?.placement).toBe('bottom-end');
  });

  it('never resolves an ordinary data row', () => {
    expect(tableGutterFrom(find(root, '.body-cell'), 200)).toBeUndefined();
    expect(isTableDataRow(find(root, '.body-cell'))).toBe(true);
    expect(isTableDataRow(find(root, '.chat-table-message'))).toBe(false);
  });

  it('leaves the side padding alongside the rows inert', () => {
    expect(tableGutterFrom(find(root, '.chat-table-message'), 200)).toBeUndefined();
  });

  it('forms no bands when the message carries anything but the table', () => {
    const shell = find(mixed, '.chat-table-message');
    expect(tableGutterFrom(shell, TABLE_TOP - 10)).toBeUndefined();
    expect(tableGutterFrom(shell, TABLE_BOTTOM + 10)).toBeUndefined();
    expect(tableGutterFrom(find(mixed, '.chat-message__text'), TABLE_TOP - 10)).toBeUndefined();
    // ...while the table's own chrome still offers the actions.
    expect(tableGutterFrom(find(mixed, '.head'), 120)?.band).toBe('header');
  });

  it('is undefined for an unrelated element and null', () => {
    expect(tableGutterFrom(document.body, 120)).toBeUndefined();
    expect(tableGutterFrom(null, 120)).toBeUndefined();
    expect(isTableDataRow(null)).toBe(false);
  });
});

describe('tableHoverActions', () => {
  const TABLE: TableExportData = {
    columns: ['Path'],
    rows: [['/content/site/a']],
    total: 'Total: 1',
  };

  it('offers Copy then Export, each with a visible title and an icon', () => {
    const actions = tableHoverActions(TABLE, { onCopy: vi.fn(), onExport: vi.fn() });
    expect(actions.map((action) => action.id)).toEqual(['copy', 'export']);
    for (const action of actions) {
      expect(action.title.length).toBeGreaterThan(0);
      expect(action.icon.length).toBeGreaterThan(0);
    }
  });

  it('binds each action to the table it was built from', () => {
    const onCopy = vi.fn();
    const onExport = vi.fn();
    const actions = tableHoverActions(TABLE, { onCopy, onExport });
    actions[0]!.onActivate();
    actions[1]!.onActivate();
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(TABLE);
    expect(onExport).toHaveBeenCalledExactlyOnceWith(TABLE);
  });

  it('offers nothing when there is no table (no columns) to serialize', () => {
    expect(
      tableHoverActions(
        { columns: [], rows: [], total: 'Total: 0' },
        {
          onCopy: vi.fn(),
          onExport: vi.fn(),
        },
      ),
    ).toEqual([]);
  });
});
