import { el } from '../lib/dom';
import { loadComposerHistory, saveComposerHistory } from '../lib/composerHistoryStore';
import { createComposerHistoryNavigator, resolveCaretBounds } from './composerHistory';
import { type ComposerButtonState, shouldSubmitOnEnter } from './composerViewModel';
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
import type { AgentChatSkill } from '../../../shared';

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

export type ComposerSendOutcome = { readonly ok: true } | { readonly ok: false };

export interface ComposerCallbacks {
  /** Sends `prompt`. Resolves once main has accepted or rejected it - never rejects. */
  onSend(prompt: string): Promise<ComposerSendOutcome>;
  /** Requests the current in-flight turn be cancelled. */
  onStop(): void;
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
    },
  }) as TextFieldElement;

  const sendButton = el('sp-action-button', {
    attrs: { class: 'chat-composer__send', 'aria-label': 'Send' },
  });
  sendButton.append(el('sp-icon-send', { attrs: { slot: 'icon' } }));

  const stopButton = el('sp-action-button', {
    attrs: { class: 'chat-composer__stop', 'aria-label': 'Stop' },
  });
  stopButton.append(el('sp-icon-stop', { attrs: { slot: 'icon' } }));

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
      popover?.show(frame, skillMenu.suggestions, skillMenu.selectedIndex);
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
   * Enter is deliberately not consumed - it submits, exactly as it does with the
   * popup closed; Tab (and a click) is what accepts a suggestion.
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

  function applyPresentation(): void {
    const inFlight = current.kind === 'stop';
    sendButton.style.display = inFlight ? 'none' : '';
    stopButton.style.display = inFlight ? '' : 'none';
    sendButton.classList.toggle(SEND_ACCENT_CLASS, current.kind === 'send-enabled');

    switch (current.kind) {
      case 'connecting':
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
    if (current.kind !== 'send-enabled') return;
    const prompt = readValue().trim();
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
    // Escape/Tab before history recall or submission see them. Enter is left
    // alone, so it always submits - see `handleSkillMenuKey`.
    if (!isComposing && handleSkillMenuKey(keyEvent)) {
      keyEvent.preventDefault();
      return;
    }
    if (!isComposing && recallHistory(keyEvent)) {
      keyEvent.preventDefault();
      return;
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
  stopButton.addEventListener('click', () => {
    callbacks.onStop();
  });

  const actions = el('div', {
    attrs: { class: 'chat-composer__actions' },
    children: [sendButton, stopButton],
  });
  const frame = el('div', {
    attrs: { class: 'chat-composer__frame' },
    children: [field, actions],
  });
  const element = el('div', { attrs: { class: 'chat-composer' }, children: [frame] });

  // The `/` autocomplete popup, anchored above the frame. Undefined under jsdom
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
    dispose() {
      resizeObserver?.disconnect();
      popover?.dispose();
    },
  };
}
