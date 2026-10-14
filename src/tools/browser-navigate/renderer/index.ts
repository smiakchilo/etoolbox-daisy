import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  describeGenericArgs,
  parameterRows,
} from '../../../shared';

import {
  type BrowserNavigateMode,
  type BrowserNavigatePlace,
  BROWSER_NAVIGATE_MODE_LABELS,
  BROWSER_NAVIGATE_MODES,
  BROWSER_NAVIGATE_PLACE_LABELS,
  BROWSER_NAVIGATE_PLACES,
} from '../browserNavigate';

/**
 * `browser_navigate`'s deliberate transcript composition (AGENTS.md section 5):
 * the collapsed line names the action and its target (`Open HPE DEV: /content/…`,
 * or the place's name for a standard place), and expanding reveals the full URL
 * the application opened, the mode or place, and the outcome. The URL and the
 * outcome are read from the succeeded payload, so both rows appear only once the
 * call has completed; the mode and place are read from the arguments, so they
 * show while running.
 */
function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, JsonValue>>;
}

/** The friendly mode name for the Mode row, or `undefined` when the argument is not a known mode. */
function modeLabel(value: JsonValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!(BROWSER_NAVIGATE_MODES as readonly string[]).includes(value)) return undefined;
  return BROWSER_NAVIGATE_MODE_LABELS[value as BrowserNavigateMode];
}

/** The friendly place name for the Place row, or `undefined` when the argument is not a known place. */
function placeLabel(value: JsonValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!(BROWSER_NAVIGATE_PLACES as readonly string[]).includes(value)) return undefined;
  return BROWSER_NAVIGATE_PLACE_LABELS[value as BrowserNavigatePlace];
}

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const path = typeof args['path'] === 'string' ? args['path'] : '';
  const argHost = typeof args['host'] === 'string' ? args['host'] : undefined;
  const mode = modeLabel(args['mode']);
  const place = placeLabel(args['place']);

  const record = asRecord(data);
  const succeeded = record?.['operation'] === 'browser_navigate';
  const hostLabel =
    succeeded && typeof record['hostLabel'] === 'string' ? record['hostLabel'] : argHost;
  const url = succeeded && typeof record['url'] === 'string' ? record['url'] : undefined;
  const switched = succeeded && record['switched'] === true;

  if (!succeeded && path === '' && place === undefined && argHost === undefined) {
    return describeGenericArgs(args);
  }

  const target = path.length > 0 ? path : place;
  const summary =
    target === undefined
      ? undefined
      : hostLabel !== undefined
        ? `Open ${hostLabel}: ${target}`
        : `Open ${target}`;

  return {
    summary,
    parameters: parameterRows([
      ['URL', url],
      ['Mode', mode],
      ['Place', place],
      ['Result', succeeded ? (switched ? 'Opened (switched hosts)' : 'Opened') : undefined],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: 'browser_navigate',
  describeCall,
};
