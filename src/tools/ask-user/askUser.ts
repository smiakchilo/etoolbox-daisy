import { z } from 'zod';
import {
  type AemToolExecutor,
  type JsonValue,
  type RequestId,
  type Result,
  type ToolDescriptor,
  type ToolError,
  type ToolHost,
  type UserInputAnswer,
  type UserInputRequest,
  createToolError,
  err,
  newRequestId,
  ok,
  requestIdSchema,
  userInputOptionSchema,
  userInputOptionsSchema,
  userInputQuestionSchema,
} from '../../shared';

/**
 * The `ask_user` tool, self-contained.
 *
 * Lets the model put a choice to the user: a question with a set of options
 * (radios, or checkboxes when `multiple`), an optional escape hatch to type a
 * free-form answer (`freeInput`), or free-form only. This is the interactive
 * half of the assistant - the answer comes back as this call's result, so the
 * model receives it in-context and continues the same turn.
 *
 * Unlike the AEM read tools it does **not** go through `createToolExecutor`:
 * that builder always binds an AEM envelope to a live server (`currentContext`
 * throws with no server selected), and a question about anything at all must be
 * askable with no AEM instance open. It is therefore hand-rolled, but still
 * validates its arguments and returns the same `Result<JsonValue, ToolError>`
 * shape every executor does.
 */

export const ASK_USER_TOOL_NAME = 'ask_user';
export const ASK_USER_ALLOWLIST_ENTRY = 'custom:ask_user';

export const askUserArgsSchema = z
  .object({
    question: userInputQuestionSchema,
    /** The selectable variants. Absent means free-input only. */
    options: userInputOptionsSchema.optional(),
    /** Allow several selections (checkboxes) rather than one (radios). */
    multiple: z.boolean().default(false),
    /** Offer a "type your own answer" escape hatch. */
    freeInput: z.boolean().default(false),
  })
  .strict();

export type AskUserArgs = z.infer<typeof askUserArgsSchema>;

export const ASK_USER_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: ASK_USER_TOOL_NAME,
  description:
    'Ask the user to choose, and wait for their answer. Provide a `question` and a list of ' +
    '`options` to choose from; set `multiple: true` to let them pick several; set ' +
    '`freeInput: true` to also offer a typed answer. Use this when the user must make a ' +
    'specific choice to continue, instead of guessing. At least one of `options`/`freeInput` ' +
    'is required. The chosen option(s), or the typed answer, come back as this call\u2019s result.',
  parameters: z.toJSONSchema(askUserArgsSchema, { io: 'input' }),
};

export const askUserSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal(ASK_USER_TOOL_NAME),
    requestId: requestIdSchema,
    question: userInputQuestionSchema,
    selections: z.array(userInputOptionSchema),
    freeform: z.string().nullable(),
  })
  .strict();

export type AskUserSuccess = z.infer<typeof askUserSuccessSchema>;

/** The model-facing rendering of the user's answer. */
export function renderAskUserSuccess(result: AskUserSuccess): string {
  if (result.freeform !== null && result.freeform.length > 0) {
    return `The user answered: ${result.freeform}`;
  }
  if (result.selections.length === 1) {
    return `The user chose: ${result.selections[0] ?? ''}`;
  }
  return `The user chose: ${result.selections.join(', ')}`;
}

/**
 * The structured success plus the SDK's render fields, so `ask_user`'s own
 * renderer can paint the question/answer from the result payload. Mirrors
 * `aem-environment-facts`'s `toSuccessPayload`.
 */
function toSuccessPayload(result: AskUserSuccess): JsonValue {
  return {
    ok: true,
    operation: ASK_USER_TOOL_NAME,
    requestId: result.requestId,
    question: result.question,
    selections: [...result.selections],
    freeform: result.freeform,
    textResultForLlm: renderAskUserSuccess(result),
    resultType: 'success',
  };
}

function invalidArgument(message: string, requestId: RequestId): Result<JsonValue, ToolError> {
  return err(createToolError('INVALID_ARGUMENT', message, requestId));
}

/**
 * Builds the executor. It validates the model's arguments, normalizes the
 * "false by default" options, and delegates to `host.requestUserInput` - the
 * application resolves that from the live turn, or rejects it if the turn is
 * aborted first (which surfaces here as a `CANCELLED` failure, never a crash).
 */
export function createAskUserExecutor(host: ToolHost): AemToolExecutor {
  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);

    const parsed = askUserArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid ask_user arguments';
      return invalidArgument(message, requestId);
    }
    const args = parsed.data;
    if (args.options === undefined && !args.freeInput) {
      return invalidArgument(
        'ask_user needs `options`, `freeInput: true`, or both - there is nothing for the user to answer otherwise',
        requestId,
      );
    }

    if (context.signal?.aborted === true) {
      return err(
        createToolError('CANCELLED', 'The request was cancelled before it was asked', requestId),
      );
    }

    const request: UserInputRequest =
      args.options === undefined
        ? { question: args.question, multiple: args.multiple, freeInput: args.freeInput }
        : {
            question: args.question,
            options: args.options,
            multiple: args.multiple,
            freeInput: args.freeInput,
          };

    let answer: UserInputAnswer;
    try {
      answer = await host.requestUserInput(request);
    } catch (caught) {
      // The one expected failure is cancellation (the turn was aborted or torn
      // down while the question was outstanding); anything else is reported the
      // same way rather than thrown, so the SDK sees a structured result.
      const message =
        caught instanceof Error && caught.message.length > 0
          ? caught.message.slice(0, 500)
          : 'The question was not answered';
      return err(createToolError('CANCELLED', message, requestId));
    }

    return ok(
      toSuccessPayload({
        ok: true,
        operation: ASK_USER_TOOL_NAME,
        requestId,
        question: args.question,
        selections: [...answer.selections],
        freeform: answer.freeform,
      }),
    );
  };
}
