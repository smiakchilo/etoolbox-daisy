import { el } from '../lib/dom';
import { loadComposerHistory, saveComposerHistory } from '../lib/composerHistoryStore';
import { createComposerHistoryNavigator, resolveCaretBounds } from './composerHistory';
import {
  ASK_USER_DROPDOWN_THRESHOLD,
  buildActionAnswer,
  buildAskUserAnswer,
  isActionsRequest,
  isAskUserAnswerComplete,
  type AskUserDraft,
  type ComposerButtonState,
  shouldSubmitOnEnter,
} from './composerViewModel';
import {
  EMPTY_SKILL_MENU,
  isSkillMenuOpen,
  moveSkillMenuSelection,
  refreshSkillMenu,
  resolveSkillMenuKey,
  skillAcceptValue,
  type SkillMenuState,
} from './composerSkillsViewModel';
import { createSkillPopover } from './skillPopover';
import type { AgentChatSkill, UserInputAnswer, UserInputRequest } from '../../../shared';

type TextFieldElement = HTMLElement & { value: string };

/** The prompt field's ordinary height, in lines, once a conversation has begun. */
const TEXTAREA_ROWS = 4;

/**
 * The prompt field's height, in lines, for the initial paint while the
 * conversation is still empty. Once laid out, the pane stretches the field to
 * its full height (see `chat.css`'s `.chat-pane--empty` rules), so this only
 * governs the pre-layout frame and the fallback when no height is measurable.
 */
const TEXTAREA_EMPTY_ROWS = 8;

/**
 * Height at which the field stops growing and starts scrolling instead. The
 * enclosing frame is sized by the field, so it freezes at the same point.
 */
const TEXTAREA_MAX_LINES = 20;

/**
 * Carry the accent fill only while Send may actually be pressed. The accent
 * is applied through Spectrum's `--mod-actionbutton-*` hooks, and a light-DOM
 * class rule outranks the component's own `:host([disabled])` tokens - so if
 * the accent stayed on, a disabled Send still painted bright blue. Toggling
 * it off lets the component's disabled tokens show through.
 */
const SEND_ACCENT_CLASS = 'chat-composer__send--enabled';

/**
 * The one-time attention flash the composer frame runs when a new `ask_user`
 * question replaces the text input - a blue wash over the frame that fades back
 * to whatever background the visible variant rests on (see `chat.css`'s
 * `chat-composer-attention`). The class is added once per question and removed
 * on `animationend`, so the pane's periodic repaint can never replay it.
 */
export const ATTENTION_CLASS = 'chat-composer__frame--attention';

/** The `@keyframes` name the frame's `animationend` listener filters on. */
export const ATTENTION_ANIMATION = 'chat-composer-attention';

/**
 * Puts the composer frame into its "button strip" look - no visible border, a
 * contrasting gray fill - while it asks a one-click-actions or >5-option
 * dropdown question (see `chat.css`). Applied for the whole lifetime of such a
 * question, so it survives the "type your own answer" swap that hides the
 * dropdown control itself.
 */
export const STRIP_CLASS = 'chat-composer__frame--strip';

/**
 * The one-click action labels painted as the **emphasized** variant, so a
 * secondary, whole-result action reads distinctly from the primary one beside
 * it - the search composites offer "Load all" beside "Load more". Keyed by
 * label because the ask-user contract carries only labels; see `chat.css`'s
 * `.chat-ask__action--emphasis` (an accent-blue border).
 */
const EMPHASIZED_ACTIONS: ReadonlySet<string> = new Set(['Load all']);

/** The modifier class {@link buildActionButton} adds for an {@link EMPHASIZED_ACTIONS} label. */
const ACTION_EMPHASIS_CLASS = 'chat-ask__action--emphasis';

/**
 * The composer's mutable working copy of an in-progress ask-user answer. Kept
 * mutable so the option controls (which the DOM owns) can update it in place
 * without rebuilding themselves on every keystroke/selection.
 */
interface MutableAskDraft {
  selections: string[];
  freeform: string;
  freeInputActive: boolean;
}

/** Widens the mutable draft to the read-only shape the pure view-model helpers take. */
function askDraftView(draft: MutableAskDraft): AskUserDraft {
  return {
    selections: draft.selections,
    freeform: draft.freeform,
    freeInputActive: draft.freeInputActive,
  };
}

export type ComposerSendOutcome = { readonly ok: true } | { readonly ok: false };

export interface ComposerCallbacks {
  /** Sends `prompt`. Resolves once main has accepted or rejected it - never rejects. */
  onSend(prompt: string): Promise<ComposerSendOutcome>;
  /** Requests the current in-flight turn be cancelled. */
  onStop(): void;
  /** Delivers the user's answer to an interactive (`ask_user`) question. */
  onAnswer?(answer: UserInputAnswer): void;
  /**
   * Dev-only: intercepts an input before it is sent, so local cheat codes
   * (`!!ask ...`, `!!open <chatId>`) can drive the composer without a model or
   * an AEM instance. A lone `?` argument prints a command's usage (`!!ask ?`,
   * `!!open ?`; `!!?` lists them all - see `dev/devCommands.ts`). Returns
   * whether the input was consumed. Absent in a packaged build, where the
   * composer never treats any input as a command.
   */
  onDevCommand?(input: string): boolean;
}

export interface Composer {
  readonly element: HTMLElement;
  /** Applies the latest computed button state - see `composerViewModel.ts`. */
  setButtonState(state: ComposerButtonState): void;
  /**
   * Tells the composer whether the conversation has any content yet. While
   * empty the field is stretched to the pane's full height; the caller is
   * responsible for the pane-level layout that gives it that height (see
   * `chatPane.ts` / `chat.css`).
   */
  setConversationEmpty(empty: boolean): void;
  /**
   * Supplies the bundled skill catalogue the `/` autocomplete filters. Called
   * once main's asynchronous read lands; until then an empty list simply means
   * "no suggestions", never an error.
   */
  setSkills(skills: readonly AgentChatSkill[]): void;
  /**
   * Enters the interactive-question UI for `request`, or leaves it when
   * `undefined`. While a question is shown the text field is replaced by the
   * selection controls (or restored for the free-input variant) and Send
   * submits the answer; Stop stays available to cancel the turn.
   */
  setInputRequest(request: UserInputRequest | undefined): void;
  /**
   * Appends one-click `actions` to the actions question that is on screen,
   * without repainting it: no attention flash, and the buttons already shown
   * (and the reader's hover/focus on them) are untouched. A no-op unless an
   * actions question is showing and still unanswered; an action already shown
   * is not duplicated.
   */
  addInputActions(actions: readonly string[]): void;
  /**
   * Puts the keyboard caret in the prompt field. Used when the pane wants the
   * user to start typing straight away - most importantly after "New session",
   * so a fresh conversation opens ready for input rather than requiring a click
   * into the field first.
   */
  focus(): void;
  /** Releases the resize observer that keeps the empty-state field stretched. */
  dispose(): void;
}

/**
 * The chat composer: a bordered frame holding a borderless multiline prompt
 * field and, in its bottom-right corner, one Send/Stop control. All
 * enable/disable and Send-vs-Stop decisions are made by
 * `computeComposerButtonState` (`composerViewModel.ts`) and handed in via
 * `setButtonState` - this module only ever presents whatever state it is
 * given, and never re-derives it.
 *
 * Send and Stop are two separate elements rather than one relabelled button,
 * so only the current one is shown; each is toggled with an inline `display`,
 * because the `hidden` attribute does not reliably hide a custom element
 * whose shadow `:host` rule sets `display`.
 */
export function createComposer(callbacks: ComposerCallbacks): Composer {
  const field = el('sp-textfield', {
    attrs: {
      class: 'chat-composer__field',
      multiline: '',
      rows: String(TEXTAREA_EMPTY_ROWS),
      placeholder: 'Type your message or command here',
      'aria-label': 'Message',
      'data-testid': 'chat-composer-field',
    },
  }) as TextFieldElement;

  const sendButton = el('sp-action-button', {
    attrs: { class: 'chat-composer__send', 'aria-label': 'Send' },
  });
  sendButton.append(el('sp-icon-send', { attrs: { slot: 'icon' } }));

  const stopButton = el('sp-action-button', {
    attrs: { class: 'chat-composer__stop', 'aria-label': 'Stop' },
  });
  stopButton.append(el('sp-icon-cross600', { attrs: { slot: 'icon' } }));

  // The interactive-question panel, hidden until `setInputRequest` shows a
  // question. Declared here (not with the frame) because `applyPresentation`
  // runs at construction and reads it. Sits above the field so a free-input
  // question reads "question, then field".
  const askPanel = el('div', { attrs: { class: 'chat-ask', hidden: '' } });

  // The one-click buttons of an `actions` ask-user prompt. Unlike the options,
  // these are NOT in the ask panel: they share the composer's action row with
  // Send/Stop so every button sits on one line, with Cancel pinned right (see
  // `chat.css`'s `.chat-ask__actions`). Hidden until an actions request arrives.
  const actionButtons = el('div', { attrs: { class: 'chat-ask__actions', hidden: '' } });

  // Every message the composer would once have shown inline (the connecting
  // state, a send-blocked reason, a send failure) is routed to the chat pane's
  // single `sp-alert-banner` instead - see `chatPane.ts`'s
  // `refreshSessionPresentation`. This module is deliberately left with the
  // field and the Send/Stop control only.

  let current: ComposerButtonState = { kind: 'connecting' };
  let conversationEmpty = true;
  // Guards against a second submit firing while the previous `onSend` call
  // is still in flight, independently of `current` - `current` only updates
  // once a new `ComposerButtonState` is pushed in from outside (driven by
  // the next `AgentEvent` or status poll), which is not guaranteed to have
  // happened yet at the instant a fast second Enter/click arrives. This is
  // what makes double-submission structurally impossible rather than merely
  // unlikely.
  let submitting = false;
  // Tracks IME composition independently of `KeyboardEvent.isComposing`
  // (which some browsers only set reliably on the composition events
  // themselves, not on every subsequent keydown) as a second, redundant
  // signal - see `shouldSubmitOnEnter`'s doc comment.
  let composing = false;
  // The user's submitted prompts, recalled with Up/Down. Loaded once at
  // construction; every successful submit appends and re-persists it.
  const history = createComposerHistoryNavigator(loadComposerHistory());

  // The skill catalogue for the `/` autocomplete, supplied asynchronously via
  // `setSkills`. Empty until main's read lands.
  let skills: readonly AgentChatSkill[] = [];
  // The autocomplete's pure state (matching suggestions + highlighted row). The
  // popup that draws it is Spectrum's own overlay/popover - see
  // `skillPopover.ts` - and is absent under jsdom, where this state is still
  // maintained but never rendered.
  let skillMenu: SkillMenuState = EMPTY_SKILL_MENU;

  // The interactive-question state. `inputRequest` is the question currently on
  // screen (`undefined` in the composer's ordinary text mode); `draft` is the
  // mutable answer being built. See `setInputRequest` and `applyPresentation`.
  let inputRequest: UserInputRequest | undefined;
  const draft: MutableAskDraft = { selections: [], freeform: '', freeInputActive: false };
  // Whether an answered one-click-actions question (the `/search` /
  // `/semantic-search` "Load more" loop) is being held on screen while the turn
  // continues. On the click, the question is answered and `inputRequest` is
  // left in place (buttons disabled) instead of immediately restoring the
  // ordinary text field: the loop's next question usually arrives within a few
  // hundred milliseconds, and flipping to the (four-rows-tall) field and back
  // made the composer jump. The panel is released when the next question
  // replaces it (`setInputRequest`) or the turn leaves the in-flight state
  // (`setButtonState`), whichever happens first.
  let holdingAnsweredActions = false;
  // Set when a Stop/Cancel click happens while the interactive UI is (or is
  // about to be) on screen, so the prompt field is focused once it actually
  // returns. Needed for a held actions panel, where the field is still hidden at
  // click time; the immediate case focuses directly (see the click handler).
  let focusFieldOnExit = false;
  // The portal overlay the >5 multiple-choice dropdown attaches to the theme,
  // tracked so it can be removed when the question goes away. An `sp-overlay`
  // is NOT a child of `askPanel` (it portals out to `sp-theme`), so clearing the
  // panel leaves it in the DOM - visible in the top-left - unless it is removed
  // explicitly.
  let multiOverlay: (HTMLElement & { open?: boolean }) | undefined;

  /**
   * The field's current text. `sp-textfield.value` is always a string once the
   * component is upgraded, but jsdom never upgrades it, so an unset field reads
   * back `undefined` there; normalising keeps the history logic total.
   */
  function readValue(): string {
    return typeof field.value === 'string' ? field.value : '';
  }

  /** The shadow textarea's current selection, or `undefined` when it cannot be read. */
  function readSelection(): { readonly start: number; readonly end: number } | undefined {
    const textarea = field.shadowRoot?.querySelector('textarea');
    const start = textarea?.selectionStart;
    const end = textarea?.selectionEnd;
    if (typeof start !== 'number' || typeof end !== 'number') return undefined;
    return { start, end };
  }

  /**
   * Puts the caret at the end of `text`, where a recalled prompt should leave
   * it. `sp-textfield` propagates `value` to its shadow `<textarea>` on its
   * next Lit update, so the range is applied once `updateComplete` resolves -
   * setting it immediately would clamp against the stale text. A not-yet-
   * upgraded field (jsdom) has no `updateComplete` and applies at once.
   */
  function moveCaretToEnd(text: string): void {
    const apply = (): void => {
      const textarea = field.shadowRoot?.querySelector('textarea');
      textarea?.setSelectionRange(text.length, text.length);
    };
    const ready = (field as HTMLElement & { readonly updateComplete?: Promise<unknown> })
      .updateComplete;
    if (ready === undefined) {
      apply();
      return;
    }
    void ready.then(apply);
  }

  /**
   * Handles an Up/Down keydown as history recall, returning whether the event
   * was consumed (and should be prevented from moving the caret).
   *
   * At the draft position, Up only recalls when the caret is already at the
   * very start (otherwise it moves within a multiline draft), and Down never
   * recalls. While already recalling an entry, Up always steps further back and
   * Down steps forward only once the caret is at the end - so a multiline
   * remembered prompt can still be navigated with the arrows.
   */
  function recallHistory(keyEvent: KeyboardEvent): boolean {
    if (keyEvent.key !== 'ArrowUp' && keyEvent.key !== 'ArrowDown') return false;
    if (keyEvent.shiftKey || keyEvent.ctrlKey || keyEvent.altKey || keyEvent.metaKey) return false;

    const currentText = readValue();
    const bounds = resolveCaretBounds(currentText, readSelection());
    const recalling = history.isRecalling();
    if (keyEvent.key === 'ArrowUp') {
      if (!recalling && !bounds.atStart) return false;
    } else if (!recalling || !bounds.atEnd) {
      return false;
    }

    const recalled = keyEvent.key === 'ArrowUp' ? history.previous(currentText) : history.next();
    if (recalled === undefined) return false;

    field.value = recalled;
    moveCaretToEnd(recalled);
    autosize();
    return true;
  }

  /** Re-reads the field text into the autocomplete state and redraws the popup. */
  function refreshSkillSuggestions(): void {
    skillMenu = refreshSkillMenu(skillMenu, readValue(), skills);
    syncSkillPopover();
  }

  function closeSkillMenu(): void {
    skillMenu = EMPTY_SKILL_MENU;
    syncSkillPopover();
  }

  /** Redraws the popup from the current state, or hides it when there is nothing to show. */
  function syncSkillPopover(): void {
    if (isSkillMenuOpen(skillMenu)) {
      popover?.show(skillAnchor, skillMenu.suggestions, skillMenu.selectedIndex);
    } else {
      popover?.hide();
    }
  }

  /**
   * Replaces the typed token with the chosen skill's name plus a trailing
   * space, leaving the caret after it so the user can type the actual request.
   * The field keeps focus: accepting a suggestion is an edit, not a submit.
   */
  function acceptSkillAt(index: number): void {
    const skill = skillMenu.suggestions[index];
    if (skill === undefined) return;
    const value = skillAcceptValue(skill);
    field.value = value;
    moveCaretToEnd(value);
    autosize();
    closeSkillMenu();
    field.focus();
  }

  /**
   * Handles a keydown against the open popup, returning whether it was consumed.
   * Enter and Tab both accept the highlighted suggestion (see
   * `resolveSkillMenuKey`); a click does too. While the popup is open, Enter is
   * consumed rather than submitting the half-typed token.
   */
  function handleSkillMenuKey(keyEvent: KeyboardEvent): boolean {
    if (!isSkillMenuOpen(skillMenu)) return false;
    switch (resolveSkillMenuKey(keyEvent.key, keyEvent.shiftKey)) {
      case 'dismiss':
        closeSkillMenu();
        return true;
      case 'next':
        skillMenu = moveSkillMenuSelection(skillMenu, 1);
        syncSkillPopover();
        return true;
      case 'previous':
        skillMenu = moveSkillMenuSelection(skillMenu, -1);
        syncSkillPopover();
        return true;
      case 'accept':
        acceptSkillAt(skillMenu.selectedIndex);
        return true;
      default:
        return false;
    }
  }

  /** Builds the option controls for the current question, per its shape and the >5 threshold. */
  function buildOptionControls(options: readonly string[]): HTMLElement {
    const request = inputRequest;
    if (request === undefined) return el('div');
    if (request.multiple) {
      return options.length > ASK_USER_DROPDOWN_THRESHOLD
        ? buildMultiDropdown(options)
        : buildCheckboxList(options);
    }
    return options.length > ASK_USER_DROPDOWN_THRESHOLD
      ? buildSinglePicker(options)
      : buildRadioGroup(options);
  }

  function buildRadioGroup(options: readonly string[]): HTMLElement {
    const group = el('sp-radio-group', { attrs: { class: 'chat-ask__group' } });
    for (const option of options) {
      group.append(el('sp-radio', { attrs: { value: option }, text: option }));
    }
    group.addEventListener('change', (event) => {
      const selected = (event.target as { selected?: unknown }).selected;
      draft.selections = typeof selected === 'string' && selected.length > 0 ? [selected] : [];
      applyPresentation();
    });
    return group;
  }

  function buildCheckboxList(options: readonly string[]): HTMLElement {
    const list = el('div', { attrs: { class: 'chat-ask__checkboxes' } });
    for (const option of options) {
      const checkbox = el('sp-checkbox', { attrs: { class: 'chat-ask__checkbox' }, text: option });
      checkbox.addEventListener('change', () => {
        const checked = (checkbox as { checked?: unknown }).checked === true;
        const next = new Set(draft.selections);
        if (checked) next.add(option);
        else next.delete(option);
        draft.selections = [...next];
        applyPresentation();
      });
      list.append(checkbox);
    }
    return list;
  }

  function buildSinglePicker(options: readonly string[]): HTMLElement {
    const picker = el('sp-picker', {
      // No visible `label` attribute: it renders as a field label, and the
      // question is already shown above. `aria-label` keeps it accessible.
      attrs: { class: 'chat-ask__picker', 'aria-label': 'Choose an option' },
    });
    for (const option of options) {
      picker.append(el('sp-menu-item', { attrs: { value: option }, text: option }));
    }
    // Default to the current selection (the first option), so the picker shows a
    // value rather than its placeholder. An attribute, not a property: a
    // property set before the element upgrades would be lost, while the
    // attribute is read on upgrade.
    const initial = draft.selections[0] ?? options[0];
    if (initial !== undefined) picker.setAttribute('value', initial);
    picker.addEventListener('change', () => {
      const value = (picker as { value?: unknown }).value;
      draft.selections = typeof value === 'string' && value.length > 0 ? [value] : [];
      applyPresentation();
    });
    return picker;
  }

  /**
   * The >5 multiple-choice dropdown. `sp-picker` is single-select in this
   * Spectrum version, so this composes an action button that opens an
   * `sp-menu selects="multiple"` in an overlay - the standard Spectrum
   * multi-select pattern - and shows the selected labels on the button.
   */
  function buildMultiDropdown(options: readonly string[]): HTMLElement {
    const label = el('span', { attrs: { class: 'chat-ask__multi-label' } });
    const menu = el('sp-menu', { attrs: { class: 'chat-ask__menu', selects: 'multiple' } });
    for (const option of options) {
      menu.append(el('sp-menu-item', { attrs: { value: option }, text: option }));
    }
    const updateLabel = (): void => {
      label.textContent =
        draft.selections.length === 0 ? 'Choose options' : draft.selections.join(', ');
    };
    menu.addEventListener('change', () => {
      const selected = (menu as { selected?: unknown }).selected;
      draft.selections = Array.isArray(selected)
        ? selected.filter((value): value is string => typeof value === 'string')
        : [];
      updateLabel();
      applyPresentation();
    });
    // Default to the current selection (the first option). `selected` is an
    // array with no attribute, so it is applied once `renderAskPanel` has
    // connected the menu (the element must be upgraded for the setter to work).
    const initial = [...draft.selections];
    queueMicrotask(() => {
      (menu as { selected?: string[] }).selected = initial;
    });

    const popover = el('sp-popover', { attrs: { class: 'chat-ask__popover' } });
    popover.append(menu);
    const overlay = el('sp-overlay', {
      attrs: { type: 'manual', placement: 'bottom-start' },
    }) as HTMLElement & { triggerElement?: HTMLElement; open?: boolean };
    overlay.append(popover);

    const button = el('sp-action-button', {
      attrs: { class: 'chat-ask__multi-button' },
      children: [el('sp-icon-chevron-down', { attrs: { slot: 'icon', size: 's' } }), label],
    });
    let anchored = false;
    button.addEventListener('click', () => {
      if (typeof customElements === 'undefined' || customElements.get('sp-overlay') === undefined) {
        return;
      }
      if (!anchored) {
        (element.closest('sp-theme') ?? document.body).append(overlay);
        overlay.triggerElement = button;
        anchored = true;
      }
      updateLabel();
      overlay.open = overlay.open !== true;
    });
    updateLabel();
    multiOverlay = overlay;
    return el('div', { attrs: { class: 'chat-ask__multi' }, children: [button] });
  }

  /** Removes the multi-select dropdown's portal overlay, if one is attached. */
  function disposeMultiOverlay(): void {
    const overlay = multiOverlay;
    multiOverlay = undefined;
    if (overlay === undefined) return;
    overlay.open = false;
    overlay.remove();
  }

  /**
   * One one-click action button. It answers the instant it is clicked (there
   * is no Submit); the answered panel is held on screen (buttons disabled) until
   * the next question or the end of the turn - see `holdingAnsweredActions`.
   * An {@link EMPHASIZED_ACTIONS} label additionally wears the emphasized
   * modifier (a blue border).
   */
  function buildActionButton(action: string): HTMLElement {
    const emphasized = EMPHASIZED_ACTIONS.has(action);
    const button = el('sp-action-button', {
      attrs: {
        class: emphasized ? `chat-ask__action ${ACTION_EMPHASIS_CLASS}` : 'chat-ask__action',
        'aria-label': action,
      },
      text: action,
    });
    button.addEventListener('click', () => {
      // Answer in place: hold the (now answered, disabled) panel rather than
      // restoring the taller text field, so the loop's next question can replace
      // it without the frame jumping - see `holdingAnsweredActions`.
      holdingAnsweredActions = true;
      for (const sibling of actionButtons.children) sibling.setAttribute('disabled', '');
      callbacks.onAnswer?.(buildActionAnswer(action));
    });
    return button;
  }

  /** Paints the current question and its controls into `askPanel`. */
  function renderAskPanel(): void {
    // A rebuild replaces the option controls; drop any portal overlay the
    // previous multi-select dropdown attached to the theme.
    disposeMultiOverlay();
    const request = inputRequest;
    if (request === undefined) {
      askPanel.replaceChildren();
      askPanel.hidden = true;
      actionButtons.replaceChildren();
      actionButtons.hidden = true;
      return;
    }
    const actions = request.actions;
    if (actions !== undefined && actions.length > 0) {
      // Actions are a mode of their own: one-click buttons that share the
      // composer's action row with Cancel (so they sit on one line) and carry
      // no caption - a button's label explains itself. The ask panel stays
      // empty and hidden.
      actionButtons.replaceChildren(...actions.map(buildActionButton));
      actionButtons.hidden = false;
      askPanel.replaceChildren();
      askPanel.hidden = true;
      return;
    }
    actionButtons.replaceChildren();
    actionButtons.hidden = true;
    const children: HTMLElement[] = [];
    if (request.question !== undefined) {
      children.push(el('p', { attrs: { class: 'chat-ask__question' }, text: request.question }));
    }
    const freeActive = draft.freeInputActive || request.options === undefined;
    if (!freeActive && request.options !== undefined) {
      children.push(buildOptionControls(request.options));
    }
    if (request.freeInput && !freeActive) {
      const link = el('button', {
        attrs: { type: 'button', class: 'chat-ask__free' },
        text: 'Type your own answer',
      });
      link.addEventListener('click', () => {
        draft.freeInputActive = true;
        renderAskPanel();
        applyPresentation();
        field.focus();
      });
      children.push(link);
    }
    askPanel.replaceChildren(...children);
    askPanel.hidden = false;
  }

  /** Leaves the interactive-question UI, restoring the ordinary composer. */
  function exitInputMode(): void {
    disposeMultiOverlay();
    inputRequest = undefined;
    holdingAnsweredActions = false;
    draft.selections = [];
    draft.freeform = '';
    draft.freeInputActive = false;
    frame.classList.remove(STRIP_CLASS);
    askPanel.replaceChildren();
    askPanel.hidden = true;
    actionButtons.replaceChildren();
    actionButtons.hidden = true;
    field.value = '';
    field.style.display = '';
    applyPresentation();
    if (focusFieldOnExit) {
      focusFieldOnExit = false;
      field.focus();
    }
  }

  function applyPresentation(): void {
    // Interactive-question mode overrides the Send/Stop derivation entirely:
    // the turn is in flight (so the session state says "stop"), but Send must
    // become "submit this answer" and Stop must stay available to cancel.
    if (inputRequest !== undefined) {
      if (isActionsRequest(inputRequest)) {
        // Actions mode: buttons only. The text field and Send are hidden (a
        // click answers directly, so there is nothing to submit); Stop stays so
        // the turn can still be cancelled. The action buttons live in the
        // action row (see `actionButtons`), on the same line as Stop, so the
        // ask panel is left empty and hidden.
        field.style.display = 'none';
        askPanel.style.display = 'none';
        sendButton.style.display = 'none';
        stopButton.style.display = '';
        return;
      }
      const freeActive = draft.freeInputActive || inputRequest.options === undefined;
      field.style.display = freeActive ? '' : 'none';
      askPanel.style.display = '';
      sendButton.style.display = '';
      stopButton.style.display = '';
      sendButton.setAttribute('aria-label', 'Submit answer');
      const complete = isAskUserAnswerComplete(inputRequest, askDraftView(draft));
      if (complete) sendButton.removeAttribute('disabled');
      else sendButton.setAttribute('disabled', '');
      sendButton.classList.toggle(SEND_ACCENT_CLASS, complete);
      return;
    }
    field.style.display = '';
    askPanel.style.display = 'none';
    sendButton.setAttribute('aria-label', 'Send');

    const inFlight = current.kind === 'stop';
    sendButton.style.display = inFlight ? 'none' : '';
    stopButton.style.display = inFlight ? '' : 'none';
    sendButton.classList.toggle(SEND_ACCENT_CLASS, current.kind === 'send-enabled');

    switch (current.kind) {
      case 'connecting':
      case 'unavailable':
        sendButton.setAttribute('disabled', '');
        return;
      case 'stop':
        stopButton.removeAttribute('disabled');
        return;
      case 'send-enabled':
        sendButton.removeAttribute('disabled');
        return;
      case 'send-disabled':
        sendButton.setAttribute('disabled', '');
        return;
      case 'agent-inactive':
        // The chat pane's own banner carries the explanation; the composer
        // stays silent so the two do not say the same thing twice.
        sendButton.setAttribute('disabled', '');
        return;
      default: {
        return current;
      }
    }
  }
  applyPresentation();

  /**
   * Sizes the field's shadow `<textarea>`.
   *
   * Once a conversation has begun the field grows with its content up to
   * `TEXTAREA_MAX_LINES`, then scrolls; the field's own height drives the
   * frame's (it is a flex column), so nothing else needs resizing. While the
   * conversation is empty the pane hands the frame the whole height, so the
   * field fills whatever it is offered - the textarea takes the field's
   * measured height instead of a fixed row count, and scrolls once its content
   * exceeds it.
   *
   * `sp-textfield` renders the real `<textarea>` in its shadow root. A
   * `rows`-sized textarea keeps that height regardless of content, so
   * collapsing it to `auto` first makes `clientHeight` report the intrinsic
   * (rows-sized) height - used to derive one line - and `scrollHeight` the
   * full content height.
   */
  function autosize(): void {
    const textarea = field.shadowRoot?.querySelector('textarea');
    if (textarea === null || textarea === undefined) return;

    textarea.style.height = 'auto';
    const lineBoxHeight = textarea.clientHeight;
    // jsdom reports 0 for every layout metric; skip rather than write garbage.
    if (lineBoxHeight <= 0) return;

    const style = getComputedStyle(textarea);
    const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

    if (conversationEmpty) {
      const fillHeight = field.clientHeight;
      if (fillHeight > 0) {
        textarea.style.height = `${fillHeight}px`;
        textarea.style.overflowY = textarea.scrollHeight > fillHeight ? 'auto' : 'hidden';
        return;
      }
    }

    const rows = textarea.rows > 0 ? textarea.rows : TEXTAREA_ROWS;
    const lineHeight = (lineBoxHeight - verticalPadding) / rows;
    const minHeight =
      verticalPadding + lineHeight * (conversationEmpty ? TEXTAREA_EMPTY_ROWS : TEXTAREA_ROWS);
    const maxHeight = verticalPadding + lineHeight * TEXTAREA_MAX_LINES;

    const contentHeight = Math.max(textarea.scrollHeight, minHeight);
    textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }

  function trySubmit(): void {
    if (submitting) return;
    const prompt = readValue().trim();

    // Dev-only local commands are consumed before anything is sent. The pane
    // supplies `onDevCommand` only in an unpackaged build, so a packaged
    // composer never treats any input as a command.
    if (callbacks.onDevCommand?.(prompt) === true) {
      field.value = '';
      autosize();
      return;
    }

    // Interactive-question mode: Send submits the answer instead of a prompt.
    if (inputRequest !== undefined) {
      if (!isAskUserAnswerComplete(inputRequest, askDraftView(draft))) return;
      const answer = buildAskUserAnswer(inputRequest, askDraftView(draft));
      exitInputMode();
      callbacks.onAnswer?.(answer);
      return;
    }

    if (current.kind !== 'send-enabled') return;
    if (prompt === '') return;

    closeSkillMenu();
    submitting = true;
    history.reset();
    const previousValue = readValue();
    field.value = '';
    autosize();
    void callbacks
      .onSend(prompt)
      .then((outcome) => {
        if (outcome.ok) {
          // Only accepted prompts become history: a rejected send puts the
          // text straight back in the field, so it is still in the user's
          // hands and need not be recalled.
          history.record(prompt);
          saveComposerHistory(history.entries());
        } else {
          // A rejected send restores the prompt; the failure message itself is
          // the chat pane's banner (see `chatPane.ts`'s `onSend`), so nothing is
          // shown here.
          field.value = previousValue;
          autosize();
        }
      })
      .finally(() => {
        submitting = false;
      });
  }

  field.addEventListener('input', () => {
    // While a question is on screen the field is the free-input answer (only
    // shown for the free-input variant); history and the `/` autocomplete do
    // not apply.
    if (inputRequest !== undefined) {
      draft.freeform = readValue();
      applyPresentation();
      return;
    }
    // A user edit (programmatic recall does not fire `input`) abandons any walk
    // through history: the text on screen is the new draft, and the next Up
    // starts again from the newest prompt.
    history.reset();
    autosize();
    // The `/skillname` suggestions track the field's own text, so every edit -
    // typing, deleting, pasting - re-evaluates them.
    refreshSkillSuggestions();
  });
  field.addEventListener('compositionstart', () => {
    composing = true;
  });
  field.addEventListener('compositionend', () => {
    composing = false;
  });
  field.addEventListener('keydown', (keyEvent) => {
    const isComposing = composing || keyEvent.isComposing;
    // The open skill popup claims the arrow keys (to move its highlight) and
    // Escape/Tab/Enter before history recall or submission see them - Enter and
    // Tab accept the highlighted suggestion, Escape dismisses (see
    // `handleSkillMenuKey`). Neither the popup nor history recall exists while a
    // question is on screen.
    if (inputRequest === undefined) {
      if (!isComposing && handleSkillMenuKey(keyEvent)) {
        keyEvent.preventDefault();
        return;
      }
      if (!isComposing && recallHistory(keyEvent)) {
        keyEvent.preventDefault();
        return;
      }
    }
    if (
      !shouldSubmitOnEnter({
        key: keyEvent.key,
        shiftKey: keyEvent.shiftKey,
        ctrlKey: keyEvent.ctrlKey,
        altKey: keyEvent.altKey,
        metaKey: keyEvent.metaKey,
        isComposing,
      })
    ) {
      return;
    }
    keyEvent.preventDefault();
    trySubmit();
  });

  sendButton.addEventListener('click', () => {
    trySubmit();
  });
  // Stop doubles as the ask-user Cancel: whether this click aborts the turn or
  // dismisses the on-screen question (restoring the ordinary text field), the
  // keyboard must end up back in the prompt field so the user can type straight
  // away. The focus is applied here, after `onStop` has run, because that is
  // where `setInputRequest(undefined)` re-shows the field - focusing a still
  // `display: none` field would do nothing. Programmatic dismissals (the turn
  // ending on its own, a new session) do not go through this click handler, so
  // they never steal focus from elsewhere.
  stopButton.addEventListener('click', () => {
    const wasInInputMode = inputRequest !== undefined;
    callbacks.onStop();
    // Leaving a pending question (`setInputRequest(undefined)` inside `onStop`)
    // already restored and focused the field. But a held actions panel outlives
    // the click (the field is still hidden), so defer the focus to `exitInputMode`.
    if (wasInInputMode && inputRequest !== undefined) {
      focusFieldOnExit = true;
      return;
    }
    field.focus();
  });

  const actions = el('div', {
    attrs: { class: 'chat-composer__actions' },
    children: [actionButtons, sendButton, stopButton],
  });
  // The `/` autocomplete anchors here, not to `frame`: a zero-height marker at
  // the frame's top-left. Spectrum's flip then has somewhere on-screen to put
  // the list when it does not fit above - against the full-height empty-state
  // frame, "below" would land at the pane's bottom edge and vanish.
  const skillAnchor = el('span', {
    attrs: { class: 'chat-composer__skill-anchor', 'aria-hidden': 'true' },
  });
  // The interactive-question panel, hidden until `setInputRequest` shows a
  // question. Sits above the field so a free-input question reads
  // "question, then field".
  const frame = el('div', {
    attrs: { class: 'chat-composer__frame' },
    children: [skillAnchor, askPanel, field, actions],
  });
  const element = el('div', { attrs: { class: 'chat-composer' }, children: [frame] });

  /**
   * Runs the frame's attention flash, once, for a question that has just
   * appeared. The class is dropped by the listener below as soon as the fade
   * ends; removing it first and forcing a style flush means a question that
   * arrives before the previous flash has finished (the `/search` Load-more
   * loop can replace one question with the next in well under a second) still
   * replays it, instead of being coalesced into the running animation.
   */
  function flashAttention(): void {
    frame.classList.remove(ATTENTION_CLASS);
    void frame.offsetWidth;
    frame.classList.add(ATTENTION_CLASS);
  }

  frame.addEventListener('animationend', (event) => {
    if (event.animationName === ATTENTION_ANIMATION) {
      frame.classList.remove(ATTENTION_CLASS);
    }
  });

  // The `/` autocomplete popup, anchored to the marker. Undefined under jsdom
  // (Spectrum's overlay/popover tags are not registered there); the composer's
  // skill state is still maintained, it just has no popup to draw.
  const popover = createSkillPopover({
    onAccept: (index) => acceptSkillAt(index),
    getContainer: () => element.closest('sp-theme') ?? document.body,
  });

  // The empty-state field is stretched by CSS to the pane's height, which is
  // decided by layout the composer never sees (pane attach, split-view drag,
  // window resize). Re-run `autosize` whenever the field's box changes so the
  // shadow textarea keeps matching it. jsdom has no `ResizeObserver`; the
  // observer is simply absent there and the unit suite exercises the rest.
  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => autosize());
  resizeObserver?.observe(field);

  return {
    element,
    setButtonState(state) {
      current = state;
      // The held action panel is released the moment the turn stops being in
      // flight (`stop`): that is the loop ending (exhausted, or the user
      // cancelled) rather than another question coming. `stop` keeps the hold.
      if (holdingAnsweredActions && state.kind !== 'stop') {
        exitInputMode();
        return;
      }
      applyPresentation();
    },
    setConversationEmpty(empty) {
      conversationEmpty = empty;
      // Also set `rows` so the very first paint (before any `input`/autosize)
      // already has the right height; `autosize` then re-clamps on top. Its
      // derived line height is a ratio of the intrinsic rows-sized height, so
      // it is correct even while the shadow textarea still shows the old
      // `rows` (Lit applies that on its next update).
      field.setAttribute('rows', String(empty ? TEXTAREA_EMPTY_ROWS : TEXTAREA_ROWS));
      autosize();
    },
    setSkills(next) {
      skills = next;
      refreshSkillSuggestions();
    },
    setInputRequest(request) {
      if (request === undefined) {
        if (inputRequest === undefined) return;
        exitInputMode();
        return;
      }
      closeSkillMenu();
      // A new question supersedes any answered action panel still being held:
      // clear the hold and rebuild the controls (which re-enables the buttons).
      // The held panel answers a click the reader just made with their eyes
      // already on the actions row, and its replacement is the same one-row
      // strip, so the attention flash would be noise rather than a prompt - skip
      // it. A question that *appears over the text field* still flashes.
      const replacingHeldPanel = holdingAnsweredActions;
      holdingAnsweredActions = false;
      inputRequest = request;
      draft.freeform = '';
      draft.freeInputActive = request.options === undefined && !isActionsRequest(request);
      // The dropdown variants (>5 options) default to the first option, so the
      // control shows a value instead of a placeholder and Submit is enabled
      // from the start. The radio/checkbox lists stay unselected (they have no
      // placeholder to avoid).
      const dropdown =
        !draft.freeInputActive &&
        request.options !== undefined &&
        request.options.length > ASK_USER_DROPDOWN_THRESHOLD;
      // Actions and the >5-option dropdowns share the frame's "button strip"
      // look; the radio/checkbox variants keep the ordinary white input frame.
      frame.classList.toggle(STRIP_CLASS, isActionsRequest(request) || dropdown);
      const dropdownDefault = dropdown ? request.options?.[0] : undefined;
      draft.selections = dropdownDefault === undefined ? [] : [dropdownDefault];
      field.value = '';
      renderAskPanel();
      applyPresentation();
      if (!replacingHeldPanel) flashAttention();
      if (draft.freeInputActive) field.focus();
    },
    addInputActions(added) {
      const request = inputRequest;
      if (request === undefined || holdingAnsweredActions || !isActionsRequest(request)) return;
      const shown = request.actions ?? [];
      const fresh = added.filter((action) => !shown.includes(action));
      if (fresh.length === 0) return;
      inputRequest = { ...request, actions: [...shown, ...fresh] };
      actionButtons.append(...fresh.map(buildActionButton));
    },
    focus() {
      field.focus();
    },
    dispose() {
      disposeMultiOverlay();
      resizeObserver?.disconnect();
      popover?.dispose();
    },
  };
}
