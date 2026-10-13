// noinspection HtmlUnknownTarget,HtmlRequiredAltAttribute

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
 * The deterministic search-table flows, against the BUILT app.
 *
 * A `/search` turn and a `/semantic-search` turn each produce exactly one
 * application-rendered table: `/search` a `# | Path` table with a total line,
 * driven by `aem_query_format_ask` (its nested `format_table` call) and continued
 * with a one-click "Load more";
 * `/semantic-search` a `# | Path | Property | Citation` table with the same
 * total slot, driven by `aem_semantic_search`, counting the relevant matches (or
 * saying none were found so far).
 * The application suppresses the model's own prose for these turns.
 *
 * The deterministic fake scripts the tool calls and the `ask_user` action, so
 * the composer -> IPC -> turn loop and the real Spectrum table are exercised
 * with no model and no AEM instance.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/search-tables.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'search-tables-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function makeScratchProfile(): { home: string; appData: string; localAppData: string } {
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

function launch(profile: ReturnType<typeof makeScratchProfile>): Promise<ElectronApp> {
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

function scriptTurn(app: ElectronApp, turn: ScriptedTurn): Promise<void> {
  const payload = JSON.stringify({ globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY, turn });
  return app.evaluate((_electronNamespace, json: string) => {
    const arg = JSON.parse(json) as { globalKey: string; turn: unknown };
    const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
      readonly scriptNextResponse: (t: unknown) => void;
    };
    fake.scriptNextResponse(arg.turn);
  }, payload);
}

async function flushFake(app: ElectronApp): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    const delivered = await app.evaluate((_electronNamespace, key: string) => {
      const fake = (globalThis as Record<string, unknown>)[key] as {
        readonly advance: () => boolean;
      };
      return fake.advance();
    }, TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY);
    if (!delivered) return;
  }
  throw new Error('flushFake exceeded its guard - the fake never drained.');
}

/** Delivers exactly `count` scripted events, so a test can observe the turn mid-flight. */
async function advanceFake(app: ElectronApp, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const delivered = await app.evaluate((_electronNamespace, key: string) => {
      const fake = (globalThis as Record<string, unknown>)[key] as {
        readonly advance: () => boolean;
      };
      return fake.advance();
    }, TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY);
    if (!delivered) throw new Error('advanceFake ran out of scripted events early.');
  }
}

const COMPOSER_SEND = '.chat-composer__send';
const CHAT_STATUS_BANNER = '.chat-status-banner';
const COMPOSER_FIELD = '.chat-composer textarea';
const TABLE = '.chat-table-message sp-table';

async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(shell.locator(CHAT_STATUS_BANNER)).not.toHaveAttribute('open', '', {
    timeout: 60_000,
  });
  await expect(shell.locator(COMPOSER_SEND)).toBeVisible();
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '');
}

async function sendViaComposer(shell: Page, prompt: string): Promise<void> {
  await shell.locator(COMPOSER_FIELD).fill(prompt);
  await shell.locator(COMPOSER_SEND).click();
}

/** A scripted `aem_query` tool call whose result is `data`. */
function queryStep(
  data: unknown,
  predicates: Record<string, string> = { path: '/content/site' },
): ScriptedStep {
  return {
    kind: 'toolCall',
    call: {
      toolName: AEM_QUERY_TOOL_NAME,
      arguments: { predicates },
      decision: { kind: 'approved', outcome: { ok: true, data } as never },
    },
  };
}

/** A scripted `format_table` tool call carrying `data` verbatim. */
function formatTableStep(
  data: unknown,
  mode: 'new' | 'append',
  totalLine?: string,
  totalPending?: boolean,
): ScriptedStep {
  return {
    kind: 'toolCall',
    call: {
      toolName: 'format_table',
      arguments: {
        data: data as never,
        mode,
        ...(totalLine !== undefined ? { totalLine } : {}),
        ...(totalPending !== undefined ? { totalPending } : {}),
      },
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

const PAGE_1 = {
  rows: [{ 'jcr:path': '/content/site/a' }, { 'jcr:path': '/content/site/b' }],
  pagination: { hasMore: true, total: { accuracy: 'atLeast', value: 5 } },
};
const PAGE_2 = {
  rows: [{ 'jcr:path': '/content/site/c' }],
  pagination: { hasMore: false, total: { accuracy: 'exact', value: 3 } },
};

/**
 * A scripted `aem_semantic_search` call. In the real app the tool's nested
 * `format_table` / `ask_user` calls are journaled flat, as if the model made
 * them, so the fake scripts them as their own steps.
 */
function semanticStep(args: Record<string, unknown>): ScriptedStep {
  return {
    kind: 'toolCall',
    call: {
      toolName: 'aem_semantic_search',
      arguments: args as never,
      decision: {
        kind: 'approved',
        outcome: {
          ok: true,
          data: {
            operation: 'aem_semantic_search',
            terms: 'waldo',
            textResultForLlm: 'ok',
            resultType: 'success',
          } as never,
        },
      },
    },
  };
}

const NO_MATCHES = 'Did not find any relevant results so far';
const ONE_MATCH = 'Total: 1 relevant result';
const SEMANTIC_EMPTY = {
  rows: [],
  pagination: { hasMore: true, total: { accuracy: 'atLeast', value: 60 } },
};
const SEMANTIC = {
  rows: [
    {
      // The concrete node path and the bare property name, as the executor now
      // produces them (not the page the query matched).
      'jcr:path': '/content/wknd/us/en/about/waldo/jcr:content',
      property: 'jcr:description',
      citation: 'Waldo is a good guy and a generous donor.',
    },
  ],
  pagination: { hasMore: false, total: { accuracy: 'exact', value: 4 } },
};

test.describe('deterministic search tables', () => {
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

  test('a /search run shows a total line and a # | Path table, and Load more appends to it', async () => {
    await scriptTurn(app, {
      steps: [
        queryStep(PAGE_1, { fulltext: 'waldo' }),
        formatTableStep(PAGE_1, 'new'),
        { kind: 'inputRequest', actions: ['Load more'] },
        queryStep(PAGE_2, { fulltext: 'waldo' }),
        formatTableStep(PAGE_2, 'append'),
      ],
    });
    await sendViaComposer(shell, '/search waldo');
    // The turn pauses on the unanswered "Load more" action.
    await flushFake(app);

    await expect(shell.locator(TABLE)).toBeVisible({ timeout: 30_000 });
    await expect(shell.locator('.chat-table-message__total').last()).toContainText(
      'Total: 5+ results',
    );
    // The owner's fix: the total line reads BELOW the table, not above it.
    const totalBelowTable = await shell
      .locator('.chat-table-message')
      .last()
      .evaluate((element) => {
        const total = element.querySelector('.chat-table-message__total');
        const table = element.querySelector('sp-table');
        if (total === null || table === null) return false;
        // 4 = Node.DOCUMENT_POSITION_FOLLOWING.
        return (table.compareDocumentPosition(total) & 4) !== 0;
      });
    expect(totalBelowTable).toBe(true);
    await expect(shell.locator('.chat-table-message sp-table-head-cell')).toHaveText(['#', 'Path']);
    await expect(shell.locator('.chat-table-message sp-table-body sp-table-row')).toHaveCount(2);
    // The prose-suppressed turn left no ordinary assistant message (the table
    // message is itself an assistant message, so exclude it).
    await expect(shell.locator('.chat-message--assistant:not(.chat-table-message)')).toHaveCount(0);

    // The one-click action is visible; clicking it resumes the turn.
    await expect(shell.locator('.chat-ask__action')).toHaveText('Load more');
    await shell.locator('.chat-ask__action').click();
    await flushFake(app);

    // The append grew the SAME table; the total line now reflects the last page.
    await expect(shell.locator(TABLE)).toHaveCount(1);
    await expect(shell.locator('.chat-table-message sp-table-body sp-table-row')).toHaveCount(3);
    await expect(shell.locator('.chat-table-message__total').last()).toContainText(
      'Total: 3 results',
    );
  });

  test('a /semantic-search run says no matches so far in the total slot, then appends matches and counts them', async () => {
    const tablesBefore = await shell.locator('.chat-table-message').count();
    await scriptTurn(app, {
      steps: [
        semanticStep({ terms: 'waldo', context: 'Waldo is good' }),
        formatTableStep(SEMANTIC_EMPTY, 'new', NO_MATCHES),
        { kind: 'inputRequest', actions: ['Load more'] },
        semanticStep({ searchId: 'sem-1', matches: [] }),
        formatTableStep(SEMANTIC, 'append', ONE_MATCH),
      ],
    });
    await sendViaComposer(shell, '/semantic-search good waldo');
    await flushFake(app);

    // The tool call itself is a billet; the run's table message starts empty,
    // with "no relevant results so far" in the total slot instead of a table.
    const semanticStartBillet = shell
      .locator('.chat-tool-call')
      .filter({ hasText: 'aem_semantic_search' })
      .first();
    await expect(semanticStartBillet).toBeVisible({ timeout: 30_000 });
    // The summary is the terms alone - the header already names the tool, so the
    // billet must not print "semantic search" twice.
    await expect(semanticStartBillet.locator('.chat-tool-call__summary')).toHaveText('waldo');
    await expect(shell.locator('.chat-table-message')).toHaveCount(tablesBefore + 1);
    const message = shell.locator('.chat-table-message').last();
    await expect(message.locator('.chat-table-message__total')).toHaveText(NO_MATCHES);
    await expect(message.locator('sp-table')).toHaveCount(0);

    await expect(shell.locator('.chat-ask__action')).toHaveText('Load more');
    await shell.locator('.chat-ask__action').click();
    await flushFake(app);

    // The next page's match is appended to the SAME message; the total slot now
    // counts the relevant matches and still reads beneath the table.
    await expect(shell.locator('.chat-table-message')).toHaveCount(tablesBefore + 1);
    await expect(message.locator('sp-table-head-cell')).toHaveText([
      '#',
      'Path',
      'Property',
      'Citation',
    ]);
    await expect(message.locator('sp-table-body sp-table-row')).toHaveCount(1);
    // The new column semantics: Path is the concrete node the property lives
    // on, Property the bare name, and the Property cell the wrap-at-any-
    // character class the Path link also gets.
    await expect(message.locator('sp-table-body sp-table-cell').nth(1)).toContainText(
      '/content/wknd/us/en/about/waldo/jcr:content',
    );
    await expect(message.locator('sp-table-body .chat-table-message__wrap')).toHaveText(
      'jcr:description',
    );
    await expect(message.locator('.chat-table-message__total')).toHaveText(ONE_MATCH);
    const totalBelowTable = await message.evaluate((element) => {
      const total = element.querySelector('.chat-table-message__total');
      const table = element.querySelector('sp-table');
      if (total === null || table === null) return false;
      // 4 = Node.DOCUMENT_POSITION_FOLLOWING.
      return (table.compareDocumentPosition(total) & 4) !== 0;
    });
    expect(totalBelowTable).toBe(true);
    await expect(shell.locator('.chat-message--assistant:not(.chat-table-message)')).toHaveCount(0);
    // The continue call (`{ searchId, matches }`) carries no terms: it is
    // summarised by its matches, never as a blank label - even though its result
    // echoes the terms - and without repeating the tool name.
    const semanticContinueBillet = shell
      .locator('.chat-tool-call')
      .filter({ hasText: 'judging 0 matches' })
      .first();
    await expect(semanticContinueBillet).toBeVisible();
    await expect(semanticContinueBillet.locator('.chat-tool-call__summary')).toHaveText(
      'judging 0 matches',
    );
  });
  test('a skill the model chose on its own (no /name) hides its prose and keeps the table', async () => {
    // A natural-language prompt: `isDeterministicTablePrompt` is false at send,
    // so the prose can only be suppressed retroactively, by the turn's own
    // internal `skill` call (which the store hides). The leading delta proves
    // the message item is removed even though it was created before the skill
    // was loaded.
    const AUTO_PATH = '/content/wknd/auto-inferred-only';
    const AUTO = {
      rows: [{ 'jcr:path': AUTO_PATH }],
      pagination: { hasMore: false, total: { accuracy: 'exact', value: 1 } },
    };
    const tablesBefore = await shell.locator('.chat-table-message').count();
    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'Let me search for that.' },
        {
          kind: 'toolCall',
          call: {
            toolName: 'skill',
            arguments: { skill: 'search' },
            decision: { kind: 'approved', outcome: { ok: true, data: {} } },
          },
        },
        formatTableStep(AUTO, 'new'),
      ],
    });
    await sendViaComposer(shell, 'find content about waldo');
    await flushFake(app);

    // This turn really ran: its own prompt and its own new table appeared. (The
    // previous runs' tables remain, so a bare `.last()` assertion would pass
    // even if this turn never fired.)
    await expect(shell.locator('.chat-message--user').last()).toHaveText(
      'find content about waldo',
    );
    await expect(shell.locator('.chat-table-message')).toHaveCount(tablesBefore + 1, {
      timeout: 30_000,
    });
    await expect(shell.locator('.chat-table-message').last()).toContainText(AUTO_PATH);
    // Every assistant message on screen is a table message: no auto-inferred
    // search turn leaks prose around its table, and the internal `skill` call
    // is not rendered as a billet.
    await expect(shell.locator('.chat-message--assistant:not(.chat-table-message)')).toHaveCount(0);
    await expect(shell.locator('.chat-tool-call').filter({ hasText: 'skill' })).toHaveCount(0);
  });

  test('a counting total shows a spinner, then updates in place without rebuilding the table', async () => {
    // The application runs a background honest count when page 1's total is a
    // lower bound; while it runs every `format_table` call carries
    // `totalPending: true`, and the settle call carries the exact total. The
    // fake scripts those calls directly (it does not run the composite), so
    // this proves the renderer: a real `sp-progress-circle`, the total updating
    // in place, the spinner gone, and the same `<sp-table>` node kept.
    await scriptTurn(app, {
      steps: [
        formatTableStep(PAGE_1, 'new', undefined, true),
        formatTableStep({ rows: [] }, 'append', 'Total: 12,345 results', false),
      ],
    });
    await sendViaComposer(shell, '/search waldo');
    // Deliver up to and including the first format_table's own result.
    await advanceFake(app, 4);

    const message = shell.locator('.chat-table-message').last();
    await expect(message.locator('.chat-table-message__total')).toContainText('Total: 5+ results');
    const spinner = message.locator('.chat-table-message__total sp-progress-circle');
    await expect(spinner).toHaveCount(1);
    // jsdom cannot prove a custom element is registered or shadow-rendered; the
    // built app can. A real spinner with a real shadow root, not an unknown tag.
    const registered = await shell.evaluate(() => {
      const element = document.querySelector('.chat-table-message__total sp-progress-circle');
      return {
        hasDefinition: customElements.get('sp-progress-circle') !== undefined,
        hasShadowRoot: element !== null && element.shadowRoot !== null,
      };
    });
    expect(registered.hasDefinition).toBe(true);
    expect(registered.hasShadowRoot).toBe(true);
    await expect(message.locator('sp-table-body sp-table-row')).toHaveCount(2);
    // Tag the table so the next assertion can prove it was not rebuilt.
    await shell.evaluate(() => {
      document.querySelector('.chat-table-message sp-table')?.setAttribute('data-identity', 'kept');
    });

    // The settle call arrives: the total updates and the spinner goes, in place.
    await advanceFake(app, 1);
    await expect(message.locator('.chat-table-message__total')).toContainText(
      'Total: 12,345 results',
    );
    await expect(message.locator('.chat-table-message__total sp-progress-circle')).toHaveCount(0);
    expect(
      await shell.evaluate(() =>
        document.querySelector('.chat-table-message sp-table')?.getAttribute('data-identity'),
      ),
    ).toBe('kept');
    await flushFake(app);
  });
});
