import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { MEMO_TOOL_NAME } from '../../src/shared';
import { journalPathFor } from '../support/live/journal';
import {
  expectNoToolError,
  expectSkillLoaded,
  expectToolCalled,
  expectToolSucceeded,
  expectTurnCompleted,
} from '../support/live/liveAssertions';
import { type LiveApp, launchLiveApp } from '../support/live/liveApp';
import { sendAndWait, startFreshConversation } from '../support/live/liveChat';
import { attachEvidence } from '../support/live/liveEvidence';

// Writes ONE generic memo into the real memos folder (<home>/etoolbox-daisy/memos)
// and deletes that file - and only that file - afterwards. Self-learning must be on.
const LESSON = 'Write dates in search tables as YYYY-MM-DD';

test('memos: /remember writes a generic memo file', async () => {
  let live: LiveApp | undefined;
  let chatId: string | undefined;
  let memoFile: string | undefined;
  let passed = false;
  try {
    live = await launchLiveApp();
    chatId = await startFreshConversation(live);
    const { journal } = await sendAndWait(live, chatId, `/remember ${LESSON}`);

    expectTurnCompleted(journal);
    expectSkillLoaded(journal, 'remember');
    const [call] = expectToolCalled(journal, MEMO_TOOL_NAME);
    if (call === undefined) throw new Error('unreachable');
    expectToolSucceeded(call);
    expect(call.arguments['trigger']).toBe('request');
    expect(call.arguments['skill']).toBeUndefined();

    const data = call.outcome?.ok === true ? (call.outcome.data as { id?: unknown }) : {};
    expect(typeof data.id).toBe('string');
    memoFile = path.join(live.paths.memos, ...String(data.id).split('/'));
    expect(existsSync(memoFile)).toBe(true);
    expect(readFileSync(memoFile, 'utf8')).toMatch(/YYYY-MM-DD/);

    expectNoToolError(journal);
    passed = true;
  } finally {
    if (memoFile !== undefined) rmSync(memoFile, { force: true });
    if (live !== undefined && chatId !== undefined) {
      const host = await live.currentHost().catch(() => undefined);
      const result = await attachEvidence(test.info(), {
        scenario: 'memos-remember',
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
