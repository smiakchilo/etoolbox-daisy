import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  agentEventSchema,
  chatIdSchema,
  messageIdSchema,
  reasoningIdSchema,
  requestIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type MessageId,
  type ReasoningId,
  type ToolCallId,
  type TurnId,
} from '../../../../src/shared';
import { createTranscriptStore } from '../../../../src/renderer/src/chat/transcriptStore';
import { createTranscriptView } from '../../../../src/renderer/src/chat/transcriptView';
import { createMarkdownRenderer } from '../../../../src/renderer/src/chat/renderMarkdown';
import type { LinkContext } from '../../../../src/renderer/src/chat/linkTargets';
import { parseLinkActions } from '../../../../src/renderer/src/chat/linkTargets';

/** The stamped popover actions as `{ id, href }`; the visible titles are production copy. */
function actionsOf(element: Element | null | undefined): { id: string; href: string }[] {
  return parseLinkActions(element?.getAttribute('data-daisy-actions') ?? null).map(
    ({ id, href }) => ({ id, href }),
  );
}

// See `composer.test.ts` for why a jsdom document is installed onto
// `globalThis`: `transcriptView.ts` builds its DOM through the same `el()`
// helper. `createMarkdownRenderer`, by contrast, takes its `Window`
// explicitly (see that module's own test), so it is constructed directly
// from `dom.window` rather than relying on the global installed here.
const dom = new JSDOM('', { url: 'http://localhost' });
globalThis.document = dom.window.document;
const markdownRenderer = createMarkdownRenderer(
  dom.window as unknown as Window & typeof globalThis,
);

const chatId = chatIdSchema.parse('chat-1');
const turnId: TurnId = turnIdSchema.parse('turn-1');
const messageId: MessageId = messageIdSchema.parse('msg-1');
const toolCallId: ToolCallId = toolCallIdSchema.parse('call-1');
const reasoningId: ReasoningId = reasoningIdSchema.parse('reason-1');
const requestId = requestIdSchema.parse('req-1');

function delta(sequence: number, text: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.text.delta',
    chatId,
    sequence,
    turnId,
    messageId,
    delta: text,
  });
}

function messageStarted(sequence: number): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.message.started',
    chatId,
    sequence,
    turnId,
    messageId,
  });
}

function completed(sequence: number, content: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.message.completed',
    chatId,
    sequence,
    turnId,
    messageId,
    content,
  });
}

function reasoningDelta(sequence: number, deltaText: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.reasoning.delta',
    chatId,
    sequence,
    turnId,
    reasoningId,
    delta: deltaText,
  });
}

function reasoningCompleted(sequence: number, content: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.reasoning.completed',
    chatId,
    sequence,
    turnId,
    reasoningId,
    content,
  });
}

function toolRequested(sequence: number, toolName = 'aem_get_json'): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.requested',
    chatId,
    sequence,
    toolCallId,
    toolName,
    arguments: {},
  });
}

function toolApproved(sequence: number): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.approved',
    chatId,
    sequence,
    toolCallId,
  });
}

function toolRejected(sequence: number, reason: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.rejected',
    chatId,
    sequence,
    toolCallId,
    reason,
  });
}

function toolRequestedWithArgs(
  sequence: number,
  toolName: string,
  args: Record<string, unknown>,
): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.requested',
    chatId,
    sequence,
    toolCallId,
    toolName,
    arguments: args,
  });
}

function toolProgress(sequence: number, text: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.progress',
    chatId,
    sequence,
    toolCallId,
    text,
  });
}

function toolResult(sequence: number, ok: boolean): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.result',
    chatId,
    sequence,
    toolCallId,
    outcome: ok
      ? { ok: true, data: null }
      : {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: 'The requested page does not exist.',
            requestId,
            retryable: false,
            requiredAction: 'sign_in_to_host',
          },
        },
  });
}

/** A tool call with its own id, for scenarios with more than one billet. */
function toolRequestedAs(sequence: number, id: string, toolName = 'aem_get_json'): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.requested',
    chatId,
    sequence,
    toolCallId: toolCallIdSchema.parse(id),
    toolName,
    arguments: {},
  });
}

/** A successful result for a call created by {@link toolRequestedAs}. */
function toolResultAs(sequence: number, id: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.result',
    chatId,
    sequence,
    toolCallId: toolCallIdSchema.parse(id),
    outcome: { ok: true, data: null },
  });
}

function clickElement(target: Element): void {
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('createTranscriptView', () => {
  it('renders a user prompt as its own chat-message--user element with its exact text', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyUserPrompt(turnId, 'What pages reference this component?');

    view.repaint(store);

    const node = view.element.querySelector('.chat-message--user');
    expect(node?.textContent).toBe('What pages reference this component?');
  });

  describe('assistant messages', () => {
    it('is visible before completion: a mid-stream delta renders immediately', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(delta(0, 'Checking the page'));

      view.repaint(store);

      const node = view.element.querySelector('.chat-message--assistant');
      expect(node?.textContent?.trim()).toBe('Checking the page');
    });

    it('renders assistant text through the markdown renderer, not as raw escaped text', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(completed(0, 'This is **bold** text.'));

      view.repaint(store);

      const node = view.element.querySelector('.chat-message--assistant');
      expect(node?.querySelector('strong')?.textContent).toBe('bold');
    });

    it('replaces the delta-accumulated content on completion rather than duplicating it (anti-duplication)', () => {
      // The mandatory mutation-testing target: `transcriptView.ts` must
      // REPLACE a message node's rendered content on every repaint, reusing
      // the same persistent node across the "streaming" and "completed"
      // repaints - see that module's doc comment for why a fresh node per
      // repaint would hide this exact bug.
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();

      store.applyEvent(delta(0, 'Hello'));
      view.repaint(store);
      const nodeAfterDelta = view.element.querySelector('.chat-message--assistant');
      expect(nodeAfterDelta?.textContent?.trim()).toBe('Hello');

      store.applyEvent(completed(1, 'Hello, world!'));
      view.repaint(store);
      const nodeAfterCompletion = view.element.querySelector('.chat-message--assistant');

      expect(nodeAfterCompletion?.textContent?.trim()).toBe('Hello, world!');
      // Structural anti-duplication check, independent of textContent
      // normalization: exactly one paragraph must exist, not one per
      // repaint.
      expect(nodeAfterCompletion?.querySelectorAll('p')).toHaveLength(1);
    });

    it('renders a GFM table as a real <table> element with its cells (Milestone A #7)', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(completed(0, '| Name | Age |\n| --- | --- |\n| Ada | 36 |\n'));

      view.repaint(store);

      const node = view.element.querySelector('.chat-message--assistant');
      const table = node?.querySelector('table');
      expect(table).not.toBeNull();
      const cells = Array.from(node?.querySelectorAll('tbody td') ?? []).map(
        (td) => td.textContent,
      );
      expect(cells).toEqual(['Ada', '36']);
    });

    it('paints nothing for a completed message with empty text, and keeps its item in the store', () => {
      // The model can end a turn with `assistant.message.completed` carrying
      // `content: ""` (a tool-only answer, e.g. a search turn whose whole answer
      // is the table). The message item is real and stays for debugging, but an
      // empty assistant bubble is just a gray box, so nothing is painted.
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(messageStarted(0));
      store.applyEvent(completed(1, ''));

      view.repaint(store);

      expect(view.element.querySelector('.chat-message--assistant')).toBeNull();
      expect(view.element.childElementCount).toBe(0);
      const messageItems = store.items().filter((item) => item.kind === 'message');
      expect(messageItems).toHaveLength(1);
      expect(store.textForMessage(messageId)).toBe('');
    });

    it('paints nothing for a whitespace-only message, which renders to nothing too', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(completed(0, '  \n '));

      view.repaint(store);

      expect(view.element.querySelector('.chat-message--assistant')).toBeNull();
    });

    it('paints a message as soon as it has text, so a streaming answer is not delayed', () => {
      // An empty message is skipped, but only while it is empty: the first delta
      // makes it appear, so the skip can never swallow a real answer.
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(messageStarted(0));
      view.repaint(store);
      expect(view.element.querySelector('.chat-message--assistant')).toBeNull();

      store.applyEvent(delta(1, 'The component is on 59 pages.'));
      view.repaint(store);

      expect(view.element.querySelector('.chat-message--assistant')?.textContent?.trim()).toBe(
        'The component is on 59 pages.',
      );
    });
  });

  describe('tool call lifecycle', () => {
    it('appears as its own transcript item even when the model returns no text at all', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));

      view.repaint(store);

      expect(view.element.querySelector('.chat-message--assistant')).toBeNull();
      const toolNode = view.element.querySelector('.chat-tool-call');
      expect(toolNode).not.toBeNull();
      expect(toolNode?.textContent).toContain('aem_get_json');
    });

    it('renders a failed tool call as an ordinary billet whose reason is its last details row', () => {
      // The mandatory anti-regression case (implementation-plan.md step 07):
      // a failed tool call must never render as a completed one. It differs by
      // its icon and status word alone - the card keeps the same borderless
      // surface as every other billet - and its reason (message plus the
      // suggested action) is the last row of the details it expands to.
      const succeededView = createTranscriptView(markdownRenderer);
      const succeededStore = createTranscriptStore();
      succeededStore.applyEvent(toolRequested(0));
      succeededStore.applyEvent(toolResult(1, true));
      succeededView.repaint(succeededStore);

      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolResult(1, false));

      view.repaint(store);

      const toolNode = view.element.querySelector('.chat-tool-call');
      const succeededNode = succeededView.element.querySelector('.chat-tool-call');
      expect(toolNode?.className).not.toBe(succeededNode?.className);

      // The reason lives in the details, which stay collapsed by default.
      const params = toolNode?.querySelector<HTMLElement>('.chat-tool-call__params');
      expect(params?.hidden).toBe(true);
      const reasonRow = params?.querySelector('.chat-tool-call__param:last-child');
      const reason = 'The requested page does not exist.';
      expect(reasonRow?.textContent).toContain(reason);
      // The suggested action is appended to the same row, not a separate one.
      expect(reasonRow?.textContent?.trim().length).toBeGreaterThan(reason.length);

      // The one visible difference while collapsed: the negative icon.
      const icon = toolNode?.querySelector('.chat-tool-call__icon');
      expect(icon?.classList.contains('chat-tool-call__icon--negative')).toBe(true);
      const succeededIcon = succeededNode?.querySelector('.chat-tool-call__icon');
      expect(succeededIcon?.classList.contains('chat-tool-call__icon--negative')).toBe(false);
    });

    it('renders a rejected tool call the same way, with the policy reason as its last row', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolRejected(1, 'This path is outside the allowed AEM server.'));

      view.repaint(store);

      const toolNode = view.element.querySelector('.chat-tool-call');
      expect(toolNode?.className).toMatch(/chat-tool-call--rejected/);
      const params = toolNode?.querySelector<HTMLElement>('.chat-tool-call__params');
      expect(params?.hidden).toBe(true);
      const reasonRow = params?.querySelector('.chat-tool-call__param:last-child');
      expect(reasonRow?.textContent).toContain('This path is outside the allowed AEM server.');
      const icon = toolNode?.querySelector('.chat-tool-call__icon');
      expect(icon?.classList.contains('chat-tool-call__icon--negative')).toBe(true);
    });

    it('shows a spinner on a running call and a different, static icon once it settles', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      view.repaint(store);
      const running = view.element.querySelector('.chat-tool-call');
      const runningIcon = running?.querySelector('.chat-tool-call__icon');
      expect(runningIcon).not.toBeNull();

      store.applyEvent(toolResult(1, true));
      view.repaint(store);
      const settled = view.element.querySelector('.chat-tool-call');
      const settledIcon = settled?.querySelector('.chat-tool-call__icon');
      expect(settledIcon).not.toBeNull();
      expect(settledIcon?.tagName).not.toBe(runningIcon?.tagName);
    });

    it('renders a running call\u2019s progress note and hides it once the call settles', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolProgress(1, 'Reading 12 of 20'));
      view.repaint(store);
      const line = view.element.querySelector<HTMLElement>('.chat-tool-call__progress');
      expect(line?.textContent).toBe('Reading 12 of 20');
      expect(line?.hidden).toBe(false);

      store.applyEvent(toolResult(2, true));
      view.repaint(store);
      // The span stays in the DOM (so a later progress tick can update it in
      // place) but is hidden: a settled call never shows a stale note.
      const settled = view.element.querySelector<HTMLElement>('.chat-tool-call__progress');
      expect(settled?.hidden).toBe(true);
      expect(settled?.textContent).toBe('');
    });

    it('hides a running billet while the turn waits on a question, and shows it again after', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(toolRequestedWithArgs(0, 'aem_semantic_search', { terms: 'x' }));
      view.repaint(store);
      expect(view.element.querySelector('.chat-tool-call')).not.toBeNull();

      store.setAwaitingUserInput(true);
      view.repaint(store);
      // Nothing is actively working while the user is being asked: the running
      // billet is hidden exactly as the Thinking billet is.
      expect(view.element.querySelector('.chat-tool-call')).toBeNull();
      expect(view.element.querySelector('.chat-message--thinking')).toBeNull();

      store.setAwaitingUserInput(false);
      view.repaint(store);
      expect(view.element.querySelector('.chat-tool-call')).not.toBeNull();
    });

    it('renders a replayed unresolved call with a status word and the same static icon a settled call shows', () => {
      const settledView = createTranscriptView(markdownRenderer);
      const settledStore = createTranscriptStore();
      settledStore.applyEvent(toolRequested(0));
      settledStore.applyEvent(toolResult(1, true));
      settledView.repaint(settledStore);

      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));
      // What a journal replay does to a call the journal never resolved.
      store.abandonRunningToolCalls();
      view.repaint(store);

      const node = view.element.querySelector('.chat-tool-call');
      const header = node?.querySelector('.chat-tool-call__header')?.textContent ?? '';
      expect((node?.textContent ?? '').length).toBeGreaterThan(header.length);
      // No spinner: the static icon, exactly as a settled call shows.
      expect(node?.querySelector('.chat-tool-call__icon')?.tagName).toBe(
        settledView.element.querySelector('.chat-tool-call__icon')?.tagName,
      );
      expect(node?.querySelector<HTMLElement>('.chat-tool-call__progress')?.hidden).toBe(true);
    });

    it('renders a replayed call that was waiting on the user with no status word', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));
      // The app closed while a question was on screen (Load more): nothing was
      // in flight, so the call must not carry an interruption status.
      store.abandonRunningToolCalls(true);
      view.repaint(store);

      const interruptedView = createTranscriptView(markdownRenderer);
      const interruptedStore = createTranscriptStore();
      interruptedStore.applyEvent(toolRequested(0));
      interruptedStore.applyEvent(toolApproved(1));
      interruptedStore.abandonRunningToolCalls();
      interruptedView.repaint(interruptedStore);

      const node = view.element.querySelector('.chat-tool-call');
      const header = node?.querySelector('.chat-tool-call__header')?.textContent;
      expect(header).toBe('aem_get_json');
      const interruptedHeader =
        interruptedView.element.querySelector('.chat-tool-call__header')?.textContent;
      expect(header?.length).toBeLessThan(interruptedHeader?.length ?? 0);
      // The settled icon, exactly as a completed call shows: no spinner.
      expect(node?.querySelector('.chat-tool-call__icon')?.tagName).toBe(
        interruptedView.element.querySelector('.chat-tool-call__icon')?.tagName,
      );
    });

    it('updates the progress line in place instead of rebuilding the running billet', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));
      view.repaint(store);
      const toggle = view.element.querySelector('.chat-tool-call__toggle');
      const spinner = view.element.querySelector('.chat-tool-call__icon');
      expect(toggle).not.toBeNull();

      store.applyEvent(toolProgress(2, 'Reading 1 of 20'));
      store.applyEvent(toolProgress(3, 'Reading 2 of 20'));
      view.repaint(store);

      // Same nodes, new text: the spinner is not recreated, so its animation
      // never restarts on a progress tick (the "Thinking"-billet stutter fix).
      expect(view.element.querySelector('.chat-tool-call__toggle')).toBe(toggle);
      expect(view.element.querySelector('.chat-tool-call__icon')).toBe(spinner);
      expect(view.element.querySelector('.chat-tool-call__progress')?.textContent).toBe(
        'Reading 2 of 20',
      );
    });
  });

  describe('thinking billet', () => {
    function click(target: Element): void {
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    function startTurn(store: ReturnType<typeof createTranscriptStore>): void {
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
    }

    it('renders a trailing billet with a spinner, the "Thinking" label and a toggle while a turn is in flight', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);

      view.repaint(store);

      const node = view.element.querySelector('.chat-message--thinking');
      expect(node).not.toBeNull();
      const toggle = node?.querySelector('.chat-message__thinking-toggle');
      expect(toggle).not.toBeNull();
      // The spinner sits inside the toggle row, not loose on the shell.
      const spinner = toggle?.querySelector('sp-progress-circle');
      expect(spinner).not.toBeNull();
      expect(spinner?.hasAttribute('indeterminate')).toBe(true);
      expect(
        node?.querySelector('.chat-message__thinking-label')?.textContent?.length,
      ).toBeGreaterThan(0);
    });

    it('is inert while no reasoning has streamed: disabled toggle, no chevron, hidden body', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      view.repaint(store);

      const toggle = view.element.querySelector<HTMLButtonElement>(
        '.chat-message__thinking-toggle',
      );
      expect(toggle?.disabled).toBe(true);
      expect(
        view.element.querySelector('.chat-message__thinking-chevron')?.hasAttribute('hidden'),
      ).toBe(true);
      expect(view.element.querySelector<HTMLElement>('.chat-message__thinking-body')?.hidden).toBe(
        true,
      );
      expect(view.element.querySelector('.chat-message__thinking-line')?.textContent).toBe('');
    });

    it('shows the latest reasoning line and makes the billet expandable while reasoning streams', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      store.applyEvent(reasoningDelta(0, 'first thought\nsecond thought'));

      view.repaint(store);

      const line = view.element.querySelector('.chat-message__thinking-line');
      // The rolling line is the last line of the reasoning, not the first.
      expect(line?.textContent).toBe('second thought');
      const toggle = view.element.querySelector<HTMLButtonElement>(
        '.chat-message__thinking-toggle',
      );
      expect(toggle?.disabled).toBe(false);
      expect(
        view.element.querySelector('.chat-message__thinking-chevron')?.hasAttribute('hidden'),
      ).toBe(false);
      const body = view.element.querySelector<HTMLElement>('.chat-message__thinking-body');
      // Full text is present but collapsed by default.
      expect(body?.textContent).toBe('first thought\nsecond thought');
      expect(body?.hidden).toBe(true);
    });

    it('reveals the whole reasoning output on click and collapses on a second click', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      store.applyEvent(reasoningDelta(0, 'first thought\nsecond thought'));
      view.repaint(store);

      const toggle = view.element.querySelector('.chat-message__thinking-toggle');
      const thinking = view.element.querySelector('.chat-message--thinking');
      const collapsedClass = thinking?.className;
      click(toggle!);

      const body = view.element.querySelector<HTMLElement>('.chat-message__thinking-body');
      expect(body?.hidden).toBe(false);
      expect(thinking?.className).not.toBe(collapsedClass);

      click(toggle!);
      expect(body?.hidden).toBe(true);
    });

    it('keeps the billet expanded across a repaint triggered by a later reasoning delta', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      store.applyEvent(reasoningDelta(0, 'first'));
      view.repaint(store);
      click(view.element.querySelector('.chat-message__thinking-toggle')!);

      store.applyEvent(reasoningDelta(1, ' and more'));
      view.repaint(store);

      const body = view.element.querySelector<HTMLElement>('.chat-message__thinking-body');
      expect(body?.textContent).toBe('first and more');
      expect(body?.hidden).toBe(false);
    });

    it('does not re-insert the thinking shell on a reasoning-delta repaint, so its spinner animation is not restarted', async () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      store.applyEvent(reasoningDelta(0, 'first'));
      view.repaint(store);

      const shell = view.element.querySelector('.chat-message--thinking');
      const mutations: MutationRecord[] = [];
      const observer = new dom.window.MutationObserver((records) => mutations.push(...records));
      // Direct children only: this is what `replaceChildren` would churn.
      observer.observe(view.element, { childList: true });

      store.applyEvent(reasoningDelta(1, ' and more'));
      view.repaint(store);
      // MutationObserver delivers records asynchronously; let them land before
      // disconnecting, or the observation proves nothing.
      await new Promise((resolve) => setTimeout(resolve, 0));
      observer.disconnect();

      // Assert on plain counts, not the MutationRecord objects themselves:
      // jsdom throws `SecurityError` when vitest pretty-prints one on failure,
      // which would hide the real cause.
      const churn = mutations.map((record) => ({
        removed: record.removedNodes.length,
        added: record.addedNodes.length,
      }));
      // No child was removed/re-added, and the shell (and its spinner) is the
      // very same node that was already mounted.
      expect(churn).toEqual([]);
      expect(view.element.querySelector('.chat-message--thinking')).toBe(shell);
      expect(view.element.querySelector('.chat-message__thinking-line')?.textContent).toBe(
        'first and more',
      );
    });

    it('erases the reasoning text when the block completes, while the plain indicator remains', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      store.applyEvent(reasoningDelta(0, 'thinking hard'));
      view.repaint(store);
      expect(view.element.querySelector('.chat-message__thinking-line')?.textContent).toBe(
        'thinking hard',
      );

      store.applyEvent(reasoningCompleted(1, 'thinking hard'));
      view.repaint(store);

      // Still in flight with no text yet: the plain spinner remains, but the
      // transient reasoning line is gone.
      expect(view.element.querySelector('.chat-message--thinking')).not.toBeNull();
      expect(view.element.querySelector('.chat-message__thinking-line')?.textContent).toBe('');
      expect(
        view.element.querySelector<HTMLButtonElement>('.chat-message__thinking-toggle')?.disabled,
      ).toBe(true);
    });

    it('erases the reasoning text when the assistant starts producing output', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      store.applyEvent(reasoningDelta(0, 'thinking hard'));
      view.repaint(store);
      expect(view.element.querySelector('.chat-message__thinking-line')?.textContent).toBe(
        'thinking hard',
      );

      store.applyEvent(delta(1, 'Here is the answer'));
      view.repaint(store);

      expect(view.element.querySelector('.chat-message--thinking')).toBeNull();
      expect(view.element.querySelector('.chat-message--assistant')?.textContent?.trim()).toBe(
        'Here is the answer',
      );
    });

    it('hides the Thinking billet while a tool call runs, and restores it once the call settles', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      store.applyEvent(reasoningDelta(0, 'I should query AEM'));
      view.repaint(store);
      expect(view.element.querySelector('.chat-message__thinking-line')?.textContent).toBe(
        'I should query AEM',
      );

      store.applyEvent(toolRequested(1));
      view.repaint(store);

      // A running tool call supersedes the Thinking billet: exactly one
      // "unfinished process" indicator is on screen.
      expect(view.element.querySelector('.chat-message--thinking')).toBeNull();
      expect(view.element.querySelector('.chat-tool-call')).not.toBeNull();

      // Once it settles, and no assistant text has arrived, Thinking returns
      // (the earlier reasoning text already erased).
      store.applyEvent(toolResult(2, true));
      view.repaint(store);
      expect(view.element.querySelector('.chat-message--thinking')).not.toBeNull();
      expect(view.element.querySelector('.chat-message__thinking-line')?.textContent).toBe('');
    });

    it('starts a later reasoning block collapsed again after the previous one was expanded', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      store.applyEvent(reasoningDelta(0, 'first block'));
      view.repaint(store);
      click(view.element.querySelector('.chat-message__thinking-toggle')!);
      expect(view.element.querySelector<HTMLElement>('.chat-message__thinking-body')?.hidden).toBe(
        false,
      );

      // The first block ends, then a second one begins.
      store.applyEvent(reasoningCompleted(1, 'first block'));
      view.repaint(store);
      store.applyEvent(reasoningDelta(2, 'second block'));
      view.repaint(store);

      const body = view.element.querySelector<HTMLElement>('.chat-message__thinking-body');
      expect(body?.textContent).toBe('second block');
      expect(body?.hidden).toBe(true);
    });

    it('removes the billet when the turn leaves the in-flight state', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      startTurn(store);
      store.applyEvent(reasoningDelta(0, 'thinking hard'));
      view.repaint(store);
      expect(view.element.querySelector('.chat-message--thinking')).not.toBeNull();

      store.setTurnInFlight(false);
      view.repaint(store);

      expect(view.element.querySelector('.chat-message--thinking')).toBeNull();
    });
  });

  describe('ordering and cache reuse across repaints', () => {
    it('keeps settled items in first-seen order and moves the running billet last', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.applyEvent(toolRequested(0));
      view.repaint(store);

      store.applyEvent(delta(1, 'working on it'));
      view.repaint(store);

      const children = Array.from(view.element.children);
      expect(children).toHaveLength(3);
      expect(children[0]?.matches('.chat-message--user')).toBe(true);
      // The tool call is still running, so it is the transcript's lowest entry;
      // the assistant message that arrived after it is settled and stays above.
      expect(children[1]?.matches('.chat-message--assistant')).toBe(true);
      expect(children[2]?.matches('.chat-tool-call')).toBe(true);
    });

    it('reuses the same DOM node identity for an item across repaints instead of rebuilding it', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      view.repaint(store);
      const first = view.element.querySelector('.chat-tool-call');

      store.applyEvent(toolResult(1, true));
      view.repaint(store);
      const second = view.element.querySelector('.chat-tool-call');

      expect(second).toBe(first);
    });
  });
});

describe('createTranscriptView - format_table message table', () => {
  const AUTHOR = 'https://author.example';
  const activeContext: LinkContext = { hostOrigins: [AUTHOR], activeOrigin: AUTHOR };

  function callId(n: number): ToolCallId {
    return toolCallIdSchema.parse(`ft-${String(n)}`);
  }

  function requested(sequence: number, n: number, args: Record<string, unknown>): AgentEvent {
    return agentEventSchema.parse({
      type: 'tool.call.requested',
      chatId,
      sequence,
      toolCallId: callId(n),
      toolName: 'format_table',
      arguments: args,
    });
  }

  function result(sequence: number, n: number, rowCount: number, mode: string): AgentEvent {
    return agentEventSchema.parse({
      type: 'tool.result',
      chatId,
      sequence,
      toolCallId: callId(n),
      outcome: {
        ok: true,
        data: {
          operation: 'format_table',
          rowCount,
          mode,
          textResultForLlm: 'ok',
          resultType: 'success',
        },
      },
    });
  }

  // noinspection HtmlUnknownTarget,HtmlDeprecatedAttribute
  const page = {
    rows: [{ 'jcr:path': '/content/site/a' }, { 'jcr:path': '/content/site/b' }],
    pagination: { total: { accuracy: 'atLeast', value: 900 } },
  };

  function renderTable(
    events: readonly AgentEvent[],
    context: LinkContext = activeContext,
  ): HTMLElement {
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => context });
    const store = createTranscriptStore();
    for (const event of events) store.applyEvent(event);
    view.repaint(store);
    return view.element;
  }

  it('renders the rows as an assistant message table with a leading # column', () => {
    const element = renderTable([requested(0, 1, { data: page }), result(1, 1, 2, 'new')]);
    const rows = element.querySelectorAll('sp-table-body sp-table-row');
    expect(rows).toHaveLength(2);
    const firstCells = [...rows[0]!.querySelectorAll('sp-table-cell')].map((c) => c.textContent);
    expect(firstCells).toEqual(['1', '/content/site/a']);
    const headers = [...element.querySelectorAll('sp-table-head-cell')].map((c) => c.textContent);
    expect(headers).toHaveLength(2);
    expect(headers[0]).toBe('#');
  });

  it('adds a Node column beside the standard Path, links the page, and wraps the node', () => {
    const data = {
      rows: [
        {
          'jcr:path': '/content/site/a',
          node: 'jcr:content/parsys/aVeryLongComponentPathThatCannotBreakOnItsOwn',
          property: 'aVeryLongPropertyNameThatCannotBreakOnItsOwn',
          citation: 'x',
        },
        // A repeated page path is already blanked by the executor; the renderer
        // keeps the row and its number and paints an empty cell.
        { 'jcr:path': '', node: 'jcr:content/parsys/second' },
      ],
      pagination: { total: { accuracy: 'exact', value: 2 } },
    };
    const element = renderTable([requested(0, 1, { data }), result(1, 1, 2, 'new')]);
    const headers = [...element.querySelectorAll('sp-table-head-cell')].map((c) => c.textContent);
    // The index column, the standard Path, then one column per further key.
    expect(headers).toHaveLength(5);
    const firstRow = element.querySelectorAll('sp-table-body sp-table-row')[0]!;
    const pageCell = firstRow.querySelector('sp-table-cell:nth-child(2)');
    expect(pageCell?.textContent).toBe('/content/site/a');
    expect(pageCell?.querySelector('a[data-daisy-link]')).not.toBeNull();
    const nodeCell = firstRow.querySelector('sp-table-cell:nth-child(3) > span');
    expect(nodeCell?.textContent).toBe(
      'jcr:content/parsys/aVeryLongComponentPathThatCannotBreakOnItsOwn',
    );
    // The Node path is page-relative, so it is the "partly linkified" hover
    // target (see the dedicated cases below); the property is plain text.
    expect(nodeCell?.hasAttribute('data-daisy-actions')).toBe(true);
    const propertyCell = firstRow.querySelector('sp-table-cell:nth-child(4) > span');
    expect(propertyCell?.textContent).toBe('aVeryLongPropertyNameThatCannotBreakOnItsOwn');
    expect(propertyCell?.hasAttribute('data-daisy-actions')).toBe(false);
    // The second row keeps its number; its blank page path paints nothing.
    const secondRow = element.querySelectorAll('sp-table-body sp-table-row')[1]!;
    const cells = [...secondRow.querySelectorAll('sp-table-cell')].map((c) => c.textContent);
    expect(cells[0]).toBe('2');
    expect(cells[1]).toBe('');
  });

  it('makes the Path cell a clickable, stamped link against the active host', () => {
    const element = renderTable([requested(0, 1, { data: page }), result(1, 1, 2, 'new')]);
    const anchor = element.querySelector('sp-table-body a[data-daisy-link]');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/site/a.html`);
  });

  it('linkifies an absolute external URL in any cell, opening it outside the pane', () => {
    const data = { rows: [{ 'jcr:path': 'https://example.com/docs' }] };
    const element = renderTable([requested(0, 1, { data }), result(1, 1, 1, 'new')]);
    const link = element.querySelector('sp-table-body a[data-daisy-external]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.textContent).toBe('https://example.com/docs');
    // An external link offers no popover actions and never opens in the pane.
    expect(link?.hasAttribute('data-daisy-actions')).toBe(false);
    expect(link?.hasAttribute('data-daisy-link')).toBe(false);
  });

  it('offers Edit and CRX on a DAM asset cell', () => {
    const data = { rows: [{ 'jcr:path': '/content/dam/x/y.jpg' }] };
    const element = renderTable([requested(0, 1, { data }), result(1, 1, 1, 'new')]);
    const anchor = element.querySelector('sp-table-body a[data-daisy-link]');
    // The link itself previews the asset; the popover adds AEM's own views.
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/dam/x/y.jpg`);
    expect(actionsOf(anchor)).toEqual([
      { id: 'edit', href: `${AUTHOR}/assetdetails.html/content/dam/x/y.jpg` },
      { id: 'crx', href: `${AUTHOR}/crx/de/index.jsp#/content/dam/x/y.jpg` },
    ]);
  });

  it('offers CRX on an asset cell outside DAM', () => {
    const data = { rows: [{ 'jcr:path': '/apps/x/y.json' }] };
    const element = renderTable([requested(0, 1, { data }), result(1, 1, 1, 'new')]);
    const anchor = element.querySelector('sp-table-body a[data-daisy-link]');
    expect(actionsOf(anchor)).toEqual([
      { id: 'crx', href: `${AUTHOR}/crx/de/index.jsp#/apps/x/y.json` },
    ]);
  });

  it('hangs a page-relative Node cell off the last full path, offering only its CRX', () => {
    const data = {
      rows: [
        { 'jcr:path': '/content/site/a', node: 'jcr:content/parsys/mine' },
        // A repeated page path was blanked by the executor; the node must still
        // resolve against the last full path the table rendered.
        { 'jcr:path': '', node: 'jcr:content/parsys/second' },
      ],
    };
    const element = renderTable([requested(0, 1, { data }), result(1, 1, 2, 'new')]);
    const rows = element.querySelectorAll('sp-table-body sp-table-row');

    const first = rows[0]!.querySelector('sp-table-cell:nth-child(3) > span');
    // It is a hover target, never a second navigable link.
    expect(first?.hasAttribute('data-daisy-link')).toBe(false);
    expect(first?.hasAttribute('href')).toBe(false);
    // ...and only CRX - no Edit, which would repeat the row's page action.
    expect(actionsOf(first)).toEqual([
      {
        id: 'crx',
        href: `${AUTHOR}/crx/de/index.jsp#/content/site/a/jcr%3Acontent/parsys/mine`,
      },
    ]);

    const second = rows[1]!.querySelector('sp-table-cell:nth-child(3) > span');
    expect(actionsOf(second)).toEqual([
      {
        id: 'crx',
        href: `${AUTHOR}/crx/de/index.jsp#/content/site/a/jcr%3Acontent/parsys/second`,
      },
    ]);
  });

  it('resolves a page-relative value in any column, not only the Node column', () => {
    const data = {
      rows: [{ 'jcr:path': '/content/site/a', other: 'jcr:content/parsys/other' }],
    };
    const element = renderTable([requested(0, 1, { data }), result(1, 1, 1, 'new')]);
    const cell = element.querySelector('sp-table-body sp-table-cell:nth-child(3) > span');
    expect(actionsOf(cell)).toEqual([
      {
        id: 'crx',
        href: `${AUTHOR}/crx/de/index.jsp#/content/site/a/jcr%3Acontent/parsys/other`,
      },
    ]);
  });

  it('leaves a page-relative cell as plain wrapped text when no host is active', () => {
    const data = { rows: [{ 'jcr:path': '/content/site/a', node: 'jcr:content/parsys/mine' }] };
    const element = renderTable([requested(0, 1, { data }), result(1, 1, 1, 'new')], {
      hostOrigins: [AUTHOR],
      activeOrigin: undefined,
    });
    // No active host means nothing is linkified, so there is no base and the
    // node stays ordinary wrapped text.
    expect(element.querySelector('sp-table-body a[data-daisy-link]')).toBeNull();
    const nodeCell = element.querySelector('sp-table-body sp-table-cell:nth-child(3) > span');
    expect(nodeCell?.textContent).toBe('jcr:content/parsys/mine');
    expect(nodeCell?.hasAttribute('data-daisy-actions')).toBe(false);
  });

  it('carries the base across a Load more append, so a later page still resolves', () => {
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => activeContext });
    const store = createTranscriptStore();
    store.applyEvent(
      requested(0, 1, {
        data: { rows: [{ 'jcr:path': '/content/site/a', node: 'jcr:content/parsys/first' }] },
      }),
    );
    store.applyEvent(result(1, 1, 1, 'new'));
    view.repaint(store);

    // The next page's first page path is blanked (it repeats page 1's last), so
    // the appended row's node must hang off the base row 1 left behind.
    store.applyEvent(
      requested(2, 2, {
        data: { rows: [{ 'jcr:path': '', node: 'jcr:content/parsys/appended' }] },
        mode: 'append',
      }),
    );
    store.applyEvent(result(3, 2, 1, 'append'));
    view.repaint(store);

    const rows = view.element.querySelectorAll('sp-table-body sp-table-row');
    expect(rows).toHaveLength(2);
    const appended = rows[1]!.querySelector('sp-table-cell:nth-child(3) > span');
    expect(actionsOf(appended)).toEqual([
      {
        id: 'crx',
        href: `${AUTHOR}/crx/de/index.jsp#/content/site/a/jcr%3Acontent/parsys/appended`,
      },
    ]);
  });

  it('renders the total line below the table', () => {
    const element = renderTable([requested(0, 1, { data: page }), result(1, 1, 2, 'new')]);
    const total = element.querySelector('.chat-table-message__total');
    expect(total?.textContent).toContain('900');
    // The total reads under the table, not above it.
    const table = element.querySelector('sp-table');
    expect(table).not.toBeNull();
    expect(total?.previousElementSibling).toBe(table);
  });

  it('renders only the total line, no table, when the page matched nothing', () => {
    const element = renderTable([
      requested(0, 1, {
        data: { rows: [], pagination: { total: { accuracy: 'exact', value: 0 } } },
      }),
      result(1, 1, 0, 'new'),
    ]);
    expect(element.querySelector('sp-table')).toBeNull();
    expect(element.querySelector('.chat-table-message__total')?.textContent).toContain('0');
  });

  it('wears a counting spinner in front of the total, and removes it in place', () => {
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => activeContext });
    const store = createTranscriptStore();
    store.applyEvent(requested(0, 1, { data: page, totalPending: true }));
    store.applyEvent(result(1, 1, 2, 'new'));
    view.repaint(store);

    const total = view.element.querySelector('.chat-table-message__total');
    expect(total?.querySelector('sp-progress-circle')).not.toBeNull();
    expect(total?.textContent).toContain('900');
    const table = view.element.querySelector('sp-table');
    expect(table).not.toBeNull();

    // The settle call: the same rows, an exact total, no spinner.
    store.applyEvent(
      requested(2, 2, {
        data: { rows: [] },
        mode: 'append',
        totalLine: 'Total: 1234',
        totalPending: false,
      }),
    );
    store.applyEvent(result(3, 2, 0, 'append'));
    view.repaint(store);

    // The spinner is gone and the total rewritten - on the very same <sp-table>.
    expect(view.element.querySelector('.chat-table-message__total sp-progress-circle')).toBeNull();
    expect(view.element.querySelector('.chat-table-message__total')?.textContent).toBe(
      'Total: 1234',
    );
    expect(view.element.querySelector('sp-table')).toBe(table);
    expect(view.element.querySelectorAll('sp-table-body sp-table-row')).toHaveLength(2);
  });

  it('does not report a total-only change as an update, but does report a page growth', () => {
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => activeContext });
    const store = createTranscriptStore();
    store.applyEvent(requested(0, 1, { data: page, totalPending: true }));
    store.applyEvent(result(1, 1, 2, 'new'));
    view.repaint(store);

    // A late count: rows unchanged, so nothing is reported for reveal (a reader
    // who scrolled up must not be yanked).
    store.applyEvent(
      requested(2, 2, {
        data: { rows: [] },
        mode: 'append',
        totalLine: 'Total: 1234',
        totalPending: false,
      }),
    );
    store.applyEvent(result(3, 2, 0, 'append'));
    expect(view.repaint(store)).toEqual([]);

    // A real page growth is reported, so it is revealed as before.
    store.applyEvent(requested(4, 3, { data: page, mode: 'append' }));
    store.applyEvent(result(5, 3, 2, 'append'));
    expect(view.repaint(store)).toHaveLength(1);
  });

  it('shows a totalLine in the total slot, and a later totalLine replaces it', () => {
    const empty = {
      data: { rows: [], pagination: { total: { accuracy: 'exact', value: 9 } } },
      totalLine: 'Did not find any relevant results so far',
    };
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => activeContext });
    const store = createTranscriptStore();
    store.applyEvent(requested(0, 1, empty));
    store.applyEvent(result(1, 1, 0, 'new'));
    view.repaint(store);
    expect(view.element.querySelector('.chat-table-message__total')?.textContent).toBe(
      'Did not find any relevant results so far',
    );
    expect(view.element.querySelector('sp-table')).toBeNull();

    store.applyEvent(
      requested(2, 2, {
        data: page,
        mode: 'append',
        totalLine: 'Total: 2 so far',
      }),
    );
    store.applyEvent(result(3, 2, 2, 'append'));
    view.repaint(store);
    expect(view.element.querySelectorAll('sp-table-body sp-table-row')).toHaveLength(2);
    expect(view.element.querySelector('.chat-table-message__total')?.textContent).toBe(
      'Total: 2 so far',
    );
  });
  it('reuses the table node across repaints instead of rebuilding it', () => {
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => activeContext });
    const store = createTranscriptStore();
    store.applyEvent(requested(0, 1, { data: page }));
    store.applyEvent(result(1, 1, 2, 'new'));
    view.repaint(store);
    const first = view.element.querySelector('sp-table');
    expect(first).not.toBeNull();

    // A repaint with unchanged content must not create a new `sp-table`: a fresh
    // custom element collapses until it upgrades, which shifted the transcript's
    // scroll position (the reported "the whole table was re-rendered").
    view.repaint(store);
    expect(view.element.querySelector('sp-table')).toBe(first);
  });

  it('appends a Load more page to the SAME table node, and never detaches it', () => {
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => activeContext });
    const store = createTranscriptStore();
    store.applyEvent(requested(0, 1, { data: page }));
    store.applyEvent(result(1, 1, 2, 'new'));
    // A settled sibling between the run's pages: the run continues across it, so
    // growing the table must move the table past this node - not replay the list.
    store.applyEvent(toolRequestedWithArgs(2, 'aem_get_json', {}));
    view.repaint(store);

    const table = view.element.querySelector('sp-table');
    const firstRow = view.element.querySelector('sp-table-body sp-table-row');
    expect(table).not.toBeNull();
    expect(firstRow).not.toBeNull();

    store.applyEvent(
      requested(3, 2, { data: { rows: [{ 'jcr:path': '/content/site/c' }] }, mode: 'append' }),
    );
    store.applyEvent(result(4, 2, 1, 'append'));
    view.repaint(store);

    // The same `<sp-table>` - with its first row intact - now carries the
    // appended page. A fresh custom element has no height until it upgrades, so
    // rebuilding it is exactly the reported "the whole table collapsed" stutter.
    expect(view.element.querySelector('sp-table')).toBe(table);
    expect(view.element.querySelector('sp-table-body sp-table-row')).toBe(firstRow);
    expect(view.element.querySelectorAll('sp-table-body sp-table-row')).toHaveLength(3);
    // The table moved to the run's end, past the settled content, without being
    // rebuilt. The running sibling is the transcript's lowest entry by design
    // (see the ongoing-billet rule), so the table sits immediately above it.
    const tableMessage = table?.closest('.chat-table-message');
    expect(tableMessage).not.toBeNull();
    const running = view.element.querySelector('.chat-tool-call');
    expect(view.element.lastElementChild).toBe(running);
    expect(tableMessage?.nextElementSibling).toBe(running);
  });

  it('rebuilds the table when the link context changes', () => {
    let context: LinkContext = activeContext;
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => context });
    const store = createTranscriptStore();
    store.applyEvent(requested(0, 1, { data: page }));
    store.applyEvent(result(1, 1, 2, 'new'));
    view.repaint(store);
    const first = view.element.querySelector('sp-table');

    // A `Path` cell's href resolves against the active host, so a context change
    // must re-render it rather than reuse the stale table.
    context = { hostOrigins: [], activeOrigin: undefined };
    view.repaint(store);
    expect(view.element.querySelector('sp-table')).not.toBe(first);
  });

  it('never renders a format_table billet, and never parses a cell as HTML', () => {
    // noinspection HtmlUnknownTarget,HtmlDeprecatedAttribute,HtmlRequiredAltAttribute,JSUnresolvedFunction
    const element = renderTable([
      requested(0, 1, {
        data: {
          rows: [
            { 'jcr:path': '/content/site/a', citation: '<img src=x onerror=alert(1) alt="Image">' },
          ],
        },
      }),
      result(1, 1, 1, 'new'),
    ]);
    expect(element.querySelector('.chat-tool-call')).toBeNull();
    // noinspection HtmlUnknownTarget,HtmlDeprecatedAttribute
    expect(element.textContent).toContain('<img src=x onerror=alert(1) alt="Image">');
    expect(element.querySelector('img')).toBeNull();
  });

  describe('typed columns and a title', () => {
    const scorecard = {
      rows: [
        { name: 'Performance', verdict: 'pass' },
        { name: 'SEO', verdict: 'fail' },
      ],
    };
    const columns = [{ key: 'name' }, { key: 'verdict', type: 'status' }];

    it('draws a status cell as a status light that keeps its text, and a text cell plain', () => {
      const element = renderTable([
        requested(0, 1, { data: scorecard, columns, title: 'Scorecard' }),
        result(1, 1, 2, 'new'),
      ]);
      const cells = [...element.querySelectorAll('sp-table-body sp-table-row')[0]!.children];
      expect(cells.map((c) => c.textContent)).toEqual(['1', 'Performance', 'pass']);
      expect(cells[1]?.querySelector('sp-status-light')).toBeNull();
      const light = cells[2]?.querySelector('sp-status-light');
      expect(light?.getAttribute('variant')).toBe('positive');
      const failing = element.querySelectorAll('sp-table-body sp-table-row')[1]!;
      expect(failing.querySelector('sp-status-light')?.getAttribute('variant')).toBe('negative');
      expect(element.querySelector('.chat-table-message__title')?.textContent).toBe('Scorecard');
    });

    it('never parses a status value as markup', () => {
      // noinspection HtmlUnknownTarget,HtmlDeprecatedAttribute,HtmlRequiredAltAttribute,JSUnresolvedFunction
      const hostile = '<img src=x onerror=alert(1) alt="Image">';
      const element = renderTable([
        requested(0, 1, { data: { rows: [{ verdict: hostile }] }, columns }),
        result(1, 1, 1, 'new'),
      ]);
      expect(element.querySelector('sp-status-light')?.textContent).toBe(hostile);
      expect(element.querySelector('img')).toBeNull();
    });

    it('leaves an empty status cell empty', () => {
      const element = renderTable([
        requested(0, 1, { data: { rows: [{ name: 'A' }] }, columns }),
        result(1, 1, 1, 'new'),
      ]);
      expect(element.querySelector('sp-status-light')).toBeNull();
    });

    it('keeps the kinds across an appended page', () => {
      const element = renderTable([
        requested(0, 1, { data: scorecard, columns }),
        result(1, 1, 2, 'new'),
        requested(2, 2, {
          data: { rows: [{ name: 'A11y', verdict: 'warn' }] },
          columns,
          mode: 'append',
        }),
        result(3, 2, 1, 'append'),
      ]);
      const lights = element.querySelectorAll('sp-table-body sp-status-light');
      expect(lights).toHaveLength(3);
      expect(lights[2]?.getAttribute('variant')).toBe('notice');
    });

    it('re-renders when only the cell kind changes', () => {
      const view = createTranscriptView(markdownRenderer, { getLinkContext: () => activeContext });
      const plain = createTranscriptStore();
      plain.applyEvent(
        requested(0, 1, { data: scorecard, columns: [{ key: 'name' }, { key: 'verdict' }] }),
      );
      plain.applyEvent(result(1, 1, 2, 'new'));
      view.repaint(plain);
      expect(view.element.querySelector('sp-status-light')).toBeNull();

      const typed = createTranscriptStore();
      typed.applyEvent(requested(0, 1, { data: scorecard, columns }));
      typed.applyEvent(result(1, 1, 2, 'new'));
      view.repaint(typed);
      expect(view.element.querySelectorAll('sp-status-light')).toHaveLength(2);
    });
  });

  it('groups an append call into one table that stays at the run end', () => {
    const element = renderTable([
      requested(0, 1, { data: page }),
      result(1, 1, 2, 'new'),
      requested(2, 2, { data: { rows: [{ 'jcr:path': '/content/site/c' }] }, mode: 'append' }),
      result(3, 2, 1, 'append'),
    ]);
    // One table message, three accumulated rows, and no billet anywhere.
    expect(element.querySelectorAll('sp-table')).toHaveLength(1);
    expect(element.querySelectorAll('sp-table-body sp-table-row')).toHaveLength(3);
    expect(element.querySelectorAll('.chat-tool-call')).toHaveLength(0);
    const lastRow = element.querySelector('sp-table-body sp-table-row:last-child');
    expect(lastRow?.textContent).toContain('/content/site/c');
  });

  it('starts a fresh table on a new call (mode defaults to new)', () => {
    const element = renderTable([
      requested(0, 1, { data: { rows: [{ 'jcr:path': '/content/site/a' }] } }),
      result(1, 1, 1, 'new'),
      requested(2, 2, { data: { rows: [{ 'jcr:path': '/content/other/x' }] } }),
      result(3, 2, 1, 'new'),
    ]);
    expect(element.querySelectorAll('sp-table')).toHaveLength(2);
  });

  it('reports the table as updated when an append grows an existing run', () => {
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => activeContext });
    const store = createTranscriptStore();
    store.applyEvent(requested(0, 1, { data: page }));
    store.applyEvent(result(1, 1, 2, 'new'));

    // The first render of a run is new content, not an in-place update, and an
    // unchanged repaint reports nothing either.
    expect(view.repaint(store)).toEqual([]);
    expect(view.repaint(store)).toEqual([]);

    store.applyEvent(
      requested(2, 2, { data: { rows: [{ 'jcr:path': '/content/site/c' }] }, mode: 'append' }),
    );
    store.applyEvent(result(3, 2, 1, 'append'));

    // The append grew the same run: its message is reported so the pane can
    // reveal it, and it now carries all three accumulated rows.
    const updated = view.repaint(store);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.classList.contains('chat-table-message')).toBe(true);
    expect(updated[0]?.querySelectorAll('sp-table-body sp-table-row')).toHaveLength(3);

    // Detected once only: the next repaint has no change to report.
    expect(view.repaint(store)).toEqual([]);
  });

  it('reveals the ongoing billet, not the table, when a table grows above it', () => {
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => activeContext });
    const store = createTranscriptStore();
    store.applyEvent(requested(0, 1, { data: page }));
    store.applyEvent(result(1, 1, 2, 'new'));
    store.applyEvent(toolRequestedAs(2, 'call-ongoing', 'aem_query'));
    view.repaint(store);
    const ongoing = view.element
      .querySelector('[data-tool-call-toggle="call-ongoing"]')
      ?.closest<HTMLElement>('.chat-tool-call');
    expect(ongoing).not.toBeNull();

    store.applyEvent(
      requested(3, 2, { data: { rows: [{ 'jcr:path': '/content/site/c' }] }, mode: 'append' }),
    );
    store.applyEvent(result(4, 2, 1, 'append'));
    const targets = view.repaint(store);

    // The table is reported as updated, but the ongoing billet is the lower
    // entry: it is the last target, so the pane reveals the whole bottom.
    expect(targets).toContain(ongoing);
    expect(targets.at(-1)).toBe(ongoing);
  });

  it('does not report a table update when only the link context changed', () => {
    let context: LinkContext = activeContext;
    const view = createTranscriptView(markdownRenderer, { getLinkContext: () => context });
    const store = createTranscriptStore();
    store.applyEvent(requested(0, 1, { data: page }));
    store.applyEvent(result(1, 1, 2, 'new'));
    expect(view.repaint(store)).toEqual([]);

    // A `Path` cell's href re-resolves, so the table rebuilds - but its content
    // is unchanged. That is a re-render, not an application update, and must not
    // force the transcript to reveal the table.
    context = { hostOrigins: [], activeOrigin: undefined };
    expect(view.repaint(store)).toEqual([]);
  });

  it('never reports streaming assistant text as an update', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(delta(0, 'streaming '));
    expect(view.repaint(store)).toEqual([]);
    store.applyEvent(delta(1, 'text grows'));
    // Growing assistant text is new content being written, not a settled
    // message changed by code: the ordinary follow rule must stay in charge.
    expect(view.repaint(store)).toEqual([]);
  });
});

describe('createTranscriptView - openable message links', () => {
  const AUTHOR = 'https://author.example';
  const activeContext: LinkContext = { hostOrigins: [AUTHOR], activeOrigin: AUTHOR };

  function renderMessage(
    content: string,
    handlers: {
      onOpenLink?: (url: string) => void;
      onOpenExternal?: (url: string) => void;
    } = {},
    getLinkContext: () => LinkContext = () => activeContext,
  ): HTMLElement {
    const view = createTranscriptView(markdownRenderer, { getLinkContext, ...handlers });
    const store = createTranscriptStore();
    store.applyEvent(completed(0, content));
    view.repaint(store);
    return view.element;
  }

  function click(target: Element): Event {
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  it('routes a click on an AEM page link to onOpenLink with its rendered URL, and prevents the default', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const element = renderMessage('[Page](/content/site/en/page)', { onOpenLink });
    const anchor = element.querySelector('a[data-daisy-link]');
    expect(anchor).not.toBeNull();

    const event = click(anchor!);

    expect(onOpenLink).toHaveBeenCalledWith(`${AUTHOR}/content/site/en/page.html`);
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens a bare AEM path wrapped in prose', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const element = renderMessage('Look at /content/site/en/page', { onOpenLink });

    click(element.querySelector('a[data-daisy-link]')!);

    expect(onOpenLink).toHaveBeenCalledWith(`${AUTHOR}/content/site/en/page.html`);
  });

  it('routes a jcr:content resource link click to its owning page, not the raw resource', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const element = renderMessage('[C](/content/a/b/jcr:content/x)', { onOpenLink });
    const anchor = element.querySelector('a[data-daisy-link]');
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/a/b.html`);

    click(anchor!);

    expect(onOpenLink).toHaveBeenCalledWith(`${AUTHOR}/content/a/b.html`);
  });

  it('stamps a jcr:content link with the original resource CRX, not the trimmed page', () => {
    // The popover reads these stamped actions verbatim (it does not re-derive
    // them from the trimmed href), so this is the data-level guarantee that CRX
    // keeps the exact resource the message named.
    const element = renderMessage('[C](/content/a/b/jcr:content/x)');
    const anchor = element.querySelector('a[data-daisy-link]');

    expect(actionsOf(anchor)).toEqual([
      { id: 'edit', href: `${AUTHOR}/editor.html/content/a/b.html` },
      { id: 'crx', href: `${AUTHOR}/crx/de/index.jsp#/content/a/b/jcr%3Acontent/x` },
    ]);
  });

  it('routes an external link to onOpenExternal, not the pane', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const onOpenExternal = vi.fn<(url: string) => void>();
    const element = renderMessage('[E](https://other.example/x)', {
      onOpenLink,
      onOpenExternal,
    });
    const anchor = element.querySelector('a[data-daisy-external]');
    expect(anchor).not.toBeNull();

    const event = click(anchor!);

    expect(onOpenExternal).toHaveBeenCalledWith('https://other.example/x');
    expect(onOpenLink).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('renders a bare path as plain text (no anchor) until a host is active', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const element = renderMessage('Look at /content/site/en/page', { onOpenLink }, () => ({
      hostOrigins: [AUTHOR],
      activeOrigin: undefined,
    }));
    expect(element.querySelector('a')).toBeNull();
  });
});

describe('createTranscriptView - tool-call billet disclosure', () => {
  function click(target: Element): Event {
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  function renderGetJson(args: Record<string, unknown> = { path: '/content/acme/en/us/home' }) {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(toolRequestedWithArgs(0, 'aem_get_json', args));
    view.repaint(store);
    return { view, store };
  }

  it('renders each running call as a disclosure row preceded by a spinner and a chevron', () => {
    const { view } = renderGetJson();

    const icon = view.element.querySelector('.chat-tool-call__icon');
    // A running call shows the indeterminate spinner, not the static tool icon
    // (see the settled case in 'tool call lifecycle').
    expect(icon).not.toBeNull();
    // Prepended: the icon is the toggle's first child.
    expect(view.element.querySelector('.chat-tool-call__toggle')?.firstElementChild).toBe(icon);
  });

  it('is collapsed by default, with the call parameters present but hidden', () => {
    const { view } = renderGetJson();

    const params = view.element.querySelector<HTMLElement>('.chat-tool-call__params');
    expect(params?.hidden).toBe(true);
    expect(params?.textContent).toContain('/content/acme/en/us/home.0.json');
    expect(
      view.element.querySelector('.chat-tool-call__toggle')?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('reveals the requested path on click and collapses again on a second click', () => {
    const { view } = renderGetJson();
    const toggle = view.element.querySelector('.chat-tool-call__toggle')!;

    click(toggle);
    let params = view.element.querySelector<HTMLElement>('.chat-tool-call__params');
    expect(params?.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      view.element.querySelector('.chat-tool-call')?.classList.contains('chat-tool-call--expanded'),
    ).toBe(true);

    click(toggle);
    params = view.element.querySelector<HTMLElement>('.chat-tool-call__params');
    expect(params?.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the exact aem_query query when expanded', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(
      toolRequestedWithArgs(0, 'aem_query', {
        predicates: { path: '/content/site', type: 'cq:Page' },
        offset: 0,
        limit: 10,
      }),
    );
    view.repaint(store);

    click(view.element.querySelector('.chat-tool-call__toggle')!);

    const params = view.element.querySelector<HTMLElement>('.chat-tool-call__params');
    expect(params?.textContent).toContain('path=/content/site&type=cq:Page');
    expect(params?.textContent).toContain('10');
  });

  it('summarises environment_facts with the current host URL and hides its facts when collapsed', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(toolRequestedWithArgs(0, 'environment_facts', {}));
    store.applyEvent(
      agentEventSchema.parse({
        type: 'tool.result',
        chatId,
        sequence: 1,
        toolCallId,
        outcome: {
          ok: true,
          data: {
            operation: 'environment_facts',
            hosts: [
              {
                label: 'HPE DEV',
                origin: 'https://author.example',
                contentRoots: ['/content'],
                componentRoots: ['/apps'],
                current: true,
              },
            ],
          },
        },
      }),
    );
    view.repaint(store);

    // Collapsed: the host URL is the caption, the facts rows are hidden, and
    // there is no always-visible result table outside the disclosure.
    const toggle = view.element.querySelector('.chat-tool-call__toggle')!;
    expect(toggle.querySelector('.chat-tool-call__summary')?.textContent).toBe(
      'https://author.example',
    );
    let params = view.element.querySelector<HTMLElement>('.chat-tool-call__params');
    expect(params?.hidden).toBe(true);
    expect(view.element.querySelector('.chat-tool-call sp-table')).toBeNull();

    // Expanded: the facts read out as label/value rows.
    click(toggle);
    params = view.element.querySelector<HTMLElement>('.chat-tool-call__params');
    expect(params?.hidden).toBe(false);
    expect(params?.textContent).toContain('https://author.example');
    expect(params?.textContent).toContain('/content');
    expect(params?.textContent).toContain('/apps');
  });

  it('keeps a billet expanded across a repaint triggered by a later event', () => {
    const { view, store } = renderGetJson();
    click(view.element.querySelector('.chat-tool-call__toggle')!);

    store.applyEvent(delta(1, 'still working'));
    view.repaint(store);

    const params = view.element.querySelector<HTMLElement>('.chat-tool-call__params');
    expect(params?.hidden).toBe(false);
    expect(
      view.element.querySelector('.chat-tool-call')?.classList.contains('chat-tool-call--expanded'),
    ).toBe(true);
  });

  it('keeps the path out of the header element, which names only the tool and its status', () => {
    const { view, store } = renderGetJson();
    store.applyEvent(toolResult(1, true));
    view.repaint(store);

    const header = view.element.querySelector('.chat-tool-call__header')?.textContent;
    expect(header).toContain('aem_get_json');
    expect(header).not.toContain('/content/acme/en/us/home');
    expect(view.element.querySelector('.chat-tool-call__summary')?.textContent).toBe(
      '/content/acme/en/us/home',
    );
  });

  it('does not route a billet click to onOpenLink', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const view = createTranscriptView(markdownRenderer, { onOpenLink });
    const store = createTranscriptStore();
    store.applyEvent(toolRequestedWithArgs(0, 'aem_get_json', { path: '/content/acme' }));
    view.repaint(store);

    click(view.element.querySelector('.chat-tool-call__toggle')!);

    expect(onOpenLink).not.toHaveBeenCalled();
  });
});

describe('createTranscriptView - interruption notices', () => {
  it('renders a notice for a user Stop and a different one for an application abort', () => {
    const stoppedView = createTranscriptView(markdownRenderer);
    const stoppedStore = createTranscriptStore();
    stoppedStore.addInterruption('stopped');
    stoppedView.repaint(stoppedStore);

    const navigationView = createTranscriptView(markdownRenderer);
    const navigationStore = createTranscriptStore();
    navigationStore.addInterruption('navigation');
    navigationView.repaint(navigationStore);

    const stopped = stoppedView.element.querySelector('.chat-message--interruption')?.textContent;
    const navigation = navigationView.element.querySelector(
      '.chat-message--interruption',
    )?.textContent;
    expect(stopped?.length).toBeGreaterThan(0);
    expect(navigation?.length).toBeGreaterThan(0);
    expect(stopped).not.toBe(navigation);
  });

  it('keeps each notice as its own DOM node across repaints', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.addInterruption('stopped');
    view.repaint(store);
    const first = view.element.querySelector('.chat-message--interruption');

    store.applyEvent(delta(0, 'more'));
    view.repaint(store);

    expect(view.element.querySelector('.chat-message--interruption')).toBe(first);
  });
});

describe('createTranscriptView - interruption Resume action', () => {
  function click(target: Element): void {
    target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  it('offers Resume on a live, still-newest "Session stopped" notice and invokes onResume', () => {
    const onResume = vi.fn();
    const view = createTranscriptView(markdownRenderer, { onResume });
    const store = createTranscriptStore();
    store.addInterruption('stopped');

    view.repaint(store);

    const button = view.element.querySelector('[data-interruption-resume]');
    expect(button).not.toBeNull();
    expect(button?.textContent?.length).toBeGreaterThan(0);

    click(button!);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('offers no Resume on a notice replayed from history (non-resumable)', () => {
    const onResume = vi.fn();
    const view = createTranscriptView(markdownRenderer, { onResume });
    const store = createTranscriptStore();
    store.addInterruption('stopped', false);

    view.repaint(store);

    expect(view.element.querySelector('[data-interruption-resume]')).toBeNull();
  });

  it('drops the Resume action once the notice is no longer the newest item', () => {
    const onResume = vi.fn();
    const view = createTranscriptView(markdownRenderer, { onResume });
    const store = createTranscriptStore();
    store.addInterruption('stopped');
    view.repaint(store);
    expect(view.element.querySelector('[data-interruption-resume]')).not.toBeNull();

    // A later turn makes the notice history; the action must disappear.
    store.applyUserPrompt(turnId, 'Resume');
    view.repaint(store);

    expect(view.element.querySelector('[data-interruption-resume]')).toBeNull();
  });

  it('offers no Resume for a navigation notice', () => {
    const onResume = vi.fn();
    const view = createTranscriptView(markdownRenderer, { onResume });
    const store = createTranscriptStore();
    store.addInterruption('navigation');

    view.repaint(store);

    expect(view.element.querySelector('[data-interruption-resume]')).toBeNull();
  });

  it('offers no Resume when the host wired no handler', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.addInterruption('stopped');

    view.repaint(store);

    expect(view.element.querySelector('[data-interruption-resume]')).toBeNull();
  });
});

describe('createTranscriptView - bold skill name in a user prompt', () => {
  function renderPrompt(prompt: string, knownSkillNames: readonly string[]): HTMLElement {
    const view = createTranscriptView(markdownRenderer, {
      getKnownSkillNames: () => knownSkillNames,
    });
    const store = createTranscriptStore();
    store.applyUserPrompt(turnId, prompt);
    view.repaint(store);
    return view.element;
  }

  it('renders a leading known skill name bold, preserving the full text', () => {
    const element = renderPrompt('/search Waldo', ['search']);
    const node = element.querySelector('.chat-message--user');
    expect(node?.querySelector('strong')?.textContent).toBe('/search');
    expect(node?.textContent).toBe('/search Waldo');
  });

  it('leaves a token that names no known skill as plain text', () => {
    const element = renderPrompt('/unknown Waldo', ['search']);
    const node = element.querySelector('.chat-message--user');
    expect(node?.querySelector('strong')).toBeNull();
    expect(node?.textContent).toBe('/unknown Waldo');
  });

  it('leaves an ordinary prompt as plain text', () => {
    const element = renderPrompt('just a question', ['search']);
    const node = element.querySelector('.chat-message--user');
    expect(node?.querySelector('strong')).toBeNull();
    expect(node?.textContent).toBe('just a question');
  });
});

describe('ask_user conversation presentation', () => {
  const askArgs = {
    question: 'Pick a colour',
    options: ['Red', 'Green'],
    multiple: false,
    freeInput: false,
  };

  it('paints no shell at all while the question is still pending', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(toolRequestedWithArgs(0, 'ask_user', askArgs));
    view.repaint(store);

    // A pending question lives in the composer, not the transcript: no billet
    // and no empty `.chat-ask-user` shell either (the same "paint nothing" rule
    // an empty assistant message follows).
    expect(view.element.querySelector('.chat-tool-call')).toBeNull();
    expect(view.element.querySelector('.chat-ask-user')).toBeNull();
  });

  it('paints no shell for an actions prompt that renders nothing', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(
      toolRequestedWithArgs(0, 'ask_user', {
        actions: ['Load more'],
        multiple: false,
        freeInput: false,
      }),
    );
    store.applyEvent(
      agentEventSchema.parse({
        type: 'tool.result',
        chatId,
        sequence: 1,
        toolCallId,
        outcome: {
          ok: true,
          data: { operation: 'ask_user', selections: ['Load more'], freeform: null },
        },
      }),
    );
    view.repaint(store);

    // An actions call never paints, answered or not: no empty `.chat-ask-user`.
    expect(view.element.querySelector('.chat-ask-user')).toBeNull();
  });

  it('renders the question as an assistant message and the answer as a user message', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(toolRequestedWithArgs(0, 'ask_user', askArgs));
    store.applyEvent(
      agentEventSchema.parse({
        type: 'tool.result',
        chatId,
        sequence: 1,
        toolCallId,
        outcome: {
          ok: true,
          data: { operation: 'ask_user', selections: ['Red'], freeform: null },
        },
      }),
    );
    view.repaint(store);

    expect(view.element.querySelector('.chat-tool-call')).toBeNull();
    expect(
      view.element.querySelector('.chat-ask-user .chat-message--assistant')?.textContent?.trim(),
    ).toBe('Pick a colour');
    expect(view.element.querySelector('.chat-ask-user .chat-message--user')?.textContent).toBe(
      'Red',
    );
  });

  it('shows the question and the reason when the question could not be asked', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(toolRequestedWithArgs(0, 'ask_user', askArgs));
    store.applyEvent(
      agentEventSchema.parse({
        type: 'tool.result',
        chatId,
        sequence: 1,
        toolCallId,
        outcome: {
          ok: false,
          error: {
            code: 'CANCELLED',
            message: 'The question was cancelled',
            requestId,
            retryable: false,
            requiredAction: 'none',
          },
        },
      }),
    );
    view.repaint(store);

    expect(
      view.element.querySelector('.chat-ask-user .chat-message--assistant')?.textContent?.trim(),
    ).toBe('Pick a colour');
    expect(view.element.querySelector('.chat-ask-user .chat-tool-call__detail')?.textContent).toBe(
      'The question was cancelled',
    );
  });
});

describe('ongoing billet placement and the expansion accordion', () => {
  function idOf(node: Element): string | null | undefined {
    return node.querySelector('[data-tool-call-toggle]')?.getAttribute('data-tool-call-toggle');
  }

  it('keeps the running billet as the lowest entry and reveals it when it moves', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(toolRequestedAs(0, 'call-1'));
    store.applyEvent(toolResultAs(1, 'call-1'));
    store.applyEvent(toolRequestedAs(2, 'call-2'));

    const firstReveal = view.repaint(store);
    const first = [...view.element.children] as HTMLElement[];
    expect(first.map(idOf)).toEqual(['call-1', 'call-2']);
    // The running billet is new, so it is the reveal target even though the
    // store's item order put it after the settled one already.
    expect(firstReveal.at(-1)).toBe(first[1]);

    // A no-change repaint (a progress tick with the same rendered order) does
    // not yank the viewport.
    expect(view.repaint(store)).toEqual([]);

    // New settled content is placed above the running billet.
    store.applyEvent(toolRequestedAs(4, 'call-3'));
    store.applyEvent(toolResultAs(5, 'call-3'));
    const movedReveal = view.repaint(store);
    const after = [...view.element.children] as HTMLElement[];
    expect(after.map(idOf)).toEqual(['call-1', 'call-3', 'call-2']);
    expect(movedReveal.at(-1)).toBe(after[2]);
  });

  it('expands only one tool-call billet at a time', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    for (const [index, id] of ['call-1', 'call-2'].entries()) {
      store.applyEvent(toolRequestedAs(index * 2, id));
      store.applyEvent(toolResultAs(index * 2 + 1, id));
    }
    view.repaint(store);
    const toggles = [...view.element.querySelectorAll<HTMLElement>('[data-tool-call-toggle]')];
    expect(toggles).toHaveLength(2);

    clickElement(toggles[0] as HTMLElement);
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('true');
    clickElement(toggles[1] as HTMLElement);
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(toggles[1]?.getAttribute('aria-expanded')).toBe('true');

    // The state survives a repaint, still with one open billet.
    view.repaint(store);
    const after = [...view.element.querySelectorAll<HTMLElement>('[data-tool-call-toggle]')];
    expect(after[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(after[1]?.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes an expanded tool call when the Thinking billet is expanded', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyUserPrompt(turnId, 'hi');
    store.setTurnInFlight(true);
    store.applyEvent(toolRequestedAs(0, 'call-1'));
    store.applyEvent(toolResultAs(1, 'call-1'));
    store.applyEvent(reasoningDelta(2, 'pondering the AEM path'));
    view.repaint(store);

    const toolToggle = view.element.querySelector<HTMLElement>('[data-tool-call-toggle]');
    expect(toolToggle).not.toBeNull();
    clickElement(toolToggle as HTMLElement);
    expect(toolToggle?.getAttribute('aria-expanded')).toBe('true');

    const thinkingToggle = view.element.querySelector<HTMLElement>(
      '.chat-message__thinking-toggle',
    );
    expect(thinkingToggle).not.toBeNull();
    clickElement(thinkingToggle as HTMLElement);
    expect(toolToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(thinkingToggle?.getAttribute('aria-expanded')).toBe('true');
  });
});
