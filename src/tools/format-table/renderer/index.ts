import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  type ToolTableMessage,
  describeGenericArgs,
  parameterRows,
} from '../../../shared';
import { normalizeFormatTable, type FormatTableMode } from '../formatTable';

/**
 * `format_table` does not render as a billet: its call paints an assistant
 * **message** - a table, optionally under a total line
 * (`presentation: 'message'`). The transcript reads the table from this
 * renderer via `readTableMessage`, groups consecutive calls into one run, and
 * hides the call line entirely. `describeCall` is still provided as the
 * contract's required member and safety net (agreed composition: a collapsed
 * `N rows` summary and a single `Rows: N` row), but the transcript never shows
 * it while `presentation` is `'message'`.
 */

function modeFromArgs(args: Readonly<Record<string, JsonValue>>): FormatTableMode {
  return args['mode'] === 'append' ? 'append' : 'new';
}

function readTableMessage(args: Readonly<Record<string, JsonValue>>): ToolTableMessage | undefined {
  const data = args['data'];
  if (data === undefined) return undefined;
  const totalLine = typeof args['totalLine'] === 'string' ? args['totalLine'] : undefined;
  const normalized = normalizeFormatTable(data, modeFromArgs(args), totalLine);
  if (normalized === undefined) return undefined;
  return {
    mode: normalized.mode,
    total: normalized.total,
    // The status line is not used for a message table - the total line replaces
    // it - so it is left empty rather than invented.
    table: {
      columns: normalized.columns,
      rows: normalized.rows,
      status: '',
      mayHaveMore: false,
    },
  };
}

function describeCall(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const data = args['data'];
  const normalized =
    data === undefined ? undefined : normalizeFormatTable(data, modeFromArgs(args));
  const rowCount = normalized?.rows.length;
  if (rowCount === undefined) return describeGenericArgs(args);
  return {
    summary: `${String(rowCount)} rows`,
    parameters: parameterRows([['Rows', String(rowCount)]]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: 'format_table',
  presentation: 'message',
  describeCall,
  readTableMessage,
};
