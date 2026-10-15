import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { tableGutterFrom, tableHoverActions } from '../../../../src/renderer/src/chat/tableHover';
import type { TableExportData } from '../../../../src/renderer/src/chat/tableExport';

/**
 * The `format_table` gutter: which element counts as the actionable chrome
 * (the header row or the total line, never a data row) and what its hover
 * popover offers.
 *
 * The real popover needs Spectrum's overlay, which never loads under jsdom;
 * this covers the two things the popover depends on - the region test and the
 * action composition - so the only part left to the E2E is the overlay itself.
 */

const dom = new JSDOM();
globalThis.document = dom.window.document;

const SHELL_MARKUP = `
  <div class="chat-message chat-message--assistant chat-table-message">
    <sp-table class="chat-table-message__table">
      <sp-table-head class="head">
        <sp-table-head-cell class="head-cell">#</sp-table-head-cell>
        <sp-table-head-cell>Path</sp-table-head-cell>
      </sp-table-head>
      <sp-table-body>
        <sp-table-row><sp-table-cell class="body-cell">1</sp-table-cell></sp-table-row>
      </sp-table-body>
    </sp-table>
    <p class="chat-table-message__total">
      <span class="chat-table-message__total-text">Total: 2</span>
    </p>
  </div>
`;

let root: HTMLElement;

beforeAll(() => {
  document.body.innerHTML = `<div id="root">${SHELL_MARKUP}</div>`;
  root = document.getElementById('root')!;
});

function find<T extends Element>(selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`fixture is missing ${selector}`);
  return found;
}

describe('tableGutterFrom', () => {
  it('resolves a header cell to the header row, and its shell', () => {
    const hit = tableGutterFrom(find('.head-cell'));
    expect(hit?.anchor).toBe(find('.head'));
    expect(hit?.anchor.tagName).toBe('SP-TABLE-HEAD');
    expect(hit?.shell).toBe(find('.chat-table-message'));
  });

  it('resolves a pointer on the header row itself', () => {
    expect(tableGutterFrom(find('.head'))?.anchor).toBe(find('.head'));
  });

  it('resolves the total line (and its inner text) to the total element', () => {
    const total = find('.chat-table-message__total');
    expect(tableGutterFrom(total)?.anchor).toBe(total);
    expect(tableGutterFrom(find('.chat-table-message__total-text'))?.anchor).toBe(total);
  });

  it('never resolves an ordinary data row', () => {
    expect(tableGutterFrom(find('.body-cell'))).toBeUndefined();
  });

  it("is undefined for the shell's own area, an unrelated element and null", () => {
    expect(tableGutterFrom(find('.chat-table-message'))).toBeUndefined();
    expect(tableGutterFrom(document.body)).toBeUndefined();
    expect(tableGutterFrom(null)).toBeUndefined();
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
