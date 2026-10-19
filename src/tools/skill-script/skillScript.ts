import { z } from 'zod';
import {
  type ToolExecutor,
  type JsonValue,
  type SkillScriptResult,
  type ToolDescriptor,
  type ToolHost,
  SKILL_NAME_PATTERN,
  SKILL_SCRIPT_TOOL_NAME,
  createToolError,
  err,
  newRequestId,
  ok,
} from '../../shared';

/**
 * The `skill_script` tool, self-contained: runs one of a skill's JavaScript
 * scripts (`scripts/*.js`, an ES module whose default export is a function) in
 * an isolated sandbox with no host capability. The model names the skill and the
 * script and passes a JSON input; the result is the function's JSON return
 * value plus whatever the script logged.
 */

export const SKILL_SCRIPT_ALLOWLIST_ENTRY = `custom:${SKILL_SCRIPT_TOOL_NAME}`;

export const skillScriptArgsSchema = z
  .object({
    skill: z.string().regex(SKILL_NAME_PATTERN, 'skill must be the name of a loaded skill'),
    script: z
      .string()
      .min(1)
      .max(300)
      .describe('A script path relative to the skill, e.g. "scripts/format.js".'),
    input: z
      .json()
      .optional()
      .describe('Any JSON value passed to the script as its argument; default {}.'),
  })
  .strict();

export const SKILL_SCRIPT_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: SKILL_SCRIPT_TOOL_NAME,
  description:
    "Runs one of a loaded skill's own JavaScript scripts (scripts/*.js) with a JSON input and " +
    'returns its JSON result and logs. A script is pure computation: it cannot read files, use ' +
    'the network or reach AEM. Run only the scripts a skill lists, with the input it describes.',
  parameters: z.toJSONSchema(skillScriptArgsSchema, { io: 'input' }),
};

function renderResult(script: string, result: SkillScriptResult): string {
  const lines = [`${script} returned:`, JSON.stringify(result.output, null, 2)];
  if (result.logs.length > 0) {
    lines.push('', 'Logged:', result.logs, ...(result.logsTruncated ? ['[logs truncated]'] : []));
  }
  return lines.join('\n');
}

export function createSkillScriptExecutor(host: ToolHost): ToolExecutor {
  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);
    if (context.signal?.aborted === true) {
      return err(createToolError('CANCELLED', 'The script run was cancelled', requestId));
    }
    const parsed = skillScriptArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid skill_script arguments';
      return err(createToolError('INVALID_ARGUMENT', message, requestId));
    }
    const { skill, script } = parsed.data;
    const input: JsonValue = parsed.data.input === undefined ? {} : parsed.data.input;
    const outcome = await host.skills.runScript({
      skill,
      script,
      input,
      signal: context.signal ?? new AbortController().signal,
    });
    if (!outcome.ok) {
      return err(createToolError(outcome.error.code, outcome.error.message, requestId));
    }
    const result = outcome.value;
    const payload: Record<string, JsonValue> = {
      ok: true,
      operation: SKILL_SCRIPT_TOOL_NAME,
      requestId,
      skill,
      script,
      input,
      output: result.output,
      logs: result.logs,
      logsTruncated: result.logsTruncated,
      durationMs: result.durationMs,
      textResultForLlm: renderResult(script, result),
      resultType: 'success',
    };
    return ok(payload);
  };
}
