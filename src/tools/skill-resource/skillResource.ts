import { z } from 'zod';
import {
  type AemToolExecutor,
  type JsonValue,
  type SkillResource,
  type ToolDescriptor,
  type ToolHost,
  SKILL_NAME_PATTERN,
  SKILL_RESOURCE_TOOL_NAME,
  createToolError,
  err,
  newRequestId,
  ok,
} from '../../shared';

/**
 * The `skill_resource` tool, self-contained: reads one of a skill's own files
 * (a reference, a script's source) or lists its folder. The model names a skill
 * and a path relative to it; the application resolves both and confines the
 * read to the skill's folder, so no filesystem path is ever involved.
 */

export const SKILL_RESOURCE_ALLOWLIST_ENTRY = `custom:${SKILL_RESOURCE_TOOL_NAME}`;

export const skillResourceArgsSchema = z
  .object({
    skill: z.string().regex(SKILL_NAME_PATTERN, 'skill must be the name of a loaded skill'),
    path: z
      .string()
      .min(1)
      .max(300)
      .describe('A path relative to the skill, e.g. "references/rules.md". "." lists its files.'),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('The first line to return, to continue a file the previous call cut off.'),
  })
  .strict();

export const SKILL_RESOURCE_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: SKILL_RESOURCE_TOOL_NAME,
  description:
    'Reads one of a loaded skill\'s own files, or lists them with path ".". Use it for the ' +
    "files a skill names (references, templates, a script's source). A long file comes back in " +
    'parts: the result says which lines it holds and the startLine to continue with.',
  parameters: z.toJSONSchema(skillResourceArgsSchema, { io: 'input' }),
};

function renderResource(skill: string, resource: SkillResource): string {
  if (resource.kind === 'directory') {
    const rows = resource.entries.map((entry) =>
      entry.size === undefined ? entry.path : `${entry.path} (${entry.size} B)`,
    );
    return [`Files in ${skill}/${resource.path}:`, ...(rows.length > 0 ? rows : ['(none)'])].join(
      '\n',
    );
  }
  const range =
    resource.endLine === 0
      ? `${resource.path} is empty`
      : `${resource.path}: lines ${resource.startLine}-${resource.endLine} of ${resource.totalLines}`;
  const next =
    resource.nextStartLine === undefined
      ? ''
      : `\n[Cut off here. Continue with startLine=${resource.nextStartLine}.]`;
  return `${range}\n${resource.text}${next}`;
}

function toPayload(requestId: string, skill: string, resource: SkillResource): JsonValue {
  const base: Record<string, JsonValue> = {
    ok: true,
    operation: SKILL_RESOURCE_TOOL_NAME,
    requestId,
    skill,
    path: resource.path,
    kind: resource.kind,
    textResultForLlm: renderResource(skill, resource),
    resultType: 'success',
  };
  if (resource.kind === 'file') {
    base['size'] = resource.size;
    base['startLine'] = resource.startLine;
    base['endLine'] = resource.endLine;
    base['totalLines'] = resource.totalLines;
    base['truncated'] = resource.nextStartLine !== undefined;
  } else {
    base['entryCount'] = resource.entries.length;
  }
  return base;
}

export function createSkillResourceExecutor(host: ToolHost): AemToolExecutor {
  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);
    if (context.signal?.aborted === true) {
      return err(createToolError('CANCELLED', 'The skill file read was cancelled', requestId));
    }
    const parsed = skillResourceArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid skill_resource arguments';
      return err(createToolError('INVALID_ARGUMENT', message, requestId));
    }
    const { skill, path, startLine } = parsed.data;
    const outcome = await host.skills.readResource({
      skill,
      path,
      ...(startLine !== undefined ? { startLine } : {}),
    });
    if (!outcome.ok) {
      return err(createToolError(outcome.error.code, outcome.error.message, requestId));
    }
    return ok(toPayload(requestId, skill, outcome.value));
  };
}
