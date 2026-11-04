import { test, type Page } from '@playwright/test';
import {
  type Journal,
  journalPathFor,
  toolCalls,
  userInputRequests,
} from '../support/live/journal';
import {
  expectNoToolError,
  expectSkillLoaded,
  expectToolNotCalled,
  expectTurnCompleted,
} from '../support/live/liveAssertions';
import { type LiveApp, launchLiveApp } from '../support/live/liveApp';
import { sendAndWait, startFreshConversation } from '../support/live/liveChat';
import { attachEvidence } from '../support/live/liveEvidence';

/**
 * The proof the unit tests cannot give: the active model, given "Go to home
 * page", resolves "home" as a **node name** (a `nodename` predicate, never
 * `fulltext`, never the `aem_query_format_ask` result table), and then either
 * navigates to the resolved path or puts a disambiguation question to the user.
 *
 * Opt-in (`npm run test:live`). Configure the host with `LIVE_HOST`; the default
 * prompt is "Go to home page" and the scenario runs `LIVE_NAVIGATE_ITERATIONS`
 * (default 5) fresh conversations in a row, all of which must succeed.
 */

const HOST = process.env['LIVE_HOST'];
const ITERATIONS = Number(process.env['LIVE_NAVIGATE_ITERATIONS'] ?? '5');
const TARGET = process.env['LIVE_NAVIGATE_TARGET'] ?? 'Go to home page';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function predicatesOf(
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const predicates = args['predicates'];
  return isRecord(predicates) ? predicates : undefined;
}

function usesFulltext(args: Readonly<Record<string, unknown>>): boolean {
  const predicates = predicatesOf(args);
  if (predicates === undefined) return false;
  return Object.keys(predicates).some((key) => key === 'fulltext' || key.includes('fulltext'));
}

function usesNodename(args: Readonly<Record<string, unknown>>): boolean {
  const predicates = predicatesOf(args);
  if (predicates === undefined) return false;
  return Object.keys(predicates).some((key) => key === 'nodename' || key.endsWith('_nodename'));
}

/** Answers a disambiguation question by taking the first candidate it offers. */
async function answerFirstOption(shell: Page): Promise<void> {
  // Actions mode: one click answers immediately.
  const action = shell.locator('.chat-ask__action').first();
  if ((await action.count()) > 0) {
    await action.click();
    return;
  }
  // Radio group (<= 5 options): select the first, then Submit.
  const radio = shell.locator('.chat-ask sp-radio').first();
  if ((await radio.count()) > 0) {
    await radio.click();
    await shell.locator('.chat-composer__send').click();
    return;
  }
  // Dropdown (> 5 options): the picker already defaults to its first option,
  // so Submit alone answers with it.
  await shell.locator('.chat-composer__send').click();
}

/** Returns a one-line verdict, or throws with a precise reason. */
function assertSuccessfulNavigation(journal: Journal, index: number): string {
  expectSkillLoaded(journal, 'navigate');
  expectToolNotCalled(journal, 'aem_query_format_ask');
  expectToolNotCalled(journal, 'format_table');

  const queries = toolCalls(journal, 'aem_query');
  const phaseA = queries.find((call) => usesNodename(call.arguments));
  if (phaseA === undefined) {
    throw new Error(
      `iteration ${index}: no node-name (nodename) query for a named page; ` +
        `aem_query calls were ${JSON.stringify(queries.map((call) => call.arguments))}`,
    );
  }
  const fulltext = queries.find((call) => usesFulltext(call.arguments));
  if (fulltext !== undefined) {
    throw new Error(
      `iteration ${index}: a full-text query was used for a name: ${JSON.stringify(fulltext.arguments)}`,
    );
  }

  const navigations = toolCalls(journal, 'browser_navigate');
  const questions = userInputRequests(journal);
  if (navigations.length === 0 && questions.length === 0) {
    throw new Error(
      `iteration ${index}: neither a navigation nor a disambiguation question happened`,
    );
  }
  if (navigations.length > 0) {
    const last = navigations[navigations.length - 1];
    if (last === undefined || last.outcome === undefined || !last.outcome.ok) {
      throw new Error(`iteration ${index}: browser_navigate did not succeed`);
    }
  }
  expectTurnCompleted(journal);
  expectNoToolError(journal);

  const pathArg = navigations[navigations.length - 1]?.arguments['path'];
  const path =
    navigations.length > 0 ? (typeof pathArg === 'string' ? pathArg : '(no path)') : '(asked)';
  return `navigated ${path}`;
}

test('navigate: a name resolves by node name and is navigated or disambiguated', async () => {
  const testInfo = test.info();
  const live: LiveApp = await launchLiveApp(HOST === undefined ? {} : { host: HOST });
  const results: string[] = [];
  try {
    for (let index = 1; index <= ITERATIONS; index += 1) {
      const chatId = await startFreshConversation(live);
      const { journal } = await sendAndWait(live, chatId, TARGET, {
        timeoutMs: 180_000,
        answerQuestion: async ({ shell }) => answerFirstOption(shell),
      });
      const verdict = assertSuccessfulNavigation(journal, index);
      results.push(`#${index}: ${verdict}`);

      const host = await live.currentHost().catch(() => undefined);
      await attachEvidence(testInfo, {
        scenario: `navigate-${String(index).padStart(2, '0')}`,
        journalPath: journalPathFor(live.paths.chats, chatId),
        agent: live.agent,
        host,
        passed: true,
      });
    }
    console.log(`\nNavigation verdicts:\n${results.join('\n')}\n`);
  } finally {
    await live.close();
  }
});
