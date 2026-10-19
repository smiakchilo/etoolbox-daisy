import { z } from 'zod';
import {
  type ToolExecutor,
  type JsonValue,
  type ToolDescriptor,
  type ToolHost,
  MEMO_TEXT_MAX_BYTES,
  MEMO_TITLE_MAX_LENGTH,
  MEMO_TOOL_NAME,
  SKILL_NAME_PATTERN,
  createToolError,
  err,
  memoTriggerSchema,
  newRequestId,
  ok,
} from '../../shared';

/**
 * The `memo` tool, self-contained: writes one short lesson ("memo") the
 * application feeds back into later conversations. The model supplies only the
 * title, the text, why it is writing it and, optionally, the skill it belongs
 * to; the application decides the folder, the file name and the stamp
 * (`ToolHost.memos`, main's memo store), so no path ever comes from the model.
 *
 * Hand-rolled: it performs no AEM read and needs no active server.
 */

export const MEMO_TOOL_ALLOWLIST_ENTRY = `custom:${MEMO_TOOL_NAME}`;

export const memoArgsSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(MEMO_TITLE_MAX_LENGTH)
      .describe('A short headline for the lesson, a few words.'),
    text: z
      .string()
      .min(1)
      .max(MEMO_TEXT_MAX_BYTES)
      .describe(
        'The lesson itself: one or a few short imperative sentences that will help a later ' +
          'conversation. Not a restatement of what happened.',
      ),
    skill: z
      .string()
      .regex(SKILL_NAME_PATTERN, 'skill must be the name of a skill loaded in this conversation')
      .optional()
      .describe(
        'The skill this lesson is about, only when that skill was loaded in this conversation ' +
          'and the lesson is about following it. Omit for a general lesson.',
      ),
    trigger: memoTriggerSchema.describe(
      'Why the memo is written: "request" (the user asked you to remember), "correction" ' +
        '(the user corrected you), "error" (a failure taught something), or "loop" (you ' +
        'repeated yourself without progress).',
    ),
  })
  .strict();

export const MEMO_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: MEMO_TOOL_NAME,
  description:
    'Writes down one short, reusable lesson (a memo) that later conversations will be given. ' +
    'Use it when the user asks you to remember or keep something in mind, when the user ' +
    'corrects you, or when you are asked to reflect on a failure.',
  parameters: z.toJSONSchema(memoArgsSchema, { io: 'input' }),
};

export function createMemoExecutor(host: ToolHost): ToolExecutor {
  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);
    if (context.signal?.aborted === true) {
      return err(createToolError('CANCELLED', 'The memo was cancelled', requestId));
    }
    const parsed = memoArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid memo arguments';
      return err(createToolError('INVALID_ARGUMENT', message, requestId));
    }
    if (host.memos === undefined) {
      return err(createToolError('ACCESS_DENIED', 'Memos are not available', requestId));
    }
    const { title, text, skill, trigger } = parsed.data;
    const outcome = await host.memos.write({
      title,
      text,
      trigger,
      ...(skill === undefined ? {} : { skill }),
    });
    if (!outcome.ok) {
      return err(createToolError(outcome.error.code, outcome.error.message, requestId));
    }
    const record = outcome.value;
    const scope = record.skill === undefined ? 'a general memo' : `a memo for ${record.skill}`;
    const payload: Record<string, JsonValue> = {
      ok: true,
      operation: MEMO_TOOL_NAME,
      requestId,
      id: record.id,
      title: record.title,
      fileName: record.fileName,
      trigger,
      ...(record.skill === undefined ? {} : { skill: record.skill }),
      textResultForLlm: `Saved ${scope}: "${record.title}". Do not mention it further unless asked.`,
      resultType: 'success',
    };
    return ok(payload);
  };
}
