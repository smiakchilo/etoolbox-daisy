import { el } from '../lib/dom';
import {
  type ComposerButtonState,
  describeCanSendBlockReason,
  shouldSubmitOnEnter,
} from './composerViewModel';

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

export type ComposerSendOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface ComposerCallbacks {
  /** Sends `prompt`. Resolves once main has accepted or rejected it - never rejects. */
  onSend(prompt: string): Promise<ComposerSendOutcome>;
  /** Requests the current in-flight turn be cancelled. */
  onStop(): void;
}

export interface Composer {
  readonly element: HTMLElement;
  /** Applies the latest computed button/notice state - see `composerViewModel.ts`. */
  setButtonState(state: ComposerButtonState): void;
  /**
   * Tells the composer whether the conversation has any content yet. While
   * empty the field is stretched to the pane's full height; the caller is
   * responsible for the pane-level layout that gives it that height (see
   * `chatPane.ts` / `chat.css`).
   */
  setConversationEmpty(empty: boolean): void;
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

  const notice = el('p', { attrs: { class: 'chat-composer__notice' } });

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

  function applyPresentation(): void {
    const inFlight = current.kind === 'stop';
    sendButton.style.display = inFlight ? 'none' : '';
    stopButton.style.display = inFlight ? '' : 'none';
    sendButton.classList.toggle(SEND_ACCENT_CLASS, current.kind === 'send-enabled');

    switch (current.kind) {
      case 'connecting':
        sendButton.setAttribute('disabled', '');
        notice.textContent = 'Connecting to Copilot...';
        return;
      case 'stop':
        stopButton.removeAttribute('disabled');
        notice.textContent = '';
        return;
      case 'send-enabled':
        sendButton.removeAttribute('disabled');
        notice.textContent = '';
        return;
      case 'send-disabled':
        sendButton.setAttribute('disabled', '');
        notice.textContent = describeCanSendBlockReason(current.reason);
        return;
      case 'agent-inactive':
        // The chat pane's own banner carries the explanation; the composer
        // stays silent so the two do not say the same thing twice.
        sendButton.setAttribute('disabled', '');
        notice.textContent = '';
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
    const prompt = field.value.trim();
    if (prompt === '') return;

    submitting = true;
    const previousValue = field.value;
    field.value = '';
    autosize();
    notice.textContent = '';
    void callbacks
      .onSend(prompt)
      .then((outcome) => {
        if (!outcome.ok) {
          field.value = previousValue;
          autosize();
          notice.textContent = outcome.message;
        }
      })
      .finally(() => {
        submitting = false;
      });
  }

  field.addEventListener('input', autosize);
  field.addEventListener('compositionstart', () => {
    composing = true;
  });
  field.addEventListener('compositionend', () => {
    composing = false;
  });
  field.addEventListener('keydown', (keyEvent) => {
    const isComposing = composing || keyEvent.isComposing;
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
  const element = el('div', { attrs: { class: 'chat-composer' }, children: [frame, notice] });

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
    dispose() {
      resizeObserver?.disconnect();
    },
  };
}
