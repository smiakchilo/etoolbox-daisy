import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  MEMO_REFLECTION_TOOL_NAME,
  parameterRows,
} from '../../../shared';

/**
 * The reflection marker's billet: the application asked the model to write
 * down what went wrong in the previous request. Summary "Reflecting on the last
 * request", one `Signals` row listing what prompted it.
 */
function describeCall(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const raw = args['signals'];
  const signals = Array.isArray(raw)
    ? raw.filter((signal): signal is string => typeof signal === 'string')
    : [];
  return {
    summary: 'Reflecting on the last request',
    parameters: parameterRows([['Signals', signals.length > 0 ? signals.join('; ') : undefined]]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: MEMO_REFLECTION_TOOL_NAME,
  describeCall,
};
