import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  agentEventSchema,
  chatIdSchema,
  messageIdSchema,
  requestIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type MessageId,
  type ToolCallId,
  type TurnId,
} from '../../../../src/shared';
import { createTranscriptStore } from '../../../../src/renderer/src/chat/transcriptStore';
import { createTranscriptView } from '../../../../src/renderer/src/chat/transcriptView';
import { createMarkdownRenderer } from '../../../../src/renderer/src/chat/renderMarkdown';
import type { LinkContext } from '../../../../src/renderer/src/chat/aemLinkTargets';

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
      expect(toolNode?.textContent).toContain(
        'Sign in to AEM in the browser pane, then try again.',
      );
    });
  });

  describe('thinking indicator', () => {
    it('renders a trailing thinking item with a prepended spinner and label while a turn is in flight', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);

      view.repaint(store);

      const node = view.element.querySelector('.chat-message--thinking');
      expect(node).not.toBeNull();
      const spinner = node?.querySelector('sp-progress-circle');
      expect(spinner).not.toBeNull();
      expect(spinner?.hasAttribute('indeterminate')).toBe(true);
      expect(node?.textContent).toContain('Thinking');
      // Prepended: the spinner is the thinking node's first child.
      expect(node?.firstElementChild).toBe(spinner);
    });

    it('removes the thinking item once assistant text starts streaming', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      view.repaint(store);
      expect(view.element.querySelector('.chat-message--thinking')).not.toBeNull();

      store.applyEvent(delta(0, 'Here is the answer'));
      view.repaint(store);

      expect(view.element.querySelector('.chat-message--thinking')).toBeNull();
      expect(view.element.querySelector('.chat-message--assistant')?.textContent?.trim()).toBe(
        'Here is the answer',
      );
    });

    it('removes the thinking item when the turn leaves the in-flight state', () => {
      const view = createTranscriptView(markdownRenderer);
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
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

describe('createTranscriptView - aem_query result table (Step 08)', () => {
  // noinspection HtmlUnknownTarget,HtmlDeprecatedAttribute
  const queryData = {
    ok: true,
    operation: 'aem_query',
    rows: [
      { 'jcr:path': '/content/site/a', 'jcr:title': 'Alpha' },
      { 'jcr:path': '/content/site/b', 'jcr:title': '<img src=x onerror=alert(1) alt="Image">' },
    ],
    pagination: {
      offset: 0,
      limit: 25,
      returned: 2,
      hasMore: true,
      total: { accuracy: 'estimated', value: 900 },
    },
  };

  function queryResultEvent(sequence: number, data: unknown): AgentEvent {
    return agentEventSchema.parse({
      type: 'tool.result',
      chatId,
      sequence,
      toolCallId,
      outcome: { ok: true, data },
    });
  }

  function renderQuery(data: unknown): HTMLElement {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(toolRequested(0, 'aem_query'));
    store.applyEvent(queryResultEvent(1, data));
    view.repaint(store);
    return view.element;
  }

  it('renders the actual result rows in a Spectrum table', () => {
    const element = renderQuery(queryData);
    const table = element.querySelector('sp-table');
    expect(table).not.toBeNull();
    const bodyRows = element.querySelectorAll('sp-table-body sp-table-row');
    expect(bodyRows).toHaveLength(2);
    const firstRowCells = [...bodyRows[0]!.querySelectorAll('sp-table-cell')].map(
      (cell) => cell.textContent,
    );
    expect(firstRowCells).toEqual(['/content/site/a', 'Alpha']);
  });

  it('renders one header cell per projected column, jcr:path first', () => {
    const element = renderQuery(queryData);
    const headers = [...element.querySelectorAll('sp-table-head-cell')].map(
      (cell) => cell.textContent,
    );
    expect(headers).toEqual(['jcr:path', 'jcr:title']);
  });

  it('shows the pagination status alongside the rows', () => {
    const element = renderQuery(queryData);
    const status = element.querySelector('.chat-tool-call__pagination');
    expect(status?.textContent).toMatch(/Showing 1\u20132/);
    expect(status?.textContent).toMatch(/approximately 900 matches/);
    expect(status?.textContent).toMatch(/More results exist/);
  });

  it('never parses a property value as HTML', () => {
    const element = renderQuery(queryData);
    // The literal text must survive, and it must not have become an element.
    // noinspection HtmlUnknownTarget,HtmlDeprecatedAttribute
    expect(element.textContent).toContain('<img src=x onerror=alert(1) alt="Image">');
    expect(element.querySelector('img')).toBeNull();
  });

  it('renders no table for an aem_get_json result', () => {
    const view = createTranscriptView(markdownRenderer);
    const store = createTranscriptStore();
    store.applyEvent(toolRequested(0, 'aem_get_json'));
    store.applyEvent(queryResultEvent(1, { ok: true, operation: 'aem_get_json', data: {} }));
    view.repaint(store);
    expect(view.element.querySelector('sp-table')).toBeNull();
  });

  it('shows the status but no table when the page matched nothing', () => {
    const element = renderQuery({
      ok: true,
      operation: 'aem_query',
      rows: [],
      pagination: {
        offset: 0,
        limit: 25,
        returned: 0,
        hasMore: false,
        total: { accuracy: 'exact', value: 0 },
      },
    });
    expect(element.querySelector('sp-table')).toBeNull();
    expect(element.querySelector('.chat-tool-call__pagination')?.textContent).toMatch(
      /No matches on this page/,
    );
  });

  it('keeps the transcript alive when the payload is malformed', () => {
    const element = renderQuery({ operation: 'aem_query', rows: 'not an array' });
    expect(element.querySelector('sp-table')).toBeNull();
    expect(element.querySelector('.chat-tool-call')).not.toBeNull();
  });
});

describe('createTranscriptView - openable message links', () => {
  const AUTHOR = 'https://author.example';
  const activeContext: LinkContext = { hostOrigins: [AUTHOR], activeOrigin: AUTHOR };

  function renderMessage(
    content: string,
    onOpenLink: (url: string) => void,
    getLinkContext: () => LinkContext = () => activeContext,
  ): HTMLElement {
    const view = createTranscriptView(markdownRenderer, { getLinkContext, onOpenLink });
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

  it('routes a click on an AEM page link to onOpenLink with its edit-mode URL, and prevents the default', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const element = renderMessage('[Page](/content/site/en/page)', onOpenLink);
    const anchor = element.querySelector('a[data-daisy-link]');
    expect(anchor).not.toBeNull();

    const event = click(anchor!);

    expect(onOpenLink).toHaveBeenCalledWith(`${AUTHOR}/editor.html/content/site/en/page.html`);
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens a bare AEM path wrapped in prose', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const element = renderMessage('Look at /content/site/en/page', onOpenLink);

    click(element.querySelector('a[data-daisy-link]')!);

    expect(onOpenLink).toHaveBeenCalledWith(`${AUTHOR}/editor.html/content/site/en/page.html`);
  });

  it('does not intercept an external link', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const element = renderMessage('[E](https://other.example/x)', onOpenLink);
    const anchor = element.querySelector('a');
    expect(anchor).not.toBeNull();

    const event = click(anchor!);

    expect(onOpenLink).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('renders a bare path as plain text (no anchor) until a host is active', () => {
    const onOpenLink = vi.fn<(url: string) => void>();
    const element = renderMessage('Look at /content/site/en/page', onOpenLink, () => ({
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
