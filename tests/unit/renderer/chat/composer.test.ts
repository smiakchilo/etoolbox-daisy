import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTENTION_ANIMATION,
  ATTENTION_CLASS,
  type Composer,
  createComposer,
  type ComposerSendOutcome,
  STRIP_CLASS,
} from '../../../../src/renderer/src/chat/composer';
import { STORAGE_KEY } from '../../../../src/renderer/src/lib/composerHistoryStore';
import { createWindowStorageInstaller, memoryStorage } from '../../../support/memoryStorage';

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
  it('shrinks the field from the empty height to the ordinary height once the conversation has content', () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    const field = query(composer.element, 'sp-textfield');
    const rows = (): number => Number(field.getAttribute('rows'));

    // A new composer starts on an empty conversation, so its field is taller.
    const emptyRows = rows();
    composer.setConversationEmpty(false);
    const ordinaryRows = rows();
    expect(ordinaryRows).toBeGreaterThan(0);
    expect(ordinaryRows).toBeLessThan(emptyRows);

    composer.setConversationEmpty(true);
    expect(rows()).toBe(emptyRows);
  });

  it('focus() puts the caret in the prompt field', () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    const field = query(composer.element, 'sp-textfield');
    const focusSpy = vi.spyOn(field, 'focus');

    composer.focus();

    expect(focusSpy).toHaveBeenCalledTimes(1);
    focusSpy.mockRestore();
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

  it("starts in the 'connecting' presentation with a disabled Send", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    const sendButton = query(composer.element, '.chat-composer__send');
    const stopButton = query(composer.element, '.chat-composer__stop');

    expect(isShown(sendButton)).toBe(true);
    expect(sendButton.hasAttribute('disabled')).toBe(true);
    expect(isShown(stopButton)).toBe(false);
  });

  it("shows an enabled Send button once told 'send-enabled'", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'send-enabled' });

    const sendButton = query(composer.element, '.chat-composer__send');
    const stopButton = query(composer.element, '.chat-composer__stop');
    expect(isShown(sendButton)).toBe(true);
    expect(sendButton.hasAttribute('disabled')).toBe(false);
    expect(isShown(stopButton)).toBe(false);
  });

  it("shows a disabled Send when 'send-disabled'", () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'send-disabled', reason: 'not_authenticated' });

    const sendButton = query(composer.element, '.chat-composer__send');
    expect(sendButton.hasAttribute('disabled')).toBe(true);
  });

  it('shows a disabled Send when no agent is active', () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'agent-inactive' });

    const sendButton = query(composer.element, '.chat-composer__send');
    expect(isShown(sendButton)).toBe(true);
    expect(sendButton.hasAttribute('disabled')).toBe(true);
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

  it('returns the keyboard to the field after a true Cancel (Stop) click', () => {
    const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
    composer.setButtonState({ kind: 'stop' });
    const field = query(composer.element, 'sp-textfield');
    const focusSpy = vi.spyOn(field, 'focus');

    query(composer.element, '.chat-composer__stop').click();

    expect(focusSpy).toHaveBeenCalledTimes(1);
    focusSpy.mockRestore();
  });

  it('returns the keyboard to the field when Cancel dismisses an ask-user question', () => {
    // The pane's `onStop` dismisses a pending question, which is what switches
    // the composer back to the ordinary text-input mode. The explicit type
    // annotation lets `onStop` refer to the composer it is being built into.
    const composer: Composer = createComposer({
      onSend: vi.fn(),
      onStop: () => composer.setInputRequest(undefined),
    });
    composer.setButtonState({ kind: 'stop' });
    composer.setInputRequest({
      question: 'Pick a colour',
      options: ['Red', 'Green'],
      multiple: false,
      freeInput: false,
    });
    const field = query(composer.element, 'sp-textfield');
    // The field starts hidden behind the option controls.
    expect(isShown(field)).toBe(false);
    const focusSpy = vi.spyOn(field, 'focus');

    query(composer.element, '.chat-composer__stop').click();

    // Back in text-input mode, and focused so the user can type straight away.
    expect(isShown(field)).toBe(true);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    focusSpy.mockRestore();
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
      const { field } = readyComposer(onSend);
      field.value = 'will fail';

      pressEnter(field);
      await Promise.resolve();
      await Promise.resolve();

      expect(field.value).toBe('will fail');
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
    const windowStorage = createWindowStorageInstaller();

    /** Installs a `window` whose `localStorage` is an in-memory stub, returning its backing map. */
    function installStorage(seed: Record<string, string> = {}): Record<string, string> {
      const storage = memoryStorage(seed);
      windowStorage.install(storage);
      return storage.values;
    }

    beforeEach(() => {
      installStorage();
    });

    afterEach(() => {
      windowStorage.restore();
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

    it('marks only the emphasized "Load all" action', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
      composer.setButtonState({ kind: 'stop' });
      composer.setInputRequest({
        actions: ['Load more', 'Load all'],
        multiple: false,
        freeInput: false,
      });

      const buttons = composer.element.querySelectorAll('.chat-ask__action');
      expect(buttons).toHaveLength(2);
      // The emphasized action is styled apart from the ordinary one.
      expect(buttons.item(1)?.className).not.toBe(buttons.item(0)?.className);
    });

    it('answers with the clicked label and holds the (disabled) panel until the turn ends', () => {
      const onAnswer = vi.fn();
      const composer = composerInActionsMode(onAnswer);

      composer.element
        .querySelectorAll('.chat-ask__action')
        .item(1)
        .dispatchEvent(new dom.window.MouseEvent('click'));

      expect(onAnswer).toHaveBeenCalledWith({ selections: ['Show more'], freeform: null });
      // The answered panel is held rather than flashing back to the (taller)
      // text field, which is the composer jump the Load-more loop showed. The
      // buttons are disabled so a second click cannot re-answer.
      expect(isShown(query(composer.element, 'sp-textfield'))).toBe(false);
      expect(query(composer.element, '.chat-ask__actions').hasAttribute('hidden')).toBe(false);
      for (const button of composer.element.querySelectorAll('.chat-ask__action')) {
        expect(button.hasAttribute('disabled')).toBe(true);
      }

      // Only when the turn leaves the in-flight state does the field return.
      composer.setButtonState({ kind: 'send-enabled' });
      expect(isShown(query(composer.element, 'sp-textfield'))).toBe(true);
      expect(query(composer.element, '.chat-ask__actions').hasAttribute('hidden')).toBe(true);
    });

    it('replaces the held panel in place when the next question arrives, without showing the field', () => {
      const onAnswer = vi.fn();
      const composer = composerInActionsMode(onAnswer);

      composer.element
        .querySelectorAll('.chat-ask__action')
        .item(0)
        .dispatchEvent(new dom.window.MouseEvent('click'));

      composer.setInputRequest({ actions: ['Load more'], multiple: false, freeInput: false });

      // The field never appeared, and the fresh question's button is enabled.
      expect(isShown(query(composer.element, 'sp-textfield'))).toBe(false);
      const buttons = composer.element.querySelectorAll('.chat-ask__action');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.textContent).toBe('Load more');
      expect(buttons[0]?.hasAttribute('disabled')).toBe(false);
    });

    it('focuses the field when Stop is clicked while the answered panel is held', () => {
      const onStop = vi.fn();
      const composer = createComposer({ onSend: vi.fn(), onStop });
      composer.setButtonState({ kind: 'stop' });
      composer.setInputRequest({ actions: ['Load more'], multiple: false, freeInput: false });
      composer.element
        .querySelectorAll('.chat-ask__action')
        .item(0)
        .dispatchEvent(new dom.window.MouseEvent('click'));

      const field = query(composer.element, 'sp-textfield');
      const focusSpy = vi.spyOn(field, 'focus');
      query(composer.element, '.chat-composer__stop').click();
      expect(onStop).toHaveBeenCalledTimes(1);
      // The panel is still held (the field is hidden), so focus is deferred.
      expect(focusSpy).not.toHaveBeenCalled();

      // The turn ends: the field returns and takes focus, so the user can type.
      composer.setButtonState({ kind: 'send-enabled' });
      expect(focusSpy).toHaveBeenCalledTimes(1);
      focusSpy.mockRestore();
    });
  });

  describe("the composer frame's button strip", () => {
    function frameOf(composer: Composer): HTMLElement {
      return query(composer.element, '.chat-composer__frame');
    }

    it('is worn by an actions question and a >5-option dropdown, but not the radio/checkbox lists', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
      const frame = frameOf(composer);
      expect(frame.classList.contains(STRIP_CLASS)).toBe(false);

      composer.setInputRequest({ actions: ['Refine'], multiple: false, freeInput: false });
      expect(frame.classList.contains(STRIP_CLASS)).toBe(true);

      composer.setInputRequest({
        question: 'Pick one',
        options: ['A', 'B', 'C', 'D', 'E', 'F'],
        multiple: false,
        freeInput: false,
      });
      expect(frame.classList.contains(STRIP_CLASS)).toBe(true);

      composer.setInputRequest({
        question: 'Pick a colour',
        options: ['Red', 'Green'],
        multiple: false,
        freeInput: false,
      });
      expect(frame.classList.contains(STRIP_CLASS)).toBe(false);
    });

    it('stays on when a dropdown question swaps to free input, and clears on dismissal', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
      const frame = frameOf(composer);
      composer.setInputRequest({
        question: 'Pick one',
        options: ['A', 'B', 'C', 'D', 'E', 'F'],
        multiple: false,
        freeInput: true,
      });
      expect(frame.classList.contains(STRIP_CLASS)).toBe(true);

      // "Type your own answer" hides the dropdown but the question is still the
      // same one, so the strip must not flip back to the white input frame.
      query(composer.element, '.chat-ask__free').click();
      expect(frame.classList.contains(STRIP_CLASS)).toBe(true);

      composer.setInputRequest(undefined);
      expect(frame.classList.contains(STRIP_CLASS)).toBe(false);
    });
  });

  describe('live-added actions', () => {
    const buttonLabels = (composer: Composer): (string | null)[] =>
      [...composer.element.querySelectorAll('.chat-ask__action')].map((b) => b.textContent);

    it('appends a button to the open actions question without flashing the frame', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn(), onAnswer: vi.fn() });
      composer.setButtonState({ kind: 'stop' });
      composer.setInputRequest({ actions: ['Load more'], multiple: false, freeInput: false });
      const frame = query(composer.element, '.chat-composer__frame');
      const flash = new dom.window.Event('animationend');
      Object.defineProperty(flash, 'animationName', { value: ATTENTION_ANIMATION });
      frame.dispatchEvent(flash);
      expect(frame.classList.contains(ATTENTION_CLASS)).toBe(false);

      composer.addInputActions(['Load all']);

      expect(buttonLabels(composer)).toEqual(['Load more', 'Load all']);
      expect(frame.classList.contains(ATTENTION_CLASS)).toBe(false);
    });

    it('does not duplicate an action the question already carries', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn(), onAnswer: vi.fn() });
      composer.setInputRequest({
        actions: ['Load more', 'Load all'],
        multiple: false,
        freeInput: false,
      });

      composer.addInputActions(['Load all']);
      composer.addInputActions(['Load more']);

      expect(buttonLabels(composer)).toEqual(['Load more', 'Load all']);
    });

    it('does nothing when there is no question', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn(), onAnswer: vi.fn() });

      composer.addInputActions(['Load all']);

      expect(buttonLabels(composer)).toEqual([]);
    });

    it('does nothing for a question that is not an actions question', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn(), onAnswer: vi.fn() });
      composer.setInputRequest({
        question: 'Pick a colour',
        options: ['Red', 'Green'],
        multiple: false,
        freeInput: false,
      });

      composer.addInputActions(['Load all']);

      expect(buttonLabels(composer)).toEqual([]);
    });

    it('does nothing while the answered panel is held', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn(), onAnswer: vi.fn() });
      composer.setButtonState({ kind: 'stop' });
      composer.setInputRequest({ actions: ['Load more'], multiple: false, freeInput: false });
      composer.element
        .querySelectorAll('.chat-ask__action')
        .item(0)
        .dispatchEvent(new dom.window.MouseEvent('click'));

      composer.addInputActions(['Load all']);

      expect(buttonLabels(composer)).toEqual(['Load more']);
    });

    it('answers with the added action when it is clicked', () => {
      const onAnswer = vi.fn();
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn(), onAnswer });
      composer.setButtonState({ kind: 'stop' });
      composer.setInputRequest({ actions: ['Load more'], multiple: false, freeInput: false });
      composer.addInputActions(['Load all']);

      composer.element
        .querySelectorAll('.chat-ask__action')
        .item(1)
        .dispatchEvent(new dom.window.MouseEvent('click'));

      expect(onAnswer).toHaveBeenCalledOnce();
      expect(JSON.stringify(onAnswer.mock.calls[0])).toContain('Load all');
    });
  });

  describe('the ask-user attention flash', () => {
    const FLASH_CLASS = ATTENTION_CLASS;

    function frameOf(composer: Composer): HTMLElement {
      return query(composer.element, '.chat-composer__frame');
    }

    function dropdownQuestion() {
      return {
        question: 'Pick one',
        options: ['A', 'B', 'C', 'D', 'E', 'F'],
        multiple: false,
        freeInput: false,
      };
    }

    /** Fires the frame's own fade's `animationend`, exactly as the browser does. */
    function endFlash(frame: HTMLElement): void {
      const event = new dom.window.Event('animationend');
      Object.defineProperty(event, 'animationName', { value: ATTENTION_ANIMATION });
      frame.dispatchEvent(event);
    }

    it('flashes when a question appears, and stops as soon as the fade ends', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
      const frame = frameOf(composer);
      expect(frame.classList.contains(FLASH_CLASS)).toBe(false);

      composer.setInputRequest({
        question: 'Pick a colour',
        options: ['Red', 'Green'],
        multiple: false,
        freeInput: false,
      });
      expect(frame.classList.contains(FLASH_CLASS)).toBe(true);

      endFlash(frame);
      expect(frame.classList.contains(FLASH_CLASS)).toBe(false);
    });

    it('does not replay on a repaint, but flashes again for the next question', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
      composer.setButtonState({ kind: 'stop' });
      const frame = frameOf(composer);
      const question = dropdownQuestion();

      composer.setInputRequest(question);
      endFlash(frame);
      expect(frame.classList.contains(FLASH_CLASS)).toBe(false);

      // The pane repaints on every event/status poll; none of that may re-flash.
      composer.setButtonState({ kind: 'stop' });
      expect(frame.classList.contains(FLASH_CLASS)).toBe(false);

      // A later question flashes afresh.
      composer.setInputRequest(question);
      expect(frame.classList.contains(FLASH_CLASS)).toBe(true);
    });

    it('flashes for an actions question, which has no option controls', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
      composer.setButtonState({ kind: 'stop' });

      composer.setInputRequest({ actions: ['Refine'], multiple: false, freeInput: false });

      expect(frameOf(composer).classList.contains(FLASH_CLASS)).toBe(true);
    });

    it('does not flash when the next question replaces a held answered action panel', () => {
      const composer = createComposer({
        onSend: vi.fn(),
        onStop: vi.fn(),
        onAnswer: vi.fn(),
      });
      composer.setButtonState({ kind: 'stop' });
      composer.setInputRequest({ actions: ['Load more'], multiple: false, freeInput: false });
      const frame = frameOf(composer);
      endFlash(frame);

      // Answer it: the panel is held, with the reader's eyes already on the row.
      composer.element
        .querySelectorAll('.chat-ask__action')
        .item(0)
        .dispatchEvent(new dom.window.MouseEvent('click'));

      // The loop's next question replaces the held panel in place: no flash.
      composer.setInputRequest({ actions: ['Load more'], multiple: false, freeInput: false });
      expect(frame.classList.contains(FLASH_CLASS)).toBe(false);
    });

    it('does not flash when the question is dismissed', () => {
      const composer = createComposer({ onSend: vi.fn(), onStop: vi.fn() });
      composer.setButtonState({ kind: 'stop' });
      composer.setInputRequest({ actions: ['Refine'], multiple: false, freeInput: false });
      const frame = frameOf(composer);
      endFlash(frame);

      composer.setInputRequest(undefined);

      expect(frame.classList.contains(FLASH_CLASS)).toBe(false);
    });
  });
});
