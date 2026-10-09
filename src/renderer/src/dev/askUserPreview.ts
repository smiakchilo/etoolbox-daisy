import { type UserInputRequest, USER_INPUT_MAX_ACTIONS } from '../../../shared';

/**
 * The dev-only ask-user preview (Tier 1): a `!!ask ...` cheat code typed into
 * the composer that paints a canned question locally, with no model, no AEM
 * instance, and no main-process round trip. It exists so the composer's
 * selection UI and the transcript's question/answer rendering can be iterated
 * on quickly; the real answer round trip is covered by the automated
 * fake-backed E2E.
 *
 * Pure and side-effect free: it only parses a string into the same
 * {@link UserInputRequest} shape the real `user.input.requested` event carries,
 * so the preview is a faithful stand-in. Reachable only when dev tools are
 * enabled (`window.daisy.devTools`), which a packaged build never sets.
 */

/** The cheat-code prefix. `!!` cannot collide with a `/skillname`. */
export const ASK_USER_PREVIEW_PREFIX = '!!ask';

const DEFAULT_OPTIONS = ['Option A', 'Option B', 'Option C'];

function numberedOptions(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `Option ${String(index + 1)}`);
}

/**
 * Parses a `!!ask ...` input into a preview request, or `undefined` when the
 * input is not a preview command (so ordinary prompts pass through untouched).
 *
 *   !!ask                  default: 3 options, single-select (radios)
 *   !!ask radio 8          single-select, 8 options (dropdown)
 *   !!ask multi 4          multiple, 4 options (checkboxes)
 *   !!ask multi 8          multiple, 8 options (multi-select dropdown)
 *   !!ask free             free input only
 *   !!ask radio 3 +free    options plus the free-input link
 *   !!ask actions          one-click actions: a single "Action" button (no question/text field)
 *   !!ask actions 3        one-click actions: 3 buttons, all labelled "Action"
 *   !!ask long             long question/labels (wrapping)
 *   !!ask nasty            HTML-ish labels (proves textContent, never HTML)
 */
export function parseAskUserPreview(input: string): UserInputRequest | undefined {
  const trimmed = input.trim();
  if (trimmed !== ASK_USER_PREVIEW_PREFIX && !trimmed.startsWith(`${ASK_USER_PREVIEW_PREFIX} `)) {
    return undefined;
  }
  const rest = trimmed.slice(ASK_USER_PREVIEW_PREFIX.length).trim();
  if (rest === '') {
    return {
      question: 'Which option would you like?',
      options: DEFAULT_OPTIONS,
      multiple: false,
      freeInput: false,
    };
  }

  const tokens = rest.split(/\s+/);
  const freeInput = tokens.includes('+free');
  const kind = tokens[0];

  if (kind === 'free') {
    return { question: 'Type your answer', multiple: false, freeInput: true };
  }
  if (kind === 'long') {
    return {
      question:
        'This is a deliberately long question used to check how the composer wraps a multi-line ' +
        'prompt above a control, and how a long option label behaves when it does not fit on one ' +
        'line in a narrow pane. Which of the following do you want?',
      options: [
        'A short one',
        'A noticeably longer option label that should wrap onto a second line when the pane is narrow',
        'Another one',
        'And one more',
        'Fifth',
        'Sixth (this set is over the dropdown threshold)',
      ],
      multiple: false,
      freeInput,
    };
  }
  if (kind === 'nasty') {
    return {
      question: 'Pick a <b>safe</b> label & continue - this text must never render as HTML',
      options: ['<b>bold</b>', 'a & b', '"quoted"', "'apostrophe'", 'emoji 🚀', 'שלום (RTL)'],
      multiple: false,
      freeInput,
    };
  }
  if (kind === 'actions') {
    const requested = Number.parseInt(tokens[1] ?? '1', 10);
    const count = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), USER_INPUT_MAX_ACTIONS)
      : 1;
    // The label is deliberately neutral ("Action"): the preview exercises the
    // buttons' layout, not their wording. The multi case still carries a
    // question so the preview proves a caption passed alongside actions is
    // suppressed - in the composer and in the transcript. An `actions` request
    // carries no options or free-input - a click answers on its own - so
    // `multiple`/`freeInput` stay false.
    if (count === 1) {
      return { actions: ['Action'], multiple: false, freeInput: false };
    }
    return {
      question: 'Choose an action',
      actions: Array.from({ length: count }, () => 'Action'),
      multiple: false,
      freeInput: false,
    };
  }
  if (kind === 'radio' || kind === 'multi') {
    const requested = Number.parseInt(tokens[1] ?? '3', 10);
    const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 3;
    return {
      question: kind === 'multi' ? 'Choose one or more options' : 'Choose an option',
      options: numberedOptions(count),
      multiple: kind === 'multi',
      freeInput,
    };
  }

  return {
    question: `Unrecognised preview "${rest}" - try: radio N, multi N, free, actions [N], long, nasty`,
    options: DEFAULT_OPTIONS,
    multiple: false,
    freeInput: false,
  };
}
