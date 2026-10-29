import {
  type BilletSpec,
  type BilletValueSpec,
  type JsonValue,
  TOOL_REPORT_PAYLOAD_KEY,
  type ToolCallDetails,
  type ToolRendererModule,
  type ToolReportMessage,
  asRecord,
  parameterRows,
} from '../../../shared';
import type { AddonPins } from '../../../shared/addons/pins';

/**
 * The transcript's renderer for the tools an add-on contributes, built from the
 * pins.
 *
 * A contributed tool is **data**: the build derived its billet (the collapsed
 * summary and the expansion rows) and its presentation from the add-on's own
 * manifest, so the application can paint a call it has never seen before -
 * including one replayed from a journal whose add-on is not installed. A
 * `presentation: 'report'` result carries the report the tool built under
 * `data.report` (`toolRenderer.ts`), which this module reads generically.
 *
 * There is no add-on-specific code here, and none to add: a new add-on's tool
 * renders itself from its own declaration.
 */

/** One `JsonValue` as billet text, honouring a `join` for an array; `undefined` when empty. */
function readValue(
  args: Readonly<Record<string, JsonValue>>,
  spec: BilletValueSpec,
): string | undefined {
  const raw = args[spec.path];
  let text: string | undefined;
  if (typeof raw === 'string') {
    text = raw === '' ? undefined : raw;
  } else if (typeof raw === 'number' || typeof raw === 'boolean') {
    text = String(raw);
  } else if (Array.isArray(raw)) {
    const parts = raw
      .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
      .filter((entry): entry is string => typeof entry === 'string' && entry !== '');
    text = parts.length === 0 ? undefined : parts.join(spec.join ?? ', ');
  }
  if (text !== undefined) return text;
  return spec.fallback;
}

/** The `getDetails()` of one contributed call, from the pins' billet spec. */
export function describeContributedCall(
  billet: BilletSpec | undefined,
  args: Readonly<Record<string, JsonValue>>,
): ToolCallDetails {
  if (billet === undefined) {
    return { summary: undefined, parameters: parameterRows([['Arguments', describeArgs(args)]]) };
  }
  return {
    summary: billet.summary === undefined ? undefined : readValue(args, billet.summary),
    parameters: parameterRows(
      billet.rows.map((row) => [row.label, readValue(args, row.value)] as const),
    ),
  };
}

function describeArgs(args: Readonly<Record<string, JsonValue>>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '(none)';
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
}

/**
 * Reads the report a `presentation: 'report'` call built. The shape is trusted
 * only as far as it is checked here: anything else paints nothing rather than
 * guessing.
 */
export function readContributedReport(data: JsonValue | undefined): ToolReportMessage | undefined {
  const record = asRecord(data);
  if (record === undefined) return undefined;
  const report = asRecord(record[TOOL_REPORT_PAYLOAD_KEY]);
  if (report === undefined) return undefined;
  const sections = report['sections'];
  if (!Array.isArray(sections)) return undefined;
  const summary = report['summary'];
  return {
    summary:
      summary === undefined ? undefined : (summary as unknown as ToolReportMessage['summary']),
    sections: sections as unknown as ToolReportMessage['sections'],
  };
}

/** One renderer per contributed tool the pins list. */
export function contributeToolRenderers(pins: AddonPins): readonly ToolRendererModule[] {
  return Object.keys(pins)
    .sort()
    .flatMap((id) =>
      (pins[id]?.contributions.tools ?? []).map((tool) => ({
        toolName: tool.name,
        ...(tool.presentation === undefined ? {} : { presentation: tool.presentation }),
        describeCall: (args: Readonly<Record<string, JsonValue>>) =>
          describeContributedCall(tool.billet, args),
        ...(tool.presentation === 'report'
          ? {
              readReportMessage: (_args: Readonly<Record<string, JsonValue>>, data?: JsonValue) =>
                readContributedReport(data),
            }
          : {}),
      })),
    );
}
