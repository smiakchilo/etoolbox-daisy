/**
 * The pure serializers behind a `format_table` run's **Copy** and **Export**
 * gutter actions: the visible table turned into clipboard text/HTML and into a
 * CSV file.
 *
 * Kept DOM-free and clock-free (the caller passes `Date`) so the whole thing is
 * exercised with no jsdom and no custom elements - the renderer wiring that
 * decides *when* these run lives in `tableHover.ts` / `transcriptView.ts`, and
 * the actual pasting/saving is the host's job (`chatPane.ts` for the clipboard,
 * main for the file).
 *
 * The table the reader sees is: the column header row, the data rows, and (when
 * the run has a total line) the total line as one trailing row whose value sits
 * in the first column and whose remaining cells are empty. The leading `#` row
 * number is a display aid, not data, and is deliberately excluded. A blanked
 * repeated page path stays blank, exactly as displayed.
 */

/** The table a gutter action serializes - the columns, rows and total line a rendered run holds. */
export interface TableExportData {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** The rendered total line (e.g. `"Total: 3"`), or `undefined` when the run has none. */
  readonly total: string | undefined;
}

/**
 * Whether there is a table to serialize at all. A run with no columns (a
 * semantic search that has not matched anything yet, showing only its total
 * line) is not a table, so its gutter offers no Copy/Export.
 */
export function hasTableContent(data: TableExportData): boolean {
  return data.columns.length > 0;
}

/**
 * The table as a rectangular matrix: the header row first, then every data row
 * padded/trimmed to the header's width, then the total row (its text in the
 * first column) when the run has a total line.
 */
export function tableMatrix(data: TableExportData): readonly (readonly string[])[] {
  if (data.columns.length === 0) return [];
  const matrix: string[][] = [[...data.columns]];
  for (const row of data.rows) {
    matrix.push(data.columns.map((_column, index) => row[index] ?? ''));
  }
  const total = data.total?.trim();
  if (total !== undefined && total !== '') {
    matrix.push(data.columns.map((_column, index) => (index === 0 ? total : '')));
  }
  return matrix;
}

/** Cells on one clipboard row. `\r\n` is what Windows spreadsheet apps expect from a clipboard table. */
const TSV_ROW_SEPARATOR = '\r\n';

/**
 * A TSV cell cannot carry a tab or a line break without breaking the grid, so
 * any run of them collapses to a single space. Nothing else is touched - the
 * cell's own leading/trailing spaces are preserved.
 */
function tsvCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

/** The table as tab-separated text - the `text/plain` clipboard flavour. */
export function tableToTsv(data: TableExportData): string {
  return tableMatrix(data)
    .map((row) => row.map(tsvCell).join('\t'))
    .join(TSV_ROW_SEPARATOR);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The table as an HTML `<table>` - the `text/html` clipboard flavour. Excel and
 * Google Sheets prefer this over the plain text and keep the grid (and the
 * header row) intact, including a cell that legitimately contains a tab or a
 * newline.
 */
export function tableToClipboardHtml(data: TableExportData): string {
  const matrix = tableMatrix(data);
  const [header, ...body] = matrix;
  if (header === undefined) return '<table></table>';
  const head = `<thead><tr>${header
    .map((value) => `<th>${escapeHtml(value)}</th>`)
    .join('')}</tr></thead>`;
  const rows = body
    .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`)
    .join('');
  return `<table>${head}<tbody>${rows}</tbody></table>`;
}

/** A cell is quoted only when it would otherwise break the row: a separator, a quote, or a line break inside it. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The byte-order mark Excel needs to read a UTF-8 CSV's non-ASCII text correctly. */
const UTF8_BOM = '\uFEFF';

/**
 * The table as CSV text: comma-delimited, CRLF line endings, UTF-8 with a
 * leading BOM. No trailing newline.
 */
export function tableToCsv(data: TableExportData): string {
  const body = tableMatrix(data)
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
  return `${UTF8_BOM}${body}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** The suggested save-dialog name: `table-YYYYMMDD-HHmmss.csv` in local time. */
export function suggestTableExportFileName(now: Date): string {
  const stamp =
    `${String(now.getFullYear())}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `table-${stamp}.csv`;
}
