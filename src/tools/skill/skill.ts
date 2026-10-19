import { z } from 'zod';
import {
  type ToolExecutor,
  type JsonValue,
  type ToolDescriptor,
  type ToolHost,
  SKILL_NAME_PATTERN,
  SKILL_TOOL_NAME,
  createToolError,
  err,
  isRunnableScriptPath,
  newRequestId,
  ok,
  renderSkillActivation,
} from '../../shared';

/**
 * The `skill` tool, self-contained: loads a skill's instructions into the
 * conversation. It replaces the agent runtimes' own `skill` tool, so a skill is
 * loaded the same way for every agent, and the result tells the model which of
 * the skill's own files it can reach with `skill_resource` / `skill_script`.
 *
 * Hand-rolled: it performs no AEM read and needs no active server.
 */

export const SKILL_TOOL_ALLOWLIST_ENTRY = `custom:${SKILL_TOOL_NAME}`;

export const skillArgsSchema = z
  .object({
    name: z
      .string()
      .regex(SKILL_NAME_PATTERN, 'name must be the name of one of the available skills')
      .describe('The name of the skill to load, exactly as listed in the available skills.'),
  })
  .strict();

export const SKILL_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: SKILL_TOOL_NAME,
  description:
    'Loads one of the available skills: its full instructions, plus the list of its own files ' +
    '(references and scripts) that skill_resource and skill_script can reach. Call it before ' +
    'acting on a request that a skill in the catalogue covers.',
  parameters: z.toJSONSchema(skillArgsSchema, { io: 'input' }),
};

export function createSkillExecutor(host: ToolHost): ToolExecutor {
  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);
    if (context.signal?.aborted === true) {
      return Promise.resolve(
        err(createToolError('CANCELLED', 'The skill load was cancelled', requestId)),
      );
    }
    const parsed = skillArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid skill arguments';
      return Promise.resolve(err(createToolError('INVALID_ARGUMENT', message, requestId)));
    }
    const { name } = parsed.data;
    const summary = host.skills.list().find((entry) => entry.name === name);
    if (summary?.disableModelInvocation === true) {
      return Promise.resolve(
        err(
          createToolError(
            'ACCESS_DENIED',
            `The "${name}" skill can only be started by the user`,
            requestId,
          ),
        ),
      );
    }
    const activation = host.skills.activate(name);
    if (!activation.ok) {
      return Promise.resolve(
        err(createToolError(activation.error.code, activation.error.message, requestId)),
      );
    }
    const memos = (await host.memos?.skillMemos(activation.value.name)) ?? '';
    const { files } = activation.value;
    const payload: Record<string, JsonValue> = {
      ok: true,
      operation: SKILL_TOOL_NAME,
      requestId,
      skill: activation.value.name,
      source: summary?.source ?? 'bundled',
      fileCount: files.length,
      scriptCount: files.filter((file) => isRunnableScriptPath(file.path)).length,
      textResultForLlm: renderSkillActivation(activation.value, memos),
      resultType: 'success',
    };
    return ok(payload);
  };
}
