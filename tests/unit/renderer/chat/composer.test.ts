import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createComposer,
  type ComposerSendOutcome,
} from '../../../../src/renderer/src/chat/composer';

// `composer.ts` builds its DOM through `lib/dom.ts`'s `el()` helper, which
// reaches for the ambient global `document` (unlike `renderMarkdown.ts`,
// which takes its `Window` as an explicit parameter - see that module's own
// test for why). Installing a jsdom document onto `globalThis` for the
// duration of this suite is what makes exercising the real event-listener
// wiring (not just `composerViewModel.ts`'s pure functions, already covered
// by their own test) possible without an Electron renderer.
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM();
  globalThis.document = dom.window.document;
});

afterEach(() => {
  dom.window.close();
});

type TextFieldElement = HTMLElement & { value: string };

function query(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector(selector);
  if (found === null) throw new Error(`expected to find "${selector}"`);
  return found as HTMLElement;
}

function pressEnter(
  field: HTMLElement,
  options: {
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    isComposing?: boolean;
  } = {},
): void {
  field.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: options.shiftKey ?? false,
      ctrlKey: options.ctrlKey ?? false,
      altKey: options.altKey ?? false,
      metaKey: options.metaKey ?? false,
      isComposing: options.isComposing ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function isShown(element: HTMLElement): boolean {
  return element.style.display !== 'none';
}

/** Builds a composer already told it may send, with its field handle exposed. */
function readyComposer(onSend = vi.fn<(prompt: string) => Promise<ComposerSendOutcome>>()) {
  const composer = createComposer({ onSend, onStop: vi.fn() });
  composer.setButtonState({ kind: 'send-enabled' });
  const field = query(composer.element, 'sp-textfield') as TextFieldElement;
  return { composer, onSend, field };
}

describe('createComposer', () => {
  it('builds a borderless field inside a frame, with normal Send and Stop action buttons', () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });

    const frame = query(composer.element, '.chat-composer__frame');
    const field = query(composer.element, 'sp-textfield');
    const sendButton = query(composer.element, '.chat-composer__send');
    const stopButton = query(composer.element, '.chat-composer__stop');

    // A new composer starts on an empty conversation, so its field is taller.
    expect(field.getAttribute('rows')).toBe('8');
    expect(field.hasAttribute('multiline')).toBe(true);
    expect(field.getAttribute('placeholder')).toBe('Type your message or command here');
    expect(field.classList.contains('chat-composer__field')).toBe(true);
    expect(frame.contains(sendButton)).toBe(true);
    expect(frame.contains(stopButton)).toBe(true);
    expect(sendButton.tagName.toLowerCase()).toBe('sp-action-button');
    expect(sendButton.hasAttribute('icon-only')).toBe(false);
    expect(sendButton.getAttribute('aria-label')).toBe('Send');
    expect(sendButton.querySelector('sp-icon-send')).not.toBeNull();
    expect(stopButton.tagName.toLowerCase()).toBe('sp-action-button');
    expect(stopButton.hasAttribute('icon-only')).toBe(false);
    expect(stopButton.getAttribute('aria-label')).toBe('Stop');
    expect(stopButton.querySelector('sp-icon-stop')).not.toBeNull();
  });

  it('shrinks the field from the empty height to the ordinary height once the conversation has content', () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    const field = query(composer.element, 'sp-textfield');

    composer.setConversationEmpty(false);
    expect(field.getAttribute('rows')).toBe('4');

    composer.setConversationEmpty(true);
    expect(field.getAttribute('rows')).toBe('8');
  });

  it("starts in the 'connecting' presentation: disabled Send and honest notice", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    const sendButton = query(composer.element, '.chat-composer__send');
    const stopButton = query(composer.element, '.chat-composer__stop');
    const notice = query(composer.element, '.chat-composer__notice');

    expect(isShown(sendButton)).toBe(true);
    expect(sendButton.hasAttribute('disabled')).toBe(true);
    expect(isShown(stopButton)).toBe(false);
    expect(notice.textContent).toBe('Connecting to Copilot...');
  });

  it("does not present 'connecting' as 'not authenticated': the notice text is distinct", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    const notice = query(composer.element, '.chat-composer__notice');
    expect(notice.textContent).not.toMatch(/sign in/i);
  });

  it("shows an enabled Send button and empty notice once told 'send-enabled'", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'send-enabled' });

    const sendButton = query(composer.element, '.chat-composer__send');
    const stopButton = query(composer.element, '.chat-composer__stop');
    const notice = query(composer.element, '.chat-composer__notice');
    expect(isShown(sendButton)).toBe(true);
    expect(sendButton.hasAttribute('disabled')).toBe(false);
    expect(isShown(stopButton)).toBe(false);
    expect(notice.textContent).toBe('');
  });

  it("shows a disabled Send with the reason's text when 'send-disabled'", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'send-disabled', reason: 'not_authenticated' });

    const sendButton = query(composer.element, '.chat-composer__send');
    const notice = query(composer.element, '.chat-composer__notice');
    expect(sendButton.hasAttribute('disabled')).toBe(true);
    expect(notice.textContent).toBe('Sign in to Copilot to send a message.');
  });

  it('swaps to the enabled Stop control (and hides Send) when a turn is in flight', () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'stop' });

    const sendButton = query(composer.element, '.chat-composer__send');
    const stopButton = query(composer.element, '.chat-composer__stop');
    expect(isShown(sendButton)).toBe(false);
    expect(isShown(stopButton)).toBe(true);
    expect(stopButton.hasAttribute('disabled')).toBe(false);
  });

  it("calls onStop, not onSend, when the Stop control is clicked in the 'stop' state", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const composer = createComposer({ onSend, onStop });
    composer.setButtonState({ kind: 'stop' });

    query(composer.element, '.chat-composer__stop').click();

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  describe('submitting a prompt', () => {
    it('submits the trimmed field text on a plain Enter and clears the field', async () => {
      const onSend = vi.fn().mockResolvedValue({ ok: true } satisfies ComposerSendOutcome);
      const { field } = readyComposer(onSend);
      field.value = '  hello there  ';

      pressEnter(field);
      await Promise.resolve();

      expect(onSend).toHaveBeenCalledWith('hello there');
      expect(field.value).toBe('');
    });

    it('submits on a Send button click too', async () => {
      const onSend = vi.fn().mockResolvedValue({ ok: true } satisfies ComposerSendOutcome);
      const { composer, field } = readyComposer(onSend);
      field.value = 'click to send';

      query(composer.element, '.chat-composer__send').click();
      await Promise.resolve();

      expect(onSend).toHaveBeenCalledWith('click to send');
    });

    it('does not submit for a blank or whitespace-only prompt', () => {
      const onSend = vi.fn();
      const { field } = readyComposer(onSend);

      pressEnter(field);

      expect(onSend).not.toHaveBeenCalled();
    });

    it('does not submit on a modified Enter (Shift/Ctrl/Alt/Meta all insert a newline)', () => {
      const onSend = vi.fn();
      const { field } = readyComposer(onSend);
      field.value = 'line one';

      pressEnter(field, { shiftKey: true });
      pressEnter(field, { ctrlKey: true });
      pressEnter(field, { altKey: true });
      pressEnter(field, { metaKey: true });

      expect(onSend).not.toHaveBeenCalled();
    });

    it('restores the previous text and shows the failure message when onSend resolves not-ok', async () => {
      const onSend = vi.fn().mockResolvedValue({
        ok: false,
        message: 'The turn is already in progress.',
      } satisfies ComposerSendOutcome);
      const { composer, field } = readyComposer(onSend);
      field.value = 'will fail';

      pressEnter(field);
      await Promise.resolve();
      await Promise.resolve();

      expect(field.value).toBe('will fail');
      const notice = query(composer.element, '.chat-composer__notice');
      expect(notice.textContent).toBe('The turn is already in progress.');
    });

    describe('IME composition must never accidentally submit', () => {
      it('does not submit an Enter fired while a composition has not yet been closed by compositionend', async () => {
        const onSend = vi.fn();
        const { field } = readyComposer(onSend);
        field.value = '\u3053\u3093\u306b\u3061\u306f';

        field.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));
        pressEnter(field);
        await Promise.resolve();

        expect(onSend).not.toHaveBeenCalled();
      });

      it('submits normally once compositionend has closed the IME session', async () => {
        const onSend = vi.fn().mockResolvedValue({ ok: true } satisfies ComposerSendOutcome);
        const { field } = readyComposer(onSend);
        field.value = 'finished composing';

        field.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));
        field.dispatchEvent(new dom.window.Event('compositionend', { bubbles: true }));
        pressEnter(field);
        await Promise.resolve();

        expect(onSend).toHaveBeenCalledWith('finished composing');
      });

      it("also honours a keydown event's own isComposing flag, independent of composition events", async () => {
        const onSend = vi.fn();
        const { field } = readyComposer(onSend);
        field.value = 'should not send';

        pressEnter(field, { isComposing: true });
        await Promise.resolve();

        expect(onSend).not.toHaveBeenCalled();
      });
    });

    describe('a second submit cannot fire over an unfinished one', () => {
      it('ignores a second Send click while the first onSend promise has not yet resolved', async () => {
        let resolveFirst: ((outcome: ComposerSendOutcome) => void) | undefined;
        const onSend = vi.fn(
          () =>
            new Promise<ComposerSendOutcome>((resolve) => {
              resolveFirst = resolve;
            }),
        );
        const { composer, field } = readyComposer(onSend);
        field.value = 'first';

        const sendButton = query(composer.element, '.chat-composer__send');
        sendButton.click();
        // The field was cleared by the first submit; simulate the user
        // typing again before the first call has resolved.
        field.value = 'second, typed while the first is still in flight';
        sendButton.click();

        expect(onSend).toHaveBeenCalledTimes(1);

        resolveFirst?.({ ok: true });
        await Promise.resolve();
      });
    });
  });
});
