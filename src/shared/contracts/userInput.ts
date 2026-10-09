import { z } from 'zod';

/**
 * The ask-user (choose-from-options) contract: the question the agent puts to
 * the user, and the answer the user gives.
 *
 * Deliberately its own module rather than a member of `agentEvents.ts`: the
 * same request/answer shape is carried by three different boundaries - the
 * `user.input.requested` `AgentEvent`, `AgentService.requestUserInput`/
 * `respondToInput`, and `ToolHost.requestUserInput` - and each of them should
 * import the identical field schemas rather than repeat (and drift from) them.
 *
 * The answer is structured rather than a single string so "several options"
 * (checkbox groups) and "typed text" (the free-input variant) are not squeezed
 * through one lossy representation. At least one of `selections`/`freeform`
 * being non-empty is an application invariant enforced where the answer is
 * built, not by the schema: a schema cannot express "one of these, non-empty"
 * without also encoding the freeform/selection precedence, which is a UI rule.
 */

/** Bounded like the composer's own prompt field; a question is a sentence or two, not an essay. */
export const USER_INPUT_QUESTION_MAX_LENGTH = 2000;
/** One option label. */
export const USER_INPUT_OPTION_MAX_LENGTH = 200;
/** More than this is not a question, it is a menu. */
export const USER_INPUT_MAX_OPTIONS = 50;
/** A typed free-input answer. */
export const USER_INPUT_FREEFORM_MAX_LENGTH = 50_000;
/**
 * The most one-click actions a question may carry. Actions are buttons shown in
 * the composer (the text field is hidden), so keep them few - an action row is
 * not a menu. The search skills use a single action ("Load more"); the
 * composer's own Stop is the cancel affordance, so an action row may hold as
 * few as one.
 */
export const USER_INPUT_MAX_ACTIONS = 4;

export const userInputQuestionSchema = z.string().min(1).max(USER_INPUT_QUESTION_MAX_LENGTH);

export const userInputOptionSchema = z.string().min(1).max(USER_INPUT_OPTION_MAX_LENGTH);

export const userInputOptionsSchema = z
  .array(userInputOptionSchema)
  .min(1)
  .max(USER_INPUT_MAX_OPTIONS);

/**
 * One-click actions. Like `options`, these are labels; unlike `options`, the
 * composer renders each as a button that answers the question the instant it is
 * clicked, so a single action is legal (the deliberate "one question, one
 * button, and Stop to cancel" shape).
 */
export const userInputActionsSchema = z
  .array(userInputOptionSchema)
  .min(1)
  .max(USER_INPUT_MAX_ACTIONS);

/**
 * The model-facing request, normalized: the tool applies the "false by default"
 * defaults before this reaches the application, so a consumer never has to
 * re-decide what an omitted `multiple` meant.
 *
 * `question` is optional: an ordinary choice or free-input question always
 * carries one, but a pure action prompt ("Load more") has no sentence to show -
 * the buttons are the whole interface. At least one of `question` / `options` /
 * `actions` must be present; a request with none of them asks nothing.
 */
export const userInputRequestSchema = z
  .object({
    question: userInputQuestionSchema.optional(),
    /** The selectable variants. Absent means free-input only. */
    options: userInputOptionsSchema.optional(),
    /** One-click buttons (no text field); mutually exclusive with `options`. */
    actions: userInputActionsSchema.optional(),
    /** Checkboxes (many) rather than radios/picker (one). */
    multiple: z.boolean(),
    /** Offer the "type your own answer" escape hatch alongside the options. */
    freeInput: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.question === undefined &&
      value.options === undefined &&
      value.actions === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'A user-input request needs a question, options, or actions',
      });
    }
  });

export type UserInputRequest = Readonly<z.infer<typeof userInputRequestSchema>>;

/**
 * What the user chose. `selections` are option labels; `freeform` is the typed
 * answer when the free-input variant was used. The free-input UI replaces the
 * selection controls, so a well-formed answer is normally one or the other -
 * but both fields are always present so a consumer never has to branch on an
 * omitted key.
 */
export const userInputAnswerSchema = z
  .object({
    selections: z.array(userInputOptionSchema).max(USER_INPUT_MAX_OPTIONS),
    freeform: z.string().max(USER_INPUT_FREEFORM_MAX_LENGTH).nullable(),
  })
  .strict();

export type UserInputAnswer = Readonly<z.infer<typeof userInputAnswerSchema>>;

export function parseUserInputAnswer(candidate: unknown): UserInputAnswer {
  return userInputAnswerSchema.parse(candidate);
}
