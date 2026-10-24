import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  asCount,
  asRecord,
  asStringArray,
  asText,
  parameterRows,
} from '../../../shared';

function describeScores(value: JsonValue | undefined): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((entry: JsonValue) => {
    const record = asRecord(entry);
    const category = asText(record?.['category']);
    if (category === undefined) return [];
    const score = asCount(record?.['score']);
    return [`${category} ${score === undefined ? 'n/a' : String(score)}`];
  });
  return parts.length === 0 ? undefined : parts.join(', ');
}

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const url = asText(args['url']);
  const categories = asStringArray(args['categories'])?.join(', ');
  const result = asRecord(data);

  return {
    summary: url ?? asText(result?.['url']) ?? 'Current page',
    parameters: parameterRows([
      ['URL', url ?? asText(result?.['url']) ?? '(current page)'],
      ['Categories', categories === '' ? undefined : categories],
      ['Form factor', asText(args['formFactor']) ?? asText(result?.['formFactor'])],
      ['Scores', describeScores(result?.['scores'])],
      ['Failed audits', asCount(result?.['failureCount'])],
    ]),
  };
}

export const renderer: ToolRendererModule = { toolName: 'page_audit', describeCall };
