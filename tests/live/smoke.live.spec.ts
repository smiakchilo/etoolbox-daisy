import { expect, test } from '@playwright/test';
import { assistantText, journalPathFor, userPrompts } from '../support/live/journal';
import {
  expectNoToolError,
  expectToolCalled,
  expectToolSucceeded,
  expectTurnCompleted,
} from '../support/live/liveAssertions';
import { type LiveApp, launchLiveApp } from '../support/live/liveApp';
import { sendAndWait, startFreshConversation } from '../support/live/liveChat';
import { attachEvidence } from '../support/live/liveEvidence';

// Cheapest possible real round trip: one tiny prompt, one local tool (no AEM traffic).
const PROMPT =
  'Call the environment_facts tool once, then reply with one short sentence naming the host the browser pane is on.';

test('smoke: the real app answers a prompt through its own tool, and the journal proves it', async () => {
  const testInfo = test.info();
  let live: LiveApp | undefined;
  let chatId: string | undefined;
  let passed = false;
  try {
    live = await launchLiveApp();
    chatId = await startFreshConversation(live);
    const turn = await sendAndWait(live, chatId, PROMPT);

    expect(userPrompts(turn.journal)).toHaveLength(1);
    expectTurnCompleted(turn.journal);
    const [call] = expectToolCalled(turn.journal, 'environment_facts');
    if (call === undefined) throw new Error('unreachable: expectToolCalled returned no call');
    expectToolSucceeded(call);
    expectNoToolError(turn.journal);
    expect(assistantText(turn.journal).trim()).not.toBe('');
    passed = true;
  } finally {
    if (live !== undefined && chatId !== undefined) {
      const host = await live.currentHost().catch(() => undefined);
      const result = await attachEvidence(testInfo, {
        scenario: 'smoke',
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
