import { el } from '../lib/dom';
import {
  describeCanSendBlockReason,
  shouldSubmitOnEnter,
  type ComposerButtonState,
} from './composerViewModel';

type TextFieldElement = HTMLElement & { value: string };

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
}

/**
 * The chat composer: a multiline prompt field plus one Send/Stop button.
 * All enable/disable and Send-vs-Stop decisions are made by
 * `computeComposerButtonState` (`composerViewModel.ts`) and handed in via
 * `setButtonState` - this module only ever presents whatever state it is
 * given, and never re-derives it.
 */
export function createComposer(callbacks: ComposerCallbacks): Composer {
  const field = el('sp-textfield', {
    attrs: {
      multiline: '',
      grows: '',
      placeholder: 'Message Copilot...',
      'aria-label': 'Message',
    },
  }) as TextFieldElement;

  const sendButton = el('sp-button', { attrs: { variant: 'accent' }, text: 'Send' });
  const spinner = el('sp-progress-circle', {
    attrs: { indeterminate: '', size: 's', label: 'Connecting to Copilot' },
  });
  const notice = el('p', { attrs: { class: 'chat-composer__notice' } });

  let current: ComposerButtonState = { kind: 'connecting' };
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
    switch (current.kind) {
      case 'connecting':
        sendButton.textContent = 'Send';
        sendButton.setAttribute('disabled', '');
        spinner.hidden = false;
        notice.textContent = 'Connecting to Copilot...';
        return;
      case 'stop':
        sendButton.textContent = 'Stop';
        sendButton.removeAttribute('disabled');
        spinner.hidden = true;
        notice.textContent = '';
        return;
      case 'send-enabled':
        sendButton.textContent = 'Send';
        sendButton.removeAttribute('disabled');
        spinner.hidden = true;
        notice.textContent = '';
        return;
      case 'send-disabled':
        sendButton.textContent = 'Send';
        sendButton.setAttribute('disabled', '');
        spinner.hidden = true;
        notice.textContent = describeCanSendBlockReason(current.reason);
        return;
      default: {
        const exhaustive: never = current;
        return exhaustive;
      }
    }
  }
  applyPresentation();

  function trySubmit(): void {
    if (submitting) return;
    if (current.kind !== 'send-enabled') return;
    const prompt = field.value.trim();
    if (prompt === '') return;

    submitting = true;
    const previousValue = field.value;
    field.value = '';
    notice.textContent = '';
    void callbacks
      .onSend(prompt)
      .then((outcome) => {
        if (!outcome.ok) {
          field.value = previousValue;
          notice.textContent = outcome.message;
        }
      })
      .finally(() => {
        submitting = false;
      });
  }

  field.addEventListener('compositionstart', () => {
    composing = true;
  });
  field.addEventListener('compositionend', () => {
    composing = false;
  });
  field.addEventListener('keydown', (keyEvent) => {
    const isComposing = composing || keyEvent.isComposing;
    if (!shouldSubmitOnEnter({ key: keyEvent.key, shiftKey: keyEvent.shiftKey, isComposing })) {
      return;
    }
    keyEvent.preventDefault();
    trySubmit();
  });

  sendButton.addEventListener('click', () => {
    if (current.kind === 'stop') {
      callbacks.onStop();
      return;
    }
    trySubmit();
  });

  const row = el('div', {
    attrs: { class: 'chat-composer__row' },
    children: [field, spinner, sendButton],
  });
  const element = el('div', { attrs: { class: 'chat-composer' }, children: [row, notice] });

  return {
    element,
    setButtonState(state) {
      current = state;
      applyPresentation();
    },
  };
}
