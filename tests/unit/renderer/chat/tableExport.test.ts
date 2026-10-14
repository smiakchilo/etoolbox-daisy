import { describe, expect, it } from 'vitest';
import {
  hasTableContent,
  suggestTableExportFileName,
  tableToClipboardHtml,
  tableToCsv,
  tableToTsv,
  tableMatrix,
  type TableExportData,
} from '../../../../src/renderer/src/chat/tableExport';

/**
 * The pure serializers behind a `format_table` run's Copy/Export gutter
 * actions. No DOM, no clock - the caller passes the `Date`.
 */

const TABLE: TableExportData = {
  columns: ['Path', 'Property'],
  rows: [
    ['/content/site/a', 'jcr:title'],
    ['/content/site/b', 'jcr:description'],
  ],
  total: 'Total: 2',
};

describe('tableMatrix', () => {
  it('is the header row, the data rows, then the total row', () => {
    expect(tableMatrix(TABLE)).toEqual([
      ['Path', 'Property'],
      ['/content/site/a', 'jcr:title'],
      ['/content/site/b', 'jcr:description'],
      ['Total: 2', ''],
    ]);
  });

  it('pads a short row to the header width and drops extra cells', () => {
    const data: TableExportData = {
      columns: ['A', 'B'],
      rows: [['one'], ['one', 'two', 'three']],
      total: undefined,
    };
    expect(tableMatrix(data)).toEqual([
      ['A', 'B'],
      ['one', ''],
      ['one', 'two'],
    ]);
  });

  it('omits the total row when there is no total or it is blank', () => {
    expect(tableMatrix({ columns: ['A'], rows: [], total: undefined })).toEqual([['A']]);
    expect(tableMatrix({ columns: ['A'], rows: [], total: '   ' })).toEqual([['A']]);
  });

  it('is empty when there are no columns', () => {
    expect(tableMatrix({ columns: [], rows: [], total: 'Total: 0' })).toEqual([]);
  });
});

describe('hasTableContent', () => {
  it('is false only when there is no column to serialize', () => {
    expect(hasTableContent({ columns: [], rows: [], total: 'Total: 0' })).toBe(false);
    expect(hasTableContent({ columns: ['A'], rows: [], total: undefined })).toBe(true);
  });
});

describe('tableToTsv', () => {
  it('joins cells with tabs and rows with CRLF', () => {
    expect(tableToTsv(TABLE)).toBe(
      'Path\tProperty\r\n' +
        '/content/site/a\tjcr:title\r\n' +
        '/content/site/b\tjcr:description\r\n' +
        'Total: 2\t',
    );
  });

  it('collapses an embedded tab or newline so the grid cannot break', () => {
    const data: TableExportData = {
      columns: ['Note'],
      rows: [['line one\nline two'], ['a\tb']],
      total: undefined,
    };
    expect(tableToTsv(data)).toBe('Note\r\nline one line two\r\na b');
  });
});

describe('tableToClipboardHtml', () => {
  it('renders a <th> header row and <td> body rows, total included', () => {
    expect(tableToClipboardHtml(TABLE)).toBe(
      '<table><thead><tr><th>Path</th><th>Property</th></tr></thead>' +
        '<tbody>' +
        '<tr><td>/content/site/a</td><td>jcr:title</td></tr>' +
        '<tr><td>/content/site/b</td><td>jcr:description</td></tr>' +
        '<tr><td>Total: 2</td><td></td></tr>' +
        '</tbody></table>',
    );
  });

  it('escapes markup in a cell rather than emitting it', () => {
    const data: TableExportData = {
      columns: ['A & B'],
      rows: [['<script>"x"</script>']],
      total: undefined,
    };
    expect(tableToClipboardHtml(data)).toBe(
      '<table><thead><tr><th>A &amp; B</th></tr></thead>' +
        '<tbody><tr><td>&lt;script&gt;&quot;x&quot;&lt;/script&gt;</td></tr></tbody></table>',
    );
  });
});

describe('tableToCsv', () => {
  it('starts with a UTF-8 BOM and uses comma/CRLF', () => {
    expect(tableToCsv(TABLE)).toBe(
      '\uFEFFPath,Property\r\n' +
        '/content/site/a,jcr:title\r\n' +
        '/content/site/b,jcr:description\r\n' +
        'Total: 2,',
    );
  });

  it('quotes a cell with a separator, a quote or a line break, doubling the quote', () => {
    const data: TableExportData = {
      columns: ['A'],
      rows: [['a,b'], ['say "hi"'], ['two\nlines']],
      total: undefined,
    };
    expect(tableToCsv(data)).toBe('\uFEFFA\r\n"a,b"\r\n"say ""hi"""\r\n"two\nlines"');
  });
});

describe('suggestTableExportFileName', () => {
  it('stamps the local date and time', () => {
    expect(suggestTableExportFileName(new Date(2026, 9, 14, 9, 5, 3))).toBe(
      'table-20261014-090503.csv',
    );
  });
});
