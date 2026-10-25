import { expect, test } from '@playwright/test';
import {
  assistantMessages,
  journalPathFor,
  modelChanges,
  readJournalFile,
  toolCalls,
  turnSummaries,
} from '../support/live/journal';
import { expectToolCalled, expectToolSucceeded } from '../support/live/liveAssertions';
import { type LiveApp, launchLiveApp } from '../support/live/liveApp';
import { sendAndWait } from '../support/live/liveChat';
import { readChatStatus } from '../support/live/daisyBridge';
import { attachEvidence } from '../support/live/liveEvidence';

// The cheapest prompt that forces one real tool call, so both the working
// indicator and a tool billet are observable.
const PROMPT = 'Call the environment_facts tool once, then reply with one short sentence.';

/** One mid-turn reading of the chat pane, taken while the turn runs. */
interface Sample {
  readonly atMs: number;
  readonly sessionState: string;
  /** The transient "Thinking" billet is on screen. */
  readonly thinking: number;
  /** Any tool-call billet is on screen (the restored history's included). */
  readonly billets: number;
  /** The composer offers Stop, i.e. the pane itself believes a turn is running. */
  readonly stopping: number;
  /** The pane's rendered assistant text, for "did the answer paint?". */
  readonly transcriptChars: number;
}

const SAMPLE_MS = 200;

/**
 * The first prompt sent in a *restored* conversation must show the work it is
 * doing: the transient "Thinking" billet, then whatever tool billets it caused,
 * then the answer.
 *
 * This is a regression scenario, not a nice-to-have: the turn's own events are
 * filtered in main by the controller's active-turn bookkeeping, and a resumed
 * Copilot session reports its model (`session.model_change` -> a turn-less
 * `model.changed`) inside the very window between `sendMessage` registering the
 * turn and the adapter emitting `sending`. When that event was read as "the
 * session is idle, so no turn is running", the fresh turn was dropped: the tool
 * context threw "no active chat/turn to bind to", and every event of the turn
 * (indicator, billets, answer) never reached the renderer - while the journal
 * recorded a perfectly ordinary turn. Only the *first* prompt after a restore
 * hits it, because only then does the adapter call `setModel` on the resumed
 * session.
 *
 * See `docs/verification/followons-2026-10.md`, "The first prompt after a
 * restore shows its work".
 */
test('the first prompt after a restore shows its indicator, its billets and its answer', async () => {
  const testInfo = test.info();
  let live: LiveApp | undefined;
  let chatId: string | undefined;
  let journalPath: string | undefined;
  const samples: Sample[] = [];
  let passed = false;
  try {
    live = await launchLiveApp();
    const restored = (await readChatStatus(live.shell)).activeChatId;
    test.skip(
      restored === null,
      'No conversation was restored, so this scenario has nothing to certify. ' +
        'Use the app once (so it remembers a chat and a host page) and re-run.',
    );
    if (restored === null) throw new Error('unreachable: test.skip did not stop the test');
    chatId = restored;
    journalPath = journalPathFor(live.paths.chats, chatId);
    const before = readJournalFile(journalPath);
    const toolCallsBefore = toolCalls(before).length;
    const billetCountBefore = await live.shell.locator('.chat-tool-call').count();
    const assistantShellsBefore = await live.shell.locator('.chat-message--assistant').count();
    // The pane's own diagnostics: an illegal transition or a refused send is
    // logged by the renderer, never to `app.log`.
    const consoleLines: string[] = [];
    live.shell.on('console', (message) => {
      if (message.text().startsWith('[daisy]')) consoleLines.push(message.text());
    });

    // Sample the pane while the turn runs: the indicator and the billets are
    // transient, so a single reading after the turn proves nothing.
    let sampling = true;
    const started = Date.now();
    const sampler = (async () => {
      while (sampling) {
        const [status, thinking, billets, stopping, texts] = await Promise.all([
          readChatStatus(live.shell).catch(() => undefined),
          live.shell.locator('.chat-message--thinking').count(),
          live.shell.locator('.chat-tool-call').count(),
          live.shell
            .locator('.chat-composer__stop')
            .evaluateAll(
              (nodes) =>
                nodes.filter((node) => (node as HTMLElement).style.display !== 'none').length,
            ),
          live.shell
            .locator('.chat-message--assistant')
            .allInnerTexts()
            .catch(() => []),
        ]);
        samples.push({
          atMs: Date.now() - started,
          sessionState: status?.sessionState ?? 'unknown',
          thinking,
          billets,
          stopping,
          transcriptChars: texts.reduce((total, text) => total + text.length, 0),
        });
        if (sampling) await live.shell.waitForTimeout(SAMPLE_MS);
      }
    })();

    let turn;
    try {
      turn = await sendAndWait(live, chatId, PROMPT);
    } finally {
      sampling = false;
      await sampler;
    }

    const newBillets = Math.max(0, ...samples.map((sample) => sample.billets)) - billetCountBefore;
    const summary =
      `${samples.length} samples over ${String(Date.now() - started)} ms: ` +
      `thinking=${String(samples.some((s) => s.thinking > 0))} ` +
      `newBillets=${String(newBillets)} ` +
      `stop=${String(samples.some((s) => s.stopping > 0))} ` +
      `states=${[...new Set(samples.map((s) => s.sessionState))].join('/')} ` +
      `billetErrors=${JSON.stringify(
        toolCalls(turn.journal)
          .slice(toolCallsBefore)
          .filter((call) => call.outcome !== undefined && !call.outcome.ok)
          .map(
            (call) =>
              `${call.toolName}: ${String(call.outcome?.ok === false ? call.outcome.error.code : '')}`,
          ),
      )}`;
    const observations = { summary, samples, consoleLines };
    // Printed and attached BEFORE any assertion, so a failing run still shows
    // exactly what the pane did.
    console.log(JSON.stringify(observations, null, 2));
    await testInfo.attach('mid-turn observations', {
      body: JSON.stringify(observations, null, 2),
      contentType: 'application/json',
    });

    // 1. The working indicator appeared. Without a live turn the pane has
    //    nothing to spin, so this is the crux of the defect.
    expect(
      samples.some((sample) => sample.thinking > 0),
      `The first prompt after a restore showed no "Thinking" billet (${summary})`,
    ).toBe(true);

    // 2. The turn's events reached the renderer at all: the answer it produced
    //    painted as a new assistant message, rather than only reaching the
    //    journal.
    const answer = assistantMessages(turn.journal).at(-1)?.content.trim() ?? '';
    expect(answer, 'The new turn produced no assistant text in its journal').not.toBe('');
    const assistantShellsAfter = await live.shell.locator('.chat-message--assistant').count();
    expect(
      assistantShellsAfter,
      `The turn's answer never reached the transcript: ${String(assistantShellsAfter)} ` +
        `assistant message(s) before and after, ${summary}`,
    ).toBeGreaterThan(assistantShellsBefore);

    // 3. The tool call worked: the active-turn binding was intact, so a real
    //    billet was produced instead of "no active chat/turn to bind to".
    const call = expectToolCalled(turn.journal, 'environment_facts').at(-1);
    if (call === undefined) throw new Error('unreachable: expectToolCalled returned no call');
    expectToolSucceeded(call);

    // 4. The journal's own account of the resumed session: the runtime reported
    //    its model around the turn's start. This is the trigger, kept as
    //    evidence rather than assumed.
    const reported = modelChanges(turn.journal);
    testInfo.annotations.push({
      type: 'runtime-reported model change',
      description: `${String(reported.length)} model.changed record(s) in the journal`,
    });
    expect(turnSummaries(turn.journal).length).toBeGreaterThan(0);

    passed = true;
  } finally {
    if (live !== undefined && journalPath !== undefined) {
      const host = await live.currentHost().catch(() => undefined);
      const result = await attachEvidence(testInfo, {
        scenario: 'first-prompt-after-restore',
        journalPath,
        agent: live.agent,
        host,
        passed,
      });
      console.log(`Evidence: ${result.directory}`);
    }
    // Never delete the restored conversation: it is the user's own chat.
    await live?.close();
  }
});
