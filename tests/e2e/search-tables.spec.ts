// noinspection HtmlUnknownTarget,HtmlRequiredAltAttribute

import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { AEM_QUERY_FORMAT_ASK_TOOL_NAME } from '../../src/tools/aem-query-format-ask/aemQueryFormatAsk';
import { AEM_QUERY_TOOL_NAME } from '../../src/tools/aem-query/aemQuery';
import { type ScriptedStep } from '../../src/main/agents/fakeAgentService';
import { TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY } from '../../src/main/agentComposition';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import {
  CHAT_STATUS_BANNER,
  COMPOSER_SEND,
  sendViaComposer,
  waitForComposerReady,
} from '../support/e2e/composer';
import { flushFake, scriptTurn } from '../support/e2e/fakeAgent';
import { createScratchDirs } from '../support/e2e/profile';

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

const scratchBase = path.resolve(__dirname, '../../test-results', 'search-tables-scratch');

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

const TABLE = '.chat-table-message sp-table';

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

/**
 * A scripted `aem_query_format_ask` call whose successful result carries the
 * turn-complete marker the real composite sets, so the app ends the turn at
 * that result instead of resuming the model.
 */
function finalSearchStep(): ScriptedStep {
  return {
    kind: 'toolCall',
    call: {
      toolName: AEM_QUERY_FORMAT_ASK_TOOL_NAME,
      arguments: { terms: 'waldo' },
      decision: {
        kind: 'approved',
        outcome: {
          ok: true,
          data: {
            operation: AEM_QUERY_FORMAT_ASK_TOOL_NAME,
            turnComplete: true,
            textResultForLlm: 'The search is finished',
            resultType: 'success',
          } as never,
        },
      },
    },
  };
}

const NO_MATCHES = 'Did not find any relevant results so far';
const ONE_MATCH = 'Total: 1';
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
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
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
    await expect(shell.locator('.chat-table-message__total').last()).toContainText('5');
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
    await expect(shell.locator('.chat-table-message sp-table-head-cell')).toHaveCount(2);
    await expect(shell.locator('.chat-table-message sp-table-body sp-table-row')).toHaveCount(2);
    // The prose-suppressed turn left no ordinary assistant message (the table
    // message is itself an assistant message, so exclude it).
    await expect(shell.locator('.chat-message--assistant:not(.chat-table-message)')).toHaveCount(0);
    // An explicit `/name` turn names the skill in the user's own message, so the
    // controller's load marker stays out of the transcript (only a load the
    // model chose gets a billet).
    await expect(shell.locator('.chat-tool-call').filter({ hasText: 'skill' })).toHaveCount(0);

    // The one-click action is visible; clicking it resumes the turn.
    await expect(shell.locator('.chat-ask__action')).toHaveText(/\S/);
    await shell.locator('.chat-ask__action').click();
    await flushFake(app);

    // The append grew the SAME table; the total line now reflects the last page.
    await expect(shell.locator(TABLE)).toHaveCount(1);
    await expect(shell.locator('.chat-table-message sp-table-body sp-table-row')).toHaveCount(3);
    await expect(shell.locator('.chat-table-message__total').last()).toContainText('3');
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

    await expect(shell.locator('.chat-ask__action')).toHaveText(/\S/);
    await shell.locator('.chat-ask__action').click();
    await flushFake(app);

    // The next page's match is appended to the SAME message; the total slot now
    // counts the relevant matches and still reads beneath the table.
    await expect(shell.locator('.chat-table-message')).toHaveCount(tablesBefore + 1);
    await expect(message.locator('sp-table-head-cell')).toHaveCount(4);
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
    // echoes the terms.
    const semanticBillets = shell
      .locator('.chat-tool-call')
      .filter({ hasText: 'aem_semantic_search' });
    await expect(semanticBillets).toHaveCount(2);
    await expect(semanticBillets.nth(1).locator('.chat-tool-call__summary')).toHaveText(/\S/);
  });
  test('a skill the model chose on its own (no /name) hides its prose, keeps the table and shows the load', async () => {
    // A natural-language prompt: `isDeterministicTablePrompt` is false at send,
    // so the prose can only be suppressed retroactively, by the turn's own
    // `skill` call. The leading delta proves the message item is removed even
    // though it was created before the skill was loaded. The load itself is a
    // billet, so a reader can tell the model reached for a skill on its own.
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
            arguments: { name: 'search' },
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
    // search turn leaks prose around its table.
    await expect(shell.locator('.chat-message--assistant:not(.chat-table-message)')).toHaveCount(0);
    // The model-chosen load is visible as its own billet, naming the skill.
    const skillBillets = shell.locator('.chat-tool-call').filter({ hasText: 'skill' });
    await expect(skillBillets).toHaveCount(1);
    await expect(skillBillets.locator('.chat-tool-call__summary')).toHaveText('Load skill search');
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
        formatTableStep({ rows: [] }, 'append', 'Total: 12,345', false),
      ],
    });
    await sendViaComposer(shell, '/search waldo');
    // Deliver up to and including the first format_table's own result.
    await advanceFake(app, 4);

    const message = shell.locator('.chat-table-message').last();
    await expect(message.locator('.chat-table-message__total')).toContainText('5');
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
    await expect(message.locator('.chat-table-message__total')).toContainText('Total: 12,345');
    await expect(message.locator('.chat-table-message__total sp-progress-circle')).toHaveCount(0);
    expect(
      await shell.evaluate(() =>
        document.querySelector('.chat-table-message sp-table')?.getAttribute('data-identity'),
      ),
    ).toBe('kept');
    await flushFake(app);
  });

  test('a Load all revealed after the question appears beside Load more and answers it', async () => {
    // The composite adds "Load all" once its honest total settles, while the
    // "Load more" question is already on screen. The fake delivers that as its
    // own step after the question, so the built app's real IPC + composer path
    // is what shows the button.
    await scriptTurn(app, {
      steps: [{ kind: 'inputRequest', actions: ['Load more'], lateActions: ['Load all'] }],
    });
    await sendViaComposer(shell, '/search waldo');
    // message.started, tool.call.requested, tool.call.approved, user.input.requested.
    await advanceFake(app, 4);

    const actions = shell.locator('.chat-ask__action');
    await expect(actions).toHaveCount(1);
    await expect(actions).toHaveText('Load more');

    await advanceFake(app, 1);
    await expect(actions).toHaveText(['Load more', 'Load all']);

    await actions.nth(1).click();
    await flushFake(app);
    await expect(shell.locator('.chat-ask__actions')).toBeHidden();
  });

  test('a turn-completing search result ends the turn instead of resuming the model for closing prose', async () => {
    const assistantBefore = await shell
      .locator('.chat-message--assistant:not(.chat-table-message)')
      .count();
    await scriptTurn(app, {
      steps: [
        formatTableStep(PAGE_2, 'new', 'Total: 3'),
        finalSearchStep(),
        // What the model would otherwise add. The prompt is natural language (no
        // `/search`), so prose suppression does not apply here: the closing line
        // is absent only because the turn ended at the marked result.
        { kind: 'delta', text: 'The search is finished.' },
      ],
    });
    await sendViaComposer(shell, 'search for waldo');
    await flushFake(app);

    await expect(shell.locator(TABLE).last()).toBeVisible({ timeout: 30_000 });
    // No ordinary assistant bubble: the closing delta was never emitted.
    await expect(shell.locator('.chat-message--assistant:not(.chat-table-message)')).toHaveCount(
      assistantBefore,
    );
    // The turn reached idle: the composer is usable and no "Session stopped"
    // notice was raised for a search that simply finished.
    await expect(shell.locator(CHAT_STATUS_BANNER)).not.toHaveAttribute('open', '');
    await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '');
  });
});
