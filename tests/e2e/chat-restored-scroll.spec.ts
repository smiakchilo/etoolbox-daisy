import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { type ElectronApp, mainEntry } from '../support/e2e/app';
import { sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { advanceFake, scriptTurn } from '../support/e2e/fakeAgent';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';
import { type ScriptedStep } from '../../src/main/agents/fakeAgentService';

/**
 * A **restored** transcript's stick-to-bottom behaviour, against the real built
 * app - the case `chat-transcript-scroll.spec.ts` cannot reach, because all of
 * its turns happen in a live session.
 *
 * Reported: launch with a remembered conversation whose journal contains search
 * tables, and the transcript must sit at its bottom; then send another prompt and
 * its answer must be followed too. It neither sat at the bottom nor followed.
 *
 * Root cause (measured, not guessed). A restored `sp-table` measures many times
 * its final height before it upgrades - 6 tables here briefly measure 602,056 px
 * against a settled 53,158 px, and the reporter's three measure 136,874 against
 * 22,457. The restore's first paint therefore pins the viewport to the bottom of
 * a ~1,000 px transcript; as the tables then expand, Chromium's **scroll
 * anchoring** moves `scrollTop` to keep that same content where it was, which is
 * no longer anywhere near the bottom. `transcriptFollower.ts` reads any `scroll`
 * event reporting a position it did not set as the reader scrolling away, so the
 * follow intent switched off - and the `ResizeObserver` re-pins only *while*
 * following, so it could never come back. The fix is `overflow-anchor: none` on
 * the scroller (see `chat.css`): the app owns the scroll position, and the only
 * position the browser then picks by itself is a clamp to the maximum, which
 * still reads as "at the bottom".
 *
 * The fixture is deliberately six turns: the restored transcript has to already
 * overflow the viewport *before* the tables lay out for the anchor to land in
 * the middle of the final transcript. With one or two turns the pre-layout
 * content fits, the browser's adjustment happens to land at the bottom, and the
 * failure does not reproduce - verified by removing the CSS rule and watching
 * this spec pass at two turns and fail at six (`following true->false`,
 * `bottomGap 25989`).
 *
 *   npm run build
 *   npx playwright test tests/e2e/chat-restored-scroll.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'chat-restored-scroll-scratch');

const TRANSCRIPT = '.chat-transcript';
const ASSISTANT_MESSAGE = '.chat-message--assistant';

const RESTORED_TURNS = 6;

/** A long enough answer that the transcript overflows and can be scrolled. */
function longAnswer(paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_, i) => `Paragraph ${i + 1} of a deliberately long answer.`,
  ).join('\n\n');
}

/** A scripted `aem_query` tool call: its billet is a transcript entry, and it is
 * what gives the restored transcript enough pre-table height to overflow. */
function queryStep(data: unknown): ScriptedStep {
  return {
    kind: 'toolCall',
    call: {
      toolName: 'aem_query',
      arguments: { predicates: { path: '/content/hpe' } },
      decision: { kind: 'approved', outcome: { ok: true, data } as never },
    },
  };
}

/** A scripted `format_table` call: its run paints the assistant-message table. */
function formatTableStep(data: unknown, mode: 'new' | 'append'): ScriptedStep {
  return {
    kind: 'toolCall',
    call: {
      toolName: 'format_table',
      arguments: { data: data as never, mode },
      decision: {
        kind: 'approved',
        outcome: {
          ok: true,
          data: {
            operation: 'format_table',
            rowCount: 0,
            mode,
            textResultForLlm: 'ok',
            resultType: 'success',
          } as never,
        },
      },
    },
  };
}

/**
 * Shaped like a real component-instance search: a long `Node` path per row,
 * which is what makes the not-yet-upgraded `sp-table` measure so far above its
 * final height.
 */
const tallTable = {
  rows: Array.from({ length: 60 }, (_, i) => ({
    'jcr:path': `/content/hpe/base/blueprint/regression/components/polaris/generic-page-v3/media_library/${String(i + 1)}`,
    node: `jcr:content/polaris-body-zone/backgroundwrapper_26_1651025805/components/cardgrid/cards/contentblock_copy_${String(i)}`,
  })),
  pagination: { hasMore: true, total: { accuracy: 'exact', value: 60 } },
};

/** `scrollHeight - scrollTop - clientHeight`; 0 means the scroller is at its bottom. */
async function bottomGap(shell: Page): Promise<number> {
  return shell
    .locator(TRANSCRIPT)
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/**
 * Advances the fake until `done` is true or `timeoutMs` elapses. The app can be
 * busy enough (a restored transcript still laying out) that a send's turn starts
 * well after the click resolves, so draining and waiting are interleaved rather
 * than racing.
 */
async function drainUntil(
  app: ElectronApp,
  done: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return;
    await advanceFake(app);
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Delivers whatever is left of the current turn (the table can be painted
 * before its turn ends, and the composer is only a Send control again once it
 * has). Bounded by a generous idle window rather than a step count.
 */
async function flushFake(app: ElectronApp): Promise<void> {
  let idle = 0;
  for (let guard = 0; guard < 1200; guard += 1) {
    if (await advanceFake(app)) {
      idle = 0;
      continue;
    }
    idle += 1;
    if (idle >= 40) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test.describe('Chat transcript: a restored conversation is followed', () => {
  test('a restored transcript with tables sits at its bottom, and a new turn is followed', async () => {
    test.setTimeout(240_000);
    const profile = createLaunchProfile(scratchBase, { fakeAgent: true });

    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>echo</title><p>ok</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    const base = defaultAppSettings();
    writeSettings(
      profile.home,
      appSettingsSchema.parse({
        ...base,
        hosts: [
          ...base.hosts,
          {
            id: randomUUID(),
            label: 'Echo',
            origin,
            color: { kind: 'swatch', swatch: 'blue' },
            revision: 0,
          },
        ],
      }),
    );

    // --- run 1: search turns, each leaving a tall table in the journal --------
    const first = await electron.launch({ args: [mainEntry], env: profile.env });
    const firstPage = await first.firstWindow();
    await firstPage.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
    await waitForComposerReady(firstPage, { awaitBannerClosed: false, expectSendVisible: false });

    for (let turn = 0; turn < RESTORED_TURNS; turn += 1) {
      await scriptTurn(first, {
        steps: [
          queryStep({ rows: [{ 'jcr:path': '/content/hpe/page-1' }], total: 1 }),
          formatTableStep(tallTable, 'new'),
        ],
      });
      await sendViaComposer(firstPage, '/search anything', { requireEnabled: true });
      const expected = turn + 1;
      await drainUntil(
        first,
        async () => (await firstPage.locator('.chat-table-message sp-table').count()) === expected,
        30_000,
      );
      await flushFake(first);
      await expect(firstPage.locator('.chat-table-message sp-table')).toHaveCount(expected, {
        timeout: 30_000,
      });
    }
    await expect.poll(() => bottomGap(firstPage), { timeout: 10_000 }).toBeLessThanOrEqual(4);
    await first.close();

    // --- run 2: the restored transcript must be at its bottom -----------------
    const second = await electron.launch({ args: [mainEntry], env: profile.env });
    const secondPage = await second.firstWindow();
    await waitForComposerReady(secondPage, { awaitBannerClosed: false, expectSendVisible: false });
    await expect(secondPage.locator('.chat-table-message sp-table')).toHaveCount(RESTORED_TURNS, {
      timeout: 60_000,
    });
    // The tables are still measuring wildly while they upgrade; the viewport has
    // to end up at the bottom of what they finally measure, not of what they
    // briefly did.
    await expect.poll(() => bottomGap(secondPage), { timeout: 15_000 }).toBeLessThanOrEqual(4);

    // --- and a new turn's content is followed too -----------------------------
    // A long assistant answer rather than another `format_table`: the fake mints
    // every id from one per-launch counter (`fake-id-N`), so a new run's first
    // tool call reuses a tool-call id the restored journal already used and the
    // store - which dedupes tool calls by id - correctly shows nothing for it. A
    // message is unaffected: the restored journal is all `/search` turns, whose
    // prose is suppressed and so wrote no message id to collide with, and the
    // store keeps its message ids in their own set. The "appended content must
    // be followed" rule is the same either way.
    await scriptTurn(second, { steps: [{ kind: 'delta', text: longAnswer(60) }] });
    await sendViaComposer(secondPage, 'give me a long answer', { requireEnabled: true });
    await drainUntil(
      second,
      async () =>
        (await secondPage.locator(ASSISTANT_MESSAGE).last().textContent())?.includes(
          'Paragraph 60',
        ) === true,
      30_000,
    );
    await flushFake(second);
    await expect(secondPage.locator(ASSISTANT_MESSAGE).last()).toContainText('Paragraph 60', {
      timeout: 30_000,
    });
    await expect.poll(() => bottomGap(secondPage), { timeout: 15_000 }).toBeLessThanOrEqual(4);
    await expect.poll(() => bottomGap(secondPage), { timeout: 15_000 }).toBeLessThanOrEqual(4);

    await second.close();
    server.close();
  });
});
