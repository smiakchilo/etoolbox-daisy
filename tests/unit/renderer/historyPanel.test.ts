import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHistoryPanel,
  HISTORY_COALESCE_MS,
  type HistoryPanel,
} from '../../../src/renderer/src/shell/historyPanel';
import type { StatusBannerSink } from '../../../src/renderer/src/settings/statusBanner';
import type {
  AgentChatByIdRequest,
  AgentChatHistoryEntry,
  AgentChatHistoryListResult,
  AgentChatListConversationsRequest,
  AgentChatVoidResult,
  ChatId,
} from '../../../src/shared';
import { flushMicrotasks } from '../../support/asyncWaits';
import { installJsdomGlobals } from '../../support/jsdomGlobals';
import { byTestId } from '../../support/selectors';

/**
 * The History panel's own behaviour: the small-batch load (each page paints as
 * it arrives, and a superseded reload never appends), the one set of action
 * buttons that travels to the hovered/focused row (acting on that row's
 * conversation), and the Reveal action that shares the chat footer's
 * `revealJournal` call. The built-app E2E proves the real journal/IPC path;
 * this file drives the panel's DOM contract directly.
 */

let dom: JSDOM;
let restoreGlobals: () => void;
let status: StatusBannerSink;

const listConversations =
  vi.fn<(request: AgentChatListConversationsRequest) => Promise<AgentChatHistoryListResult>>();
const revealJournal = vi.fn<(request: AgentChatByIdRequest) => Promise<AgentChatVoidResult>>();
const showStatus = vi.fn();
const showError = vi.fn();
const showPrompt = vi.fn();
const showNotice = vi.fn();
const clearStatus = vi.fn();

function entry(chatId: string, title: string): AgentChatHistoryEntry {
  return {
    chatId: chatId as ChatId,
    title,
    startedAt: 1000,
    updatedAt: 2000,
  };
}

/** An `agent-chat:list-conversations` result for one page. */
function page(
  entries: readonly AgentChatHistoryEntry[],
  next?: string,
): AgentChatHistoryListResult {
  return { ok: true, entries: [...entries], ...(next !== undefined ? { next } : {}) };
}

/** The panel's clock: frozen unless a case moves it, so pages never age by accident. */
let clock = 0;

function buildPanel(): HistoryPanel {
  return createHistoryPanel({
    status,
    onResume: vi.fn(),
    onDelete: vi.fn(() => Promise.resolve()),
    onDismiss: vi.fn(),
    now: () => clock,
  });
}

/** Puts the panel in the document and opens it, as the shell's panel host does. */
async function openPanel(panel: HistoryPanel): Promise<void> {
  document.body.append(panel.element);
  panel.open();
  await flushMicrotasks();
}

function rows(): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(byTestId('history-item'))];
}

function travelling(): HTMLElement | null {
  return document.querySelector<HTMLElement>(byTestId('history-actions'));
}

function require(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`missing ${selector}`);
  return element;
}

function hover(target: HTMLElement): void {
  target.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
}

/**
 * A Spectrum action button's host is focusable in the app (Spectrum gives it
 * `tabindex="0"` on its first update); jsdom's un-upgraded host is not, so a
 * test that exercises focus gives it one - the same accommodation
 * `settings/hostsSection.test.ts` makes.
 */
function makeFocusable(element: HTMLElement): HTMLElement {
  element.setAttribute('tabindex', '0');
  return element;
}

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals({
    url: 'http://localhost/',
    windowGlobals: ['MouseEvent', 'FocusEvent'],
  }));
  vi.resetAllMocks();
  clock = 0;
  listConversations.mockResolvedValue({ ok: true, entries: [] });
  revealJournal.mockResolvedValue({ ok: true });
  status = {
    showStatus,
    showError,
    showPrompt,
    showNotice,
    clear: clearStatus,
  };
  Reflect.set(dom.window, 'daisy', {
    agentChat: { listConversations, revealJournal },
  });
});

afterEach(() => {
  restoreGlobals();
});

describe('History panel loading', () => {
  it('reads every page, continuing with the previous cursor', async () => {
    listConversations
      .mockResolvedValueOnce(
        page([entry('chat-1', 'first'), entry('chat-2', 'second')], 'cursor-1'),
      )
      .mockResolvedValueOnce(page([entry('chat-3', 'third')]));
    const panel = buildPanel();

    await openPanel(panel);

    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['chat-1', 'chat-2', 'chat-3']);
    expect(listConversations.mock.calls).toEqual([[{}], [{ next: 'cursor-1' }]]);
  });

  it('holds later pages back and appends them together, so the list resizes once', async () => {
    let resolveThird: ((value: AgentChatHistoryListResult) => void) | undefined;
    listConversations
      .mockResolvedValueOnce(page([entry('chat-1', 'first')], 'cursor-1'))
      .mockResolvedValueOnce(page([entry('chat-2', 'second')], 'cursor-2'))
      .mockImplementationOnce(
        () =>
          new Promise<AgentChatHistoryListResult>((resolve) => {
            resolveThird = resolve;
          }),
      );
    const panel = buildPanel();

    await openPanel(panel);

    // The second page has arrived but the list has not aged: it is not painted.
    expect(listConversations).toHaveBeenCalledTimes(3);
    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['chat-1']);

    resolveThird?.(page([entry('chat-3', 'third')]));
    await flushMicrotasks();

    // The scan ended: the held pages land in one append.
    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['chat-1', 'chat-2', 'chat-3']);
  });

  it('appends held pages once the list has stood still long enough', async () => {
    let resolveThird: ((value: AgentChatHistoryListResult) => void) | undefined;
    listConversations
      .mockResolvedValueOnce(page([entry('chat-1', 'first')], 'cursor-1'))
      .mockImplementationOnce(async () => {
        clock = HISTORY_COALESCE_MS;
        return Promise.resolve(page([entry('chat-2', 'second')], 'cursor-2'));
      })
      .mockImplementationOnce(
        () =>
          new Promise<AgentChatHistoryListResult>((resolve) => {
            resolveThird = resolve;
          }),
      );
    const panel = buildPanel();

    await openPanel(panel);

    // A slow scan still shows progress while its last page is in flight.
    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['chat-1', 'chat-2']);
    resolveThird?.(page([entry('chat-3', 'third')]));
    await flushMicrotasks();
    expect(rows()).toHaveLength(3);
  });

  it('keeps the list on screen while a reload gathers its replacement, then swaps it whole', async () => {
    listConversations.mockResolvedValueOnce(
      page([entry('old-1', 'one'), entry('old-2', 'two'), entry('old-3', 'three')]),
    );
    const panel = buildPanel();
    await openPanel(panel);
    expect(rows()).toHaveLength(3);

    let resolveSecond: ((value: AgentChatHistoryListResult) => void) | undefined;
    listConversations
      .mockResolvedValueOnce(page([entry('new-1', 'fresh one')], 'cursor-1'))
      .mockImplementationOnce(
        () =>
          new Promise<AgentChatHistoryListResult>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    void panel.reload();
    await flushMicrotasks();

    // The first page of the replacement has arrived, but the old list - not a
    // one-row list that would shrink the scrollable area - is what is shown.
    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['old-1', 'old-2', 'old-3']);

    resolveSecond?.(page([entry('new-2', 'fresh two')]));
    await flushMicrotasks();

    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['new-1', 'new-2']);
  });

  it('swaps in what it has once a slow reload has kept the old list long enough', async () => {
    listConversations.mockResolvedValueOnce(page([entry('old-1', 'one'), entry('old-2', 'two')]));
    const panel = buildPanel();
    await openPanel(panel);

    listConversations
      .mockResolvedValueOnce(page([entry('new-1', 'fresh one')], 'cursor-1'))
      .mockImplementationOnce(async () => {
        clock = HISTORY_COALESCE_MS;
        return Promise.resolve(page([entry('new-2', 'fresh two')], 'cursor-2'));
      })
      .mockImplementationOnce(() => new Promise<AgentChatHistoryListResult>(() => undefined));
    void panel.reload();
    await flushMicrotasks();

    // Waiting any longer on a slow disk would leave a stale list on screen for
    // good, so what has been gathered replaces it while the last page loads.
    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['new-1', 'new-2']);
  });

  it('shows the first batch before the rest has loaded', async () => {
    let resolveSecond: ((value: AgentChatHistoryListResult) => void) | undefined;
    listConversations
      .mockResolvedValueOnce(page([entry('chat-1', 'first')], 'cursor-1'))
      .mockImplementationOnce(
        () =>
          new Promise<AgentChatHistoryListResult>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const panel = buildPanel();

    await openPanel(panel);

    // One row on screen while the second page is still in flight.
    expect(rows()).toHaveLength(1);
    resolveSecond?.(page([entry('chat-2', 'second')]));
    await flushMicrotasks();
    expect(rows()).toHaveLength(2);
  });

  it('drops a page that arrives after a newer reload started', async () => {
    let resolveFirst: ((value: AgentChatHistoryListResult) => void) | undefined;
    listConversations.mockImplementationOnce(
      () =>
        new Promise<AgentChatHistoryListResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const panel = buildPanel();
    await openPanel(panel);

    // A second reload supersedes the first scan.
    listConversations.mockResolvedValueOnce(page([entry('chat-9', 'fresh')]));
    await panel.reload();
    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['chat-9']);

    resolveFirst?.(page([entry('chat-1', 'stale')]));
    await flushMicrotasks();

    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['chat-9']);
  });

  it('reports an unavailable history once, with no rows', async () => {
    listConversations.mockResolvedValueOnce({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'disk on fire' },
    });
    const panel = buildPanel();

    await openPanel(panel);

    expect(rows()).toHaveLength(0);
    expect(panel.element.textContent).toContain('disk on fire');
  });

  it('shows an empty note without asking for a second page', async () => {
    listConversations.mockResolvedValueOnce(page([]));
    const panel = buildPanel();

    await openPanel(panel);

    // No rows at all, and the list says so; and a scan that returned no ids
    // needs no continuation request.
    expect(rows()).toHaveLength(0);
    expect(panel.element.querySelector('.history-panel__empty')).not.toBeNull();
    expect(listConversations).toHaveBeenCalledTimes(1);
    expect(travelling()).toBeNull();
  });

  it('keeps the rows painted so far when a later page fails', async () => {
    listConversations
      .mockResolvedValueOnce(page([entry('chat-1', 'first')], 'cursor-1'))
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'STORAGE_ERROR', message: 'read failed' },
      });
    const panel = buildPanel();

    await openPanel(panel);

    expect(rows().map((row) => row.dataset['chatId'])).toEqual(['chat-1']);
    expect(panel.element.textContent).toContain('read failed');
  });
});

describe('History panel focus', () => {
  it('replaces a focus that the repaint destroys with the first row', async () => {
    listConversations.mockResolvedValue(
      page([entry('chat-1', 'first'), entry('chat-2', 'second')]),
    );
    const panel = buildPanel();
    await openPanel(panel);
    const resume = makeFocusable(require(byTestId('history-resume')));

    makeFocusable(require(byTestId('history-panel-close'))).focus();
    expect(document.activeElement).not.toBe(resume);

    await panel.reload();

    // Buttons outlive a reload, so the reader keeps the position they were on.
    expect(document.activeElement).toBe(resume);
    expect(rows()[0]?.contains(resume)).toBe(true);
  });

  it('keeps the first row focused across a close and reopen', async () => {
    listConversations.mockResolvedValue(
      page([entry('chat-1', 'first'), entry('chat-2', 'second')]),
    );
    const panel = buildPanel();
    await openPanel(panel);
    const resume = makeFocusable(require(byTestId('history-resume')));
    resume.focus();

    panel.close();
    panel.open();
    await flushMicrotasks();

    expect(document.activeElement).toBe(resume);
    expect(rows()[0]?.contains(resume)).toBe(true);
  });
});

describe('History panel actions', () => {
  it('keeps one set of actions, travelling to the row that is reached', async () => {
    listConversations.mockResolvedValueOnce(
      page([entry('chat-1', 'first'), entry('chat-2', 'second')]),
    );
    const panel = buildPanel();
    await openPanel(panel);
    const [firstRow, secondRow] = rows();
    if (firstRow === undefined || secondRow === undefined) throw new Error('two rows expected');

    // Exactly one set for the whole list - never one per row - first anchored
    // on row one.
    expect(document.querySelectorAll(byTestId('history-actions'))).toHaveLength(1);
    expect(document.querySelectorAll(byTestId('history-resume'))).toHaveLength(1);
    expect(travelling()?.parentElement).toBe(firstRow);

    hover(secondRow);
    expect(travelling()?.parentElement).toBe(secondRow);
    expect(document.querySelectorAll(byTestId('history-resume'))).toHaveLength(1);
  });

  it('acts on the row it has travelled to', async () => {
    listConversations.mockResolvedValueOnce(
      page([entry('chat-1', 'first'), entry('chat-2', 'second')]),
    );
    const panel = buildPanel();
    await openPanel(panel);
    const [, secondRow] = rows();
    if (secondRow === undefined) throw new Error('two rows expected');

    hover(secondRow);
    require(byTestId('history-reveal')).click();

    expect(revealJournal).toHaveBeenCalledWith({ chatId: 'chat-2' });
  });

  it('reports a failed reveal in the pane banner', async () => {
    listConversations.mockResolvedValueOnce(page([entry('chat-1', 'first')]));
    revealJournal.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'gone' },
    });
    const panel = buildPanel();
    await openPanel(panel);

    require(byTestId('history-reveal')).click();
    await flushMicrotasks();

    expect(showError).toHaveBeenCalledWith('gone');
  });

  it('follows keyboard focus to a row, keeping the same button focused', async () => {
    listConversations.mockResolvedValueOnce(
      page([entry('chat-1', 'first'), entry('chat-2', 'second')]),
    );
    const panel = buildPanel();
    await openPanel(panel);
    const [, secondRow] = rows();
    if (secondRow === undefined) throw new Error('two rows expected');
    const reveal = makeFocusable(require(byTestId('history-reveal')));
    reveal.focus();

    hover(secondRow);

    expect(travelling()?.parentElement).toBe(secondRow);
    // The same button owns the focus after the move, not nothing.
    expect(document.activeElement).toBe(reveal);
    expect(secondRow.contains(reveal)).toBe(true);
  });

  it('anchors the actions on a row reached by keyboard focus alone', async () => {
    listConversations.mockResolvedValueOnce(
      page([entry('chat-1', 'first'), entry('chat-2', 'second')]),
    );
    const panel = buildPanel();
    await openPanel(panel);
    const [, secondRow] = rows();
    if (secondRow === undefined) throw new Error('two rows expected');

    secondRow.dispatchEvent(new dom.window.FocusEvent('focusin'));

    expect(travelling()?.parentElement).toBe(secondRow);
  });

  it('asks the shared confirmation before deleting the row the actions act on', async () => {
    listConversations.mockResolvedValue(page([entry('chat-1', 'first')]));
    const onDelete = vi.fn(() => Promise.resolve());
    const panel = createHistoryPanel({
      status,
      onResume: vi.fn(),
      onDelete,
      onDismiss: vi.fn(),
    });
    await openPanel(panel);

    require(byTestId('history-delete')).click();

    // The prompt is the pane-owned sink's; nothing is deleted until it is OK'd.
    expect(showPrompt).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
