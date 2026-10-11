import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { AEM_QUERY_TOOL_NAME } from '../../src/tools/aem-query/aemQuery';
import type { ScriptedStep, ScriptedTurn } from '../../src/main/agents/fakeAgentService';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';

/**
 * The transcript's stick-to-bottom policy, against the REAL shipped renderer
 * bundle.
 *
 * jsdom has no layout engine and no `ResizeObserver`, so the renderer unit tests
 * can only prove the intent logic (`transcriptFollower.ts`). The half that made
 * the transcript get "stuck" - a layout change (here: the composer growing and
 * shrinking the transcript) leaving a pinned reader measuring "not at the
 * bottom" - needs a real engine, which is exactly what these cases drive.
 *
 * They cover the reported scenario and its two boundaries: a deliberate scroll
 * up is respected (new agent content must not yank the reader back), and a sent
 * prompt jumps back to the bottom regardless.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/chat-transcript-scroll.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'chat-transcript-scroll-scratch');

const COMPOSER_SEND = '.chat-composer__send';
const COMPOSER_FIELD = '.chat-composer textarea';
const TRANSCRIPT = '.chat-transcript';
const ASSISTANT_MESSAGE = '.chat-message--assistant';
const TOOL_CALL = '.chat-tool-call';

/** A scripted `aem_query` tool call: its billet is the newest transcript entry. */
function queryStep(data: unknown): ScriptedStep {
  return {
    kind: 'toolCall',
    call: {
      toolName: AEM_QUERY_TOOL_NAME,
      arguments: { predicates: { path: '/content/site' } },
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

/** Enough rows that the table is taller than the transcript viewport. */
const tallTable = {
  rows: Array.from({ length: 80 }, (_, i) => ({ 'jcr:path': `/content/site/page-${i + 1}` })),
  pagination: { hasMore: true, total: { accuracy: 'exact', value: 80 } },
};

/** `scrollHeight - scrollTop - clientHeight`; 0 means the scroller is at its bottom. */
async function bottomGap(shell: Page): Promise<number> {
  return shell
    .locator(TRANSCRIPT)
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/**
 * Scrolls the transcript up with a real wheel gesture and resolves only once the
 * browser has dispatched the resulting `scroll` event - so the pane's intent
 * listener has definitely run before the test moves on. (Setting `scrollTop`
 * from a test would work too, but the explicit wait removes the race between the
 * async `scroll` event and the next transcript repaint.)
 */
async function wheelUp(shell: Page): Promise<void> {
  const transcript = shell.locator(TRANSCRIPT);
  await transcript.hover();
  await transcript.evaluate((el) => {
    (el as unknown as { __scrollSeen: boolean }).__scrollSeen = false;
    el.addEventListener(
      'scroll',
      () => {
        (el as unknown as { __scrollSeen: boolean }).__scrollSeen = true;
      },
      { once: true },
    );
  });
  await shell.mouse.wheel(0, -20_000);
  await expect
    .poll(() =>
      transcript.evaluate((el) => (el as unknown as { __scrollSeen: boolean }).__scrollSeen),
    )
    .toBe(true);
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface ScratchProfile {
  readonly home: string;
  readonly appData: string;
  readonly localAppData: string;
}

/** APPDATA/LOCALAPPDATA must agree with USERPROFILE/HOME or Electron crashes on this machine. */
function makeScratchProfile(): ScratchProfile {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return { home, appData, localAppData };
}

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

function launch(profile: ScratchProfile): Promise<ElectronApp> {
  return electron.launch({
    args: [mainEntry],
    env: {
      ...definedEnv(process.env),
      USERPROFILE: profile.home,
      HOME: profile.home,
      APPDATA: profile.appData,
      LOCALAPPDATA: profile.localAppData,
      [FAKE_AGENT_SERVICE_ENV_VAR]: '1',
    },
  });
}

interface FakeHandleArg {
  readonly globalKey: string;
}

function scriptTurn(app: ElectronApp, turn: ScriptedTurn): Promise<void> {
  const payload = JSON.stringify({ globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY, turn });
  return app.evaluate((_electronNamespace, json: string) => {
    const arg = JSON.parse(json) as FakeHandleArg & { readonly turn: unknown };
    const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
      readonly scriptNextResponse: (t: unknown) => void;
    };
    fake.scriptNextResponse(arg.turn);
  }, payload);
}

function advanceFake(app: ElectronApp): Promise<boolean> {
  return app.evaluate(
    (_electronNamespace, arg: FakeHandleArg) => {
      const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
        readonly advance: () => boolean;
      };
      return fake.advance();
    },
    { globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY },
  );
}

async function flushFake(app: ElectronApp): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    if (!(await advanceFake(app))) return;
  }
  throw new Error('flushFake exceeded its guard - the fake never drained.');
}

async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '', {
    timeout: 60_000,
  });
}

async function sendViaComposer(shell: Page, prompt: string): Promise<void> {
  const button = shell.locator(COMPOSER_SEND);
  await expect(button).toBeVisible();
  await expect(button).not.toHaveAttribute('disabled', '');
  await shell.locator(COMPOSER_FIELD).fill(prompt);
  await button.click();
}

/** A long enough answer that the transcript overflows and can be scrolled. */
function longAnswer(paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_, i) => `Paragraph ${i + 1} of a deliberately long answer.`,
  ).join('\n\n');
}

test.describe('Chat transcript: stick-to-bottom across layout changes', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    app = await launch(makeScratchProfile());
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('a growing composer re-pins the newest entry instead of stranding it', async () => {
    await scriptTurn(app, { steps: [{ kind: 'delta', text: longAnswer(60) }] });
    await sendViaComposer(shell, 'give me a long answer');
    await flushFake(app);
    await expect(shell.locator(ASSISTANT_MESSAGE).last()).toBeVisible();

    const transcript = shell.locator(TRANSCRIPT);
    const clientHeight = (): Promise<number> => transcript.evaluate((el) => el.clientHeight);

    // The transcript overflowed and followed the answer to the bottom.
    await expect.poll(() => bottomGap(shell), { timeout: 10_000 }).toBeLessThanOrEqual(4);
    const restingHeight = await clientHeight();

    // Grow the composer: this shrinks the transcript's height and fires no
    // scroll event, so before the fix the reader measured "not at the bottom"
    // and the newest entry was left clipped. Wait for the layout to actually
    // change before checking the viewport - otherwise the assertion could pass
    // before the composer had grown at all.
    const draft = Array.from({ length: 15 }, (_, i) => `draft line ${i + 1}`).join('\n');
    await shell.locator(COMPOSER_FIELD).fill(draft);
    await expect.poll(() => clientHeight(), { timeout: 10_000 }).toBeLessThan(restingHeight);
    await expect.poll(() => bottomGap(shell), { timeout: 10_000 }).toBeLessThanOrEqual(4);
  });

  test('a deliberate scroll up is respected, and sending jumps back to the bottom', async () => {
    // A long first delta so the transcript overflows, then several follow-ups
    // that can still arrive while the reader is scrolled up.
    const steps = [
      { kind: 'delta' as const, text: longAnswer(60) },
      ...Array.from({ length: 7 }, (_, i) => ({
        kind: 'delta' as const,
        text: `\n\nFollow-up paragraph ${i + 1}.`,
      })),
    ];
    await scriptTurn(app, { steps });
    await sendViaComposer(shell, 'another long answer');

    // Let the long delta land so the transcript overflows, and confirm it is
    // pinned to the bottom before scrolling away from it.
    for (let i = 0; i < 3; i += 1) expect(await advanceFake(app)).toBe(true);
    await expect(shell.locator(ASSISTANT_MESSAGE).last()).toContainText('Paragraph 60');
    await expect.poll(() => bottomGap(shell), { timeout: 10_000 }).toBeLessThanOrEqual(4);

    // Scroll up to read history while the turn is still streaming.
    await wheelUp(shell);
    await expect.poll(() => bottomGap(shell), { timeout: 10_000 }).toBeGreaterThan(4);

    // The remaining content arrives while the reader is scrolled up. A repaint
    // happened (the last delta is painted), so if following had been misread the
    // viewport would already have been yanked to the bottom.
    await flushFake(app);
    await expect(shell.locator(ASSISTANT_MESSAGE).last()).toContainText('Follow-up paragraph 7');
    expect(await bottomGap(shell)).toBeGreaterThan(4);

    // Sending is deliberate: it jumps back to the bottom regardless.
    await scriptTurn(app, { steps: [{ kind: 'delta', text: 'Done.' }] });
    await sendViaComposer(shell, 'one more');
    await flushFake(app);
    await expect.poll(() => bottomGap(shell), { timeout: 10_000 }).toBeLessThanOrEqual(4);
  });

  test('a tool-call billet as the newest entry is followed to its bottom too', async () => {
    // The follow rule is about the newest *entry*, not only an assistant
    // message: a tool-call billet is appended, and later grows when the reader
    // expands it, and both must land at its bottom.
    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: longAnswer(60) },
        queryStep({ rows: [{ 'jcr:path': '/content/site/a' }], total: 1 }),
      ],
    });
    await sendViaComposer(shell, 'query the site');
    await flushFake(app);

    const billet = shell.locator(TOOL_CALL).last();
    await expect(billet).toBeVisible({ timeout: 30_000 });
    // The billet, not a message, is the last element - and it is on screen to
    // its own bottom, not stranded at its top.
    const lastChild = await shell
      .locator(`${TRANSCRIPT} .chat-transcript__messages`)
      .evaluate((el) => el.lastElementChild?.className ?? '');
    expect(lastChild).toContain('chat-tool-call');
    await expect.poll(() => bottomGap(shell), { timeout: 10_000 }).toBeLessThanOrEqual(4);

    // Expanding the newest billet grows it; the transcript follows that growth
    // to the bottom as well.
    await billet.locator('.chat-tool-call__toggle').click();
    await expect.poll(() => bottomGap(shell), { timeout: 10_000 }).toBeLessThanOrEqual(4);
  });

  test('a table as the newest entry is not rebuilt on later repaints, so the view stays at its bottom', async () => {
    // A `/search` turn: the model's prose is suppressed, so the tall table is
    // the transcript's last entry. Repaints still happen after it lands (the
    // model reasons). Rebuilding the `sp-table` on each repaint momentarily
    // collapses the custom element, and the stick-to-bottom follower can pin to
    // the wrong place - the reported "the whole table re-rendered and the
    // transcript jumped up to its top".
    await scriptTurn(app, {
      steps: [
        formatTableStep(tallTable, 'new'),
        { kind: 'reasoning', text: 'Looking through the results now. ' },
        { kind: 'reasoning', text: 'Comparing the matches. ' },
        { kind: 'reasoning', text: 'Summarising. ' },
      ],
    });
    await sendViaComposer(shell, '/search anything');

    // Deliver events until the table exists.
    for (
      let i = 0;
      i < 50 && (await shell.locator('.chat-table-message sp-table').count()) === 0;
      i += 1
    ) {
      if (!(await advanceFake(app))) break;
    }
    await expect(shell.locator('.chat-table-message sp-table')).toBeVisible();

    // Count `sp-table` elements added to the transcript from now on. A reused
    // table adds none; a rebuild inserts a fresh `sp-table` into its shell on
    // every repaint. (Only a directly-added `sp-table` counts - the transcript
    // re-attaching the table's shell when the Thinking billet appears is not a
    // rebuild.)
    await shell.evaluate(() => {
      const win = window as unknown as { __tableAdds: number };
      win.__tableAdds = 0;
      const target = document.querySelector('.chat-transcript__messages');
      if (target === null) return;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof Element && node.matches('sp-table')) win.__tableAdds += 1;
          }
        }
      }).observe(target, { childList: true, subtree: true });
    });

    // Deliver the remaining events slowly enough for the transcript's 100 ms
    // repaint timer to fire between them - each reasoning delta repaints while
    // the table is on screen.
    for (let i = 0; i < 60; i += 1) {
      if (!(await advanceFake(app))) break;
      await shell.waitForTimeout(150);
    }

    // Those repaints reused the table instead of rebuilding it.
    const added = await shell.evaluate(
      () => (window as unknown as { __tableAdds: number }).__tableAdds,
    );
    expect(added).toBe(0);

    // The turn finished with the table as the newest entry, at its bottom.
    await flushFake(app);
    await expect
      .poll(() =>
        shell
          .locator(`${TRANSCRIPT} .chat-transcript__messages`)
          .evaluate((el) => el.lastElementChild?.className ?? ''),
      )
      .toContain('chat-table-message');
    await expect.poll(() => bottomGap(shell), { timeout: 10_000 }).toBeLessThanOrEqual(4);
  });
});
