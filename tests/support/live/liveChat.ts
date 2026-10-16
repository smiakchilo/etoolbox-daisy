import { expect, type Page } from '@playwright/test';
import type { AgentChatStatus, AgentEvent } from '../../../src/shared';
import {
  CHAT_STATUS_BANNER,
  COMPOSER_SEND,
  sendViaComposer,
  waitForComposerReady,
} from '../e2e/composer';
import { byTestId } from '../selectors';
import { readChatStatus } from './daisyBridge';
import {
  isAwaitingUserInput,
  type Journal,
  journalPathFor,
  readJournalFile,
  turnSummaries,
  userInputRequests,
  userPrompts,
} from './journal';
import type { LiveApp } from './liveApp';
import { redactText } from './redact';

export type UserInputRequest = Extract<AgentEvent, { type: 'user.input.requested' }>;

export interface AnswerQuestionContext {
  readonly shell: Page;
  readonly question: UserInputRequest;
}

export interface SendAndWaitOptions {
  /** Hard limit for the whole turn (default 4 minutes). */
  readonly timeoutMs?: number;
  /**
   * Called once per `ask_user` question the model raises. It must answer through
   * the UI (click an action, fill the composer); without it a question fails the
   * run, because an unanswered question would hang until the timeout.
   */
  readonly answerQuestion?: (context: AnswerQuestionContext) => Promise<void>;
}

/** What one finished turn left behind, read from the app's own journal. */
export interface LiveTurn {
  readonly chatId: string;
  readonly journalPath: string;
  readonly journal: Journal;
  /** Zero-based index of the prompt this turn answered. */
  readonly promptIndex: number;
  readonly durationMs: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 240_000;
const POLL_MS = 500;
const SETTLE_MS = 15_000;
// A turn that errors reports it on the status banner and `sessionState`;
// give the journal this long to catch up before treating the state as final.
const ERROR_GRACE_MS = 5_000;

/**
 * Starts a fresh conversation through the chat toolbar's New session and
 * returns its id. The id is the app's own (`getStatus().activeChatId`, minted by
 * the renderer when the button is pressed), so the journal path is exact and
 * never guessed from a directory listing. The journal file itself appears only
 * with the first prompt.
 */
export async function startFreshConversation(live: LiveApp): Promise<string> {
  const { shell } = live;
  const previous = (await readChatStatus(shell)).activeChatId;
  const button = shell.locator(byTestId('chat-new-session'));
  await expect(
    button,
    'New session stayed disabled - is the app still restoring?',
  ).not.toHaveAttribute('disabled', '', { timeout: 60_000 });
  await button.click();
  let chatId: string | null = previous;
  await expect
    .poll(
      async () => {
        chatId = (await readChatStatus(shell)).activeChatId;
        return chatId !== null && chatId !== previous;
      },
      { message: 'New session did not open a new conversation', timeout: 30_000 },
    )
    .toBe(true);
  await waitForComposerReady(shell);
  if (chatId === null) throw new Error('unreachable: poll succeeded without a chat id');
  live.createdChatIds.push(chatId);
  return chatId;
}

function readIfPresent(journalPath: string): Journal | undefined {
  try {
    return readJournalFile(journalPath);
  } catch {
    return undefined;
  }
}

async function describeUiState(shell: Page, status: AgentChatStatus): Promise<string> {
  const banner = await shell
    .locator(CHAT_STATUS_BANNER)
    .innerText({ timeout: 1_000 })
    .catch(() => '');
  return redactText(
    `sessionState=${status.sessionState} serviceState=${status.serviceState} ` +
      `authenticated=${status.auth.isAuthenticated} banner="${banner.trim()}"`,
  );
}

async function composerIdle(shell: Page): Promise<boolean> {
  const send = shell.locator(COMPOSER_SEND);
  return (await send.isVisible()) && (await send.getAttribute('disabled')) === null;
}

async function hasRunningToolBillet(shell: Page): Promise<boolean> {
  return (
    (await shell.locator('.chat-tool-call__toggle sp-progress-circle[indeterminate]').count()) > 0
  );
}

/**
 * Sends `prompt` in the conversation `chatId` and waits until the turn is over.
 * "Over" is the journal's `turn.summary` for this prompt (the app's own record),
 * then the UI settling: Send enabled again, no running tool billet. Fails clearly
 * on an unanswered `ask_user` question, a dead or errored session and the timeout.
 */
export async function sendAndWait(
  live: LiveApp,
  chatId: string,
  prompt: string,
  options: SendAndWaitOptions = {},
): Promise<LiveTurn> {
  const { timeoutMs = DEFAULT_TURN_TIMEOUT_MS, answerQuestion } = options;
  const { shell } = live;
  const journalPath = journalPathFor(live.paths.chats, chatId);
  const before = readIfPresent(journalPath);
  const promptIndex = before === undefined ? 0 : userPrompts(before).length;
  const summariesBefore = before === undefined ? 0 : turnSummaries(before).length;

  const started = Date.now();
  await sendViaComposer(shell, prompt, { requireVisible: true, requireEnabled: true });

  const answered = new Set<string>();
  let errorSince: number | undefined;
  let journal: Journal | undefined;
  for (;;) {
    const elapsed = Date.now() - started;
    const status = await readChatStatus(shell);
    journal = readIfPresent(journalPath);
    const summaries = journal === undefined ? 0 : turnSummaries(journal).length;
    if (journal !== undefined && summaries > summariesBefore) break;

    if (journal !== undefined && isAwaitingUserInput(journal)) {
      const question = userInputRequests(journal).at(-1);
      if (question !== undefined && !answered.has(question.requestId)) {
        if (answerQuestion === undefined) {
          throw new Error(
            `The model asked the user a question and the scenario gave no answerQuestion callback: ` +
              `"${redactText(question.question ?? '(actions only)')}". Rephrase the prompt so the model needs no answer, or pass answerQuestion.`,
          );
        }
        answered.add(question.requestId);
        await answerQuestion({ shell, question });
      }
    }

    const broken = status.sessionState === 'error' || status.sessionState === 'closed';
    if (broken) {
      errorSince ??= Date.now();
      if (Date.now() - errorSince > ERROR_GRACE_MS) {
        throw new Error(
          `The turn failed before finishing (${await describeUiState(shell, status)}). ` +
            `Check the agent's sign-in and connectivity (Settings > Agents).`,
        );
      }
    } else {
      errorSince = undefined;
    }

    if (elapsed > timeoutMs) {
      throw new Error(
        `The turn did not finish within ${timeoutMs} ms (${await describeUiState(shell, status)}); ` +
          `journal: ${journalPath}`,
      );
    }
    await shell.waitForTimeout(POLL_MS);
  }

  const settleDeadline = Date.now() + SETTLE_MS;
  while (Date.now() < settleDeadline) {
    if ((await composerIdle(shell)) && !(await hasRunningToolBillet(shell))) break;
    await shell.waitForTimeout(POLL_MS);
  }

  const finalJournal = readIfPresent(journalPath) ?? journal;
  if (finalJournal === undefined) throw new Error(`The journal vanished: ${journalPath}`);
  return {
    chatId,
    journalPath,
    journal: finalJournal,
    promptIndex,
    durationMs: Date.now() - started,
  };
}

/** Convenience for the common case: a fresh conversation, one prompt, wait for the answer. */
export async function runPrompt(
  live: LiveApp,
  prompt: string,
  options: SendAndWaitOptions = {},
): Promise<LiveTurn> {
  const chatId = await startFreshConversation(live);
  return sendAndWait(live, chatId, prompt, options);
}
