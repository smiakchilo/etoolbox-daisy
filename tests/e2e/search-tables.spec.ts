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
 * driven by `format_table` and continued with a one-click "Load more";
 * `/semantic-search` a `# | Path | Property | Citation` table with no total.
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

const PAGE_1 = {
  rows: [{ 'jcr:path': '/content/site/a' }, { 'jcr:path': '/content/site/b' }],
  pagination: { hasMore: true, total: { accuracy: 'estimated', value: 5 } },
};
const PAGE_2 = {
  rows: [{ 'jcr:path': '/content/site/c' }],
  pagination: { hasMore: false, total: { accuracy: 'exact', value: 3 } },
};

const SEMANTIC = {
  rows: [
    {
      'jcr:path': '/content/wknd/us/en/about/waldo',
      property: 'jcr:content/jcr:description',
      citation: 'Waldo is a good guy and a generous donor.',
    },
  ],
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

  test('a /semantic-search run shows a # | Path | Property | Citation table with no total line', async () => {
    await scriptTurn(app, {
      steps: [queryStep(SEMANTIC, { fulltext: 'waldo' }), formatTableStep(SEMANTIC, 'new')],
    });
    await sendViaComposer(shell, '/semantic-search good waldo');
    await flushFake(app);

    const tables = shell.locator('.chat-table-message sp-table');
    await expect(tables.last()).toBeVisible({ timeout: 30_000 });
    // Retrying matcher rather than a one-shot read: the semantic run's table
    // repaints after `flushFake`, and under load `.last()` can still be the
    // previous run's two-column table for a frame.
    await expect(
      shell.locator('.chat-table-message').last().locator('sp-table-head-cell'),
    ).toHaveText(['#', 'Path', 'Property', 'Citation']);
    // No total line for the semantic run (the search table's line, if present,
    // belongs to a different message).
    await expect(
      shell.locator('.chat-table-message').last().locator('.chat-table-message__total'),
    ).toHaveCount(0);
  });
});
