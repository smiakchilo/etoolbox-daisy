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

// See `composer.test.ts` for why a jsdom document is installed onto
// `globalThis`: `transcriptView.ts` builds its DOM through the same `el()`
// helper. `createMarkdownRenderer`, by contrast, takes its `Window`
// explicitly (see that module's own test), so it is constructed directly
// from `dom.window` rather than relying on the global installed here.
const dom = new JSDOM();
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
            requiredAction: 'sign_in_to_aem',
          },
        },
  });
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

    it("renders a succeeded tool call with a 'succeeded' modifier class", () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolResult(1, true));

      view.repaint(store);

      const toolNode = view.element.querySelector('.chat-tool-call');
      expect(toolNode?.className).toContain('chat-tool-call--succeeded');
      expect(toolNode?.textContent).toContain('Completed');
    });

    it('renders a failed tool call as visually and structurally distinct from a succeeded one, showing the error and suggested action', () => {
      // The mandatory anti-regression case (implementation-plan.md step 07):
      // a failed tool call must render as FAILED, with its error message
      // and suggested action, never as a completed one.
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolResult(1, false));

      view.repaint(store);

      const toolNode = view.element.querySelector('.chat-tool-call');
      expect(toolNode?.className).toContain('chat-tool-call--failed');
      expect(toolNode?.className).not.toContain('chat-tool-call--succeeded');
      expect(toolNode?.textContent).toContain('FAILED');
      expect(toolNode?.textContent).toContain('The requested page does not exist.');
      expect(toolNode?.textContent).toContain('Sign in to AEM in the browser pane, then try again');
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
      expect(node?.querySelector('.chat-message__thinking-label')?.textContent).toBe('Thinking');
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
      click(toggle!);

      const body = view.element.querySelector<HTMLElement>('.chat-message__thinking-body');
      expect(body?.hidden).toBe(false);
      expect(view.element.querySelector('.chat-message--thinking')?.className).toContain(
        'chat-message--thinking--expanded',
      );

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

    it('erases the reasoning text when a tool call is requested', () => {
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
    it('keeps items in first-seen order across repeated repaints', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.applyEvent(toolRequested(0));
      view.repaint(store);

      store.applyEvent(delta(1, 'working on it'));
      view.repaint(store);

      const classNames = Array.from(view.element.children).map((child) => child.className);
      expect(classNames).toEqual([
        'chat-message chat-message--user',
        'chat-tool-call chat-tool-call--requested',
        'chat-message chat-message--assistant',
      ]);
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
    pagination: { total: { accuracy: 'estimated', value: 900 } },
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
    expect(headers).toEqual(['#', 'Path']);
  });

  it('makes the Path cell a clickable, stamped link against the active host', () => {
    const element = renderTable([requested(0, 1, { data: page }), result(1, 1, 2, 'new')]);
    const anchor = element.querySelector('sp-table-body a[data-daisy-link]');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/site/a.html`);
  });

  it('renders the total line below the table', () => {
    const element = renderTable([requested(0, 1, { data: page }), result(1, 1, 2, 'new')]);
    const total = element.querySelector('.chat-table-message__total');
    expect(total?.textContent).toBe('Total: approximately 900 results');
    // The owner's fix: the total reads under the table, not above it.
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
    expect(element.querySelector('.chat-table-message__total')?.textContent).toBe(
      'Total: 0 results',
    );
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
        totalLine: 'Total: 2 relevant results so far',
      }),
    );
    store.applyEvent(result(3, 2, 2, 'append'));
    view.repaint(store);
    expect(view.element.querySelectorAll('sp-table-body sp-table-row')).toHaveLength(2);
    expect(view.element.querySelector('.chat-table-message__total')?.textContent).toBe(
      'Total: 2 relevant results so far',
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

    expect(parseLinkActions(anchor?.getAttribute('data-daisy-actions') ?? null)).toEqual([
      { id: 'edit', title: 'Edit', href: `${AUTHOR}/editor.html/content/a/b.html` },
      { id: 'crx', title: 'CRX', href: `${AUTHOR}/crx/de/index.jsp#/content/a/b/jcr%3Acontent/x` },
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

  it('renders each call as a disclosure row preceded by an sp-icon-actions icon and a chevron', () => {
    const { view } = renderGetJson();

    const icon = view.element.querySelector('.chat-tool-call__icon');
    expect(icon?.tagName.toLowerCase()).toBe('sp-icon-actions');
    expect(view.element.querySelector('.chat-tool-call__chevron')).not.toBeNull();
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
    expect(params?.textContent).toContain('Current host');
    expect(params?.textContent).toContain('https://author.example');
    expect(params?.textContent).toContain('Content roots');
    expect(params?.textContent).toContain('/content');
    expect(params?.textContent).toContain('Component roots');
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

  it('keeps the path out of the header element so its exact status text is unchanged', () => {
    const { view, store } = renderGetJson();
    store.applyEvent(toolResult(1, true));
    view.repaint(store);

    expect(view.element.querySelector('.chat-tool-call__header')?.textContent).toBe(
      'aem_get_json \u2014 Completed',
    );
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
  it("renders a 'Session stopped' notice for a user Stop", () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.addInterruption('stopped');

    view.repaint(store);

    expect(view.element.querySelector('.chat-message--interruption')?.textContent).toBe(
      'Session stopped',
    );
  });

  it("renders a 'Session interrupted by navigation' notice for an application abort", () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.addInterruption('navigation');

    view.repaint(store);

    expect(view.element.querySelector('.chat-message--interruption')?.textContent).toBe(
      'Session interrupted by navigation',
    );
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
    expect(button?.textContent).toBe('Resume');
    expect(button?.hasAttribute('quiet')).toBe(true);

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

  it('shows nothing while the question is still pending', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(toolRequestedWithArgs(0, 'ask_user', askArgs));
    view.repaint(store);

    expect(view.element.querySelector('.chat-tool-call')).toBeNull();
    const shell = view.element.querySelector('.chat-ask-user');
    expect(shell?.childElementCount).toBe(0);
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
