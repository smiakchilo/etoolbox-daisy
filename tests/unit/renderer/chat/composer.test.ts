import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Composer,
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
    expect(stopButton.querySelector('[slot="icon"]')?.tagName.toLowerCase()).toBe('sp-icon-cancel');
  });

  it('shrinks the field from the empty height to the ordinary height once the conversation has content', () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    const field = query(composer.element, 'sp-textfield');

    composer.setConversationEmpty(false);
    expect(field.getAttribute('rows')).toBe('4');

    composer.setConversationEmpty(true);
    expect(field.getAttribute('rows')).toBe('8');
  });

  describe('keeping the empty-state field stretched to the pane height', () => {
    const previousResizeObserver = Reflect.get(globalThis, 'ResizeObserver') as unknown;

    afterEach(() => {
      Reflect.set(globalThis, 'ResizeObserver', previousResizeObserver);
    });

    it('re-measures the field when its box changes, and disconnects on dispose', () => {
      const observe = vi.fn();
      const disconnect = vi.fn();
      // A layout-free stand-in: the composer only ever constructs, observes
      // and disconnects, so the callback itself is never invoked here.
      class FakeResizeObserver {
        observe(target: unknown): void {
          observe(target);
        }
        disconnect(): void {
          disconnect();
        }
      }
      Reflect.set(globalThis, 'ResizeObserver', FakeResizeObserver);

      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
      const field = query(composer.element, 'sp-textfield');

      expect(observe).toHaveBeenCalledWith(field);

      composer.dispose();
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('still builds and disposes when ResizeObserver is unavailable (as in jsdom)', () => {
      Reflect.deleteProperty(globalThis, 'ResizeObserver');

      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });

      expect(() => composer.dispose()).not.toThrow();
    });
  });

  it("starts in the 'connecting' presentation with a disabled Send and no message of its own", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    const sendButton = query(composer.element, '.chat-composer__send');
    const stopButton = query(composer.element, '.chat-composer__stop');

    expect(isShown(sendButton)).toBe(true);
    expect(sendButton.hasAttribute('disabled')).toBe(true);
    expect(isShown(stopButton)).toBe(false);
    // The composer no longer owns any message: "Connecting to agent..." is the
    // chat pane's banner (see `chatPane.test.ts`), not a composer notice.
    expect(composer.element.querySelector('.chat-composer__notice')).toBeNull();
  });

  it("shows an enabled Send button once told 'send-enabled'", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'send-enabled' });

    const sendButton = query(composer.element, '.chat-composer__send');
    const stopButton = query(composer.element, '.chat-composer__stop');
    expect(isShown(sendButton)).toBe(true);
    expect(sendButton.hasAttribute('disabled')).toBe(false);
    // The accent fill rides on this class; it is what makes the enabled state
    // visibly blue and every disabled state visibly grey.
    expect(sendButton.classList.contains('chat-composer__send--enabled')).toBe(true);
    expect(isShown(stopButton)).toBe(false);
  });

  it("shows a disabled Send (no accent fill) when 'send-disabled'", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'send-disabled', reason: 'not_authenticated' });

    const sendButton = query(composer.element, '.chat-composer__send');
    expect(sendButton.hasAttribute('disabled')).toBe(true);
    expect(sendButton.classList.contains('chat-composer__send--enabled')).toBe(false);
  });

  it('shows a disabled, silent Send (no accent fill) when no agent is active', () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'agent-inactive' });

    const sendButton = query(composer.element, '.chat-composer__send');
    expect(isShown(sendButton)).toBe(true);
    expect(sendButton.hasAttribute('disabled')).toBe(true);
    expect(sendButton.classList.contains('chat-composer__send--enabled')).toBe(false);
    // The chat pane's own banner carries the wording; the composer holds no
    // message element at all.
    expect(composer.element.querySelector('.chat-composer__notice')).toBeNull();
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

    it('restores the previous text when onSend resolves not-ok, leaving the message to the banner', async () => {
      const onSend = vi.fn().mockResolvedValue({ ok: false } satisfies ComposerSendOutcome);
      const { composer, field } = readyComposer(onSend);
      field.value = 'will fail';

      pressEnter(field);
      await Promise.resolve();
      await Promise.resolve();

      expect(field.value).toBe('will fail');
      // The failure message is the chat pane's banner; the composer carries no
      // notice to duplicate it.
      expect(composer.element.querySelector('.chat-composer__notice')).toBeNull();
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

  describe('skill autocomplete', () => {
    const SKILLS = [
      { name: 'search', description: 'Search.' },
      { name: 'semantic-search', description: 'Semantic search.' },
    ];

    /** Supplies the catalogue and types `value` into the field. */
    function withSkills(composer: Composer, field: TextFieldElement, value: string): void {
      composer.setSkills(SKILLS);
      field.value = value;
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }

    it('accepts the highlighted suggestion on Enter instead of submitting the token', () => {
      const onSend = vi.fn();
      const { composer, field } = readyComposer(onSend);
      withSkills(composer, field, '/s');

      const event = new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(field.value).toBe('/search ');
      expect(onSend).not.toHaveBeenCalled();
    });

    it('submits on the Enter after an accept, once the menu has closed', async () => {
      const onSend = vi.fn().mockResolvedValue({ ok: true } satisfies ComposerSendOutcome);
      const { composer, field } = readyComposer(onSend);
      withSkills(composer, field, '/s');

      pressEnter(field);
      expect(field.value).toBe('/search ');
      expect(onSend).not.toHaveBeenCalled();

      // The inserted name plus its trailing space closes the menu, so the next
      // Enter submits the (now complete) prompt as it always did.
      pressEnter(field);
      await Promise.resolve();
      await Promise.resolve();
      expect(onSend).toHaveBeenCalledWith('/search');
    });

    it('still submits on Enter when the field is not a skill token', () => {
      const onSend = vi.fn().mockResolvedValue({ ok: true } satisfies ComposerSendOutcome);
      const { composer, field } = readyComposer(onSend);
      withSkills(composer, field, 'plain message');

      pressEnter(field);

      expect(onSend).toHaveBeenCalledWith('plain message');
    });
  });

  describe('prompt history recall', () => {
    const STORAGE_KEY = 'daisy.chat.composerHistory';
    const previousWindow = Reflect.get(globalThis, 'window') as unknown;

    interface StubStorage {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
    }

    /** Installs a `window` whose `localStorage` is an in-memory stub, returning its backing map. */
    function installStorage(seed: Record<string, string> = {}): Record<string, string> {
      const values: Record<string, string> = { ...seed };
      const storage: StubStorage = {
        getItem: (key) => values[key] ?? null,
        setItem: (key, value) => {
          values[key] = value;
        },
      };
      Reflect.set(globalThis, 'window', { localStorage: storage });
      return values;
    }

    beforeEach(() => {
      installStorage();
    });

    afterEach(() => {
      Reflect.set(globalThis, 'window', previousWindow);
    });

    function arrowEvent(
      key: 'ArrowUp' | 'ArrowDown',
      options: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {},
    ): InstanceType<typeof dom.window.KeyboardEvent> {
      return new dom.window.KeyboardEvent('keydown', {
        key,
        shiftKey: options.shiftKey ?? false,
        ctrlKey: options.ctrlKey ?? false,
        altKey: options.altKey ?? false,
        metaKey: options.metaKey ?? false,
        bubbles: true,
        cancelable: true,
      });
    }

    interface StubTextarea {
      selectionStart: number;
      selectionEnd: number;
      readonly style: Record<string, string>;
      readonly rows: number;
      readonly clientHeight: number;
      readonly scrollHeight: number;
      setSelectionRange(start: number, end: number): void;
    }

    /**
     * jsdom does not upgrade `sp-textfield`, so there is no shadow `<textarea>`
     * to read a caret from. Installing one lets the caret-sensitive branches be
     * exercised; `autosize` bails on the zero-height metrics.
     */
    function stubShadowTextarea(
      field: HTMLElement,
      caret: { readonly start?: number; readonly end?: number } = {},
    ): StubTextarea {
      const textarea: StubTextarea = {
        selectionStart: caret.start ?? 0,
        selectionEnd: caret.end ?? 0,
        style: {},
        rows: 4,
        clientHeight: 0,
        scrollHeight: 0,
        setSelectionRange(start: number, end: number): void {
          textarea.selectionStart = start;
          textarea.selectionEnd = end;
        },
      };
      Object.defineProperty(field, 'shadowRoot', {
        configurable: true,
        value: { querySelector: (selector: string) => (selector === 'textarea' ? textarea : null) },
      });
      return textarea;
    }

    it('recalls the newest stored prompt on Up from an empty field, then walks older', () => {
      installStorage({ [STORAGE_KEY]: JSON.stringify(['older', 'newest']) });
      const { field } = readyComposer();

      field.dispatchEvent(arrowEvent('ArrowUp'));
      expect(field.value).toBe('newest');

      field.dispatchEvent(arrowEvent('ArrowUp'));
      expect(field.value).toBe('older');
    });

    it('restores the draft on Down once past the newest prompt', () => {
      installStorage({ [STORAGE_KEY]: JSON.stringify(['older', 'newest']) });
      const { field } = readyComposer();
      const textarea = stubShadowTextarea(field, { start: 0, end: 0 });
      field.value = 'my draft';

      field.dispatchEvent(arrowEvent('ArrowUp'));
      expect(field.value).toBe('newest');
      // The caret lands at the end of a recalled prompt.
      expect(textarea.selectionStart).toBe('newest'.length);

      field.dispatchEvent(arrowEvent('ArrowDown'));
      expect(field.value).toBe('my draft');
    });

    it('leaves Up alone while the caret is inside a non-empty draft', () => {
      installStorage({ [STORAGE_KEY]: JSON.stringify(['stored']) });
      const { field } = readyComposer();
      stubShadowTextarea(field, { start: 3, end: 3 });
      field.value = 'my draft';

      const event = arrowEvent('ArrowUp');
      field.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(field.value).toBe('my draft');
    });

    it('does not consume Down at the draft position', () => {
      installStorage({ [STORAGE_KEY]: JSON.stringify(['stored']) });
      const { field } = readyComposer();
      field.value = '';

      const event = arrowEvent('ArrowDown');
      field.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(field.value).toBe('');
    });

    it('ignores a modified arrow key', () => {
      installStorage({ [STORAGE_KEY]: JSON.stringify(['stored']) });
      const { field } = readyComposer();
      field.value = '';

      for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
        const event = arrowEvent('ArrowUp', {
          shiftKey: modifier === 'shiftKey',
          ctrlKey: modifier === 'ctrlKey',
          altKey: modifier === 'altKey',
          metaKey: modifier === 'metaKey',
        });
        field.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(field.value).toBe('');
    });

    it('does not recall while an IME composition is open', () => {
      installStorage({ [STORAGE_KEY]: JSON.stringify(['stored']) });
      const { field } = readyComposer();
      field.value = '';
      field.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));

      const event = arrowEvent('ArrowUp');
      field.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(field.value).toBe('');
    });

    it('records an accepted prompt and recalls it', async () => {
      const storage = installStorage();
      const onSend = vi.fn().mockResolvedValue({ ok: true } satisfies ComposerSendOutcome);
      const { field } = readyComposer(onSend);
      field.value = 'remember me';

      pressEnter(field);
      await Promise.resolve();
      await Promise.resolve();

      expect(JSON.parse(storage[STORAGE_KEY] ?? '[]')).toEqual(['remember me']);

      field.dispatchEvent(arrowEvent('ArrowUp'));
      expect(field.value).toBe('remember me');
    });

    it('does not record a rejected prompt', async () => {
      const storage = installStorage();
      const onSend = vi.fn().mockResolvedValue({ ok: false } satisfies ComposerSendOutcome);
      const { field } = readyComposer(onSend);
      field.value = 'will fail';

      pressEnter(field);
      await Promise.resolve();
      await Promise.resolve();

      expect(storage[STORAGE_KEY]).toBeUndefined();
    });

    it('loads the history persisted by a previous run', () => {
      installStorage({ [STORAGE_KEY]: JSON.stringify(['from a previous run']) });
      const { field } = readyComposer();

      field.dispatchEvent(arrowEvent('ArrowUp'));

      expect(field.value).toBe('from a previous run');
    });

    it('abandons a walk in progress as soon as the user edits the field', () => {
      installStorage({ [STORAGE_KEY]: JSON.stringify(['older', 'newest']) });
      const { field } = readyComposer();
      stubShadowTextarea(field, { start: 0, end: 0 });

      field.dispatchEvent(arrowEvent('ArrowUp'));
      expect(field.value).toBe('newest');

      // Typing resets the walk; a following Down must not snap back to the draft.
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      const event = arrowEvent('ArrowDown');
      field.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(field.value).toBe('newest');
    });
  });

  describe('an ask-user actions prompt', () => {
    function composerInActionsMode(onAnswer: () => void): Composer {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn(), onAnswer });
      // A question is only ever asked mid-turn, so the composer is in "stop".
      composer.setButtonState({ kind: 'stop' });
      composer.setInputRequest({
        actions: ['Refine', 'Show more'],
        multiple: false,
        freeInput: false,
      });
      return composer;
    }

    it('shows one button per action, in the action row beside Cancel, with no caption', () => {
      const composer = composerInActionsMode(vi.fn());

      const actionsRow = query(composer.element, '.chat-ask__actions');
      expect(actionsRow.hasAttribute('hidden')).toBe(false);
      const buttons = composer.element.querySelectorAll('.chat-ask__action');
      expect(buttons).toHaveLength(2);
      expect(buttons[0]?.textContent).toBe('Refine');
      expect(buttons[1]?.textContent).toBe('Show more');

      // The buttons share the composer's action row with Cancel (the Stop
      // control), so all buttons sit on one line.
      const row = query(composer.element, '.chat-composer__actions');
      expect(row.contains(actionsRow)).toBe(true);
      expect(row.contains(query(composer.element, '.chat-composer__stop'))).toBe(true);

      // Actions are captionless: the ask panel is hidden and paints no question.
      const askPanel = query(composer.element, '.chat-ask');
      expect(askPanel.hasAttribute('hidden')).toBe(true);
      expect(composer.element.querySelector('.chat-ask__question')).toBeNull();

      // The text field and Send are hidden; Cancel (Stop) stays available.
      expect(isShown(query(composer.element, 'sp-textfield'))).toBe(false);
      expect(isShown(query(composer.element, '.chat-composer__send'))).toBe(false);
      expect(isShown(query(composer.element, '.chat-composer__stop'))).toBe(true);
    });

    it('answers with the clicked label and leaves the interactive UI', () => {
      const onAnswer = vi.fn();
      const composer = composerInActionsMode(onAnswer);

      composer.element
        .querySelectorAll('.chat-ask__action')
        .item(1)
        .dispatchEvent(new dom.window.MouseEvent('click'));

      expect(onAnswer).toHaveBeenCalledWith({ selections: ['Show more'], freeform: null });
      // A click leaves the interactive UI: the field returns, the buttons go.
      expect(isShown(query(composer.element, 'sp-textfield'))).toBe(true);
      expect(query(composer.element, '.chat-ask__actions').hasAttribute('hidden')).toBe(true);
    });
  });
});
