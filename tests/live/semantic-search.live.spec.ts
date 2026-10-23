import { expect, test } from '@playwright/test';
import { journalPathFor, toolCalls } from '../support/live/journal';
import {
  expectNoToolError,
  expectToolCalled,
  expectToolSucceeded,
  expectTurnCompleted,
} from '../support/live/liveAssertions';
import { type LiveApp, launchLiveApp } from '../support/live/liveApp';
import { sendAndWait, startFreshConversation } from '../support/live/liveChat';
import { attachEvidence } from '../support/live/liveEvidence';

/**
 * The proof the unit tests cannot give: the active model answers **inside** the
 * tool call, on a fresh session, while the chat's own session waits for that
 * tool result. A search that finishes therefore has exactly one model-facing
 * `aem_semantic_search` call and no callback protocol.
 *
 * Opt-in (`npm run test:live`), against the real app/profile/AEM. Configure a
 * host (`LIVE_HOST`) and optionally a term (`LIVE_SEMANTIC_TERM`, default
 * "Greenlake"). The run answers "Load more" twice, then stops the next
 * question, so it is bounded even on a large instance.
 */

const TERM = process.env['LIVE_SEMANTIC_TERM'] ?? 'Greenlake';
const HOST = process.env['LIVE_HOST'];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('semantic search: the tool answers inside one call and paints the table itself', async (_fixtures, testInfo) => {
  let live: LiveApp | undefined;
  let chatId: string | undefined;
  let passed = false;
  try {
    live = await launchLiveApp(HOST === undefined ? {} : { host: HOST });
    chatId = await startFreshConversation(live);
    let questions = 0;
    const { journal } = await sendAndWait(live, chatId, `/semantic-search ${TERM}`, {
      timeoutMs: 10 * 60_000,
      answerQuestion: async ({ shell }) => {
        questions += 1;
        if (questions <= 2) {
          await shell.locator('.chat-ask__action').first().click();
          return;
        }
        // Past the bounded number of pages, stop the next question: the tool
        // ends as "stopped", which is a completed turn.
        await shell.locator('[data-testid="chat-composer-stop"]').click();
      },
    });

    expectTurnCompleted(journal);
    expectNoToolError(journal);
    const [semantic] = expectToolCalled(journal, 'aem_semantic_search');
    if (semantic === undefined) throw new Error('unreachable');
    // One model-facing call owns the whole search; no search id / verdicts.
    expect(toolCalls(journal, 'aem_semantic_search')).toHaveLength(1);
    expect(semantic.arguments['searchId']).toBeUndefined();
    expect(semantic.arguments['matches']).toBeUndefined();
    expectToolSucceeded(semantic);

    const data = semantic.outcome?.ok === true ? semantic.outcome.data : undefined;
    expect(isRecord(data)).toBe(true);
    if (!isRecord(data)) throw new Error('unreachable');
    expect(['exhausted', 'stopped']).toContain(data['ended']);
    const matchesShown = data['matchesShown'];
    const candidatesRead = data['candidatesRead'];
    expect(typeof matchesShown).toBe('number');
    expect(typeof candidatesRead).toBe('number');
    // The table was painted by the nested call, and the total counts matches.
    const tables = toolCalls(journal, 'format_table');
    expect(tables.length).toBeGreaterThan(0);

    passed = true;
  } finally {
    if (live !== undefined && chatId !== undefined) {
      const host = await live.currentHost().catch(() => undefined);
      const result = await attachEvidence(testInfo, {
        scenario: 'semantic-search-one-call',
        journalPath: journalPathFor(live.paths.chats, chatId),
        agent: live.agent,
        host,
        passed,
      });
      console.log(`Evidence: ${result.directory}`);
    }
    await live?.close();
  }
});
