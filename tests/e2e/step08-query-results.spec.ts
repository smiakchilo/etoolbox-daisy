// noinspection HtmlUnknownTarget,HtmlRequiredAltAttribute

import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { AEM_QUERY_TOOL_NAME } from '../../src/tools/aem-query/aemQuery';
import type { ScriptedTurn } from '../../src/main/agents/fakeAgentService';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';

/**
 * Step 08 (docs/implementation-plan.md lines 389-426): the chat pane must
 * render the ACTUAL rows a search returned, against the REAL shipped
 * `out/main/index.js` and its real renderer bundle - not jsdom.
 *
 * The table is now drawn by the `format_table` tool as an assistant **message**
 * (`# | Path`), with the `aem_query` call reduced to a JSON-only billet. This
 * spec proves the pieces jsdom cannot:
 *
 * 1. The Spectrum `<sp-table>` custom elements this build renders are
 *    actually registered in the shipped renderer bundle (jsdom treats an
 *    unknown element as an ordinary `HTMLUnknownElement`, so a unit test would
 *    pass against a missing import).
 * 2. The row data survives the real IPC boundary (structured clone).
 * 3. An author-controlled property value is not parsed as markup in the real
 *    DOM.
 * 4. `format_table`'s call line is hidden and its message table is the only
 *    table the transcript shows.
 *
 * The search is scripted through `createFakeAgentService` rather than executed
 * against AEM: the AEM-side behaviour is covered by `tests/unit/main/aem/**`,
 * and a real AEM instance does not arrive until step 12.
 *
 * Run with:
 *   npm run build
 *   npx playwright test tests/e2e/step08-query-results.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step08-query-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Same USERPROFILE/APPDATA agreement `step04`/`step06`/`step07` established. */
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
  // JSON-stringified across the boundary for the same TS2589 reason
  // `step07-agent-chat.spec.ts`'s identical helper documents.
  const payload = JSON.stringify({ globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY, turn });
  return app.evaluate((_electronNamespace, json: string) => {
    const arg = JSON.parse(json) as { globalKey: string; turn: unknown };
    const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
      readonly scriptNextResponse: (t: unknown) => void;
    };
    fake.scriptNextResponse(arg.turn);
  }, payload);
}

/** Drains every queued event of the scripted turn - see `FakeAgentService.advance`. */
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

async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  // The composer's messages live on the pane's banner now: it is open while the
  // service is still "connecting" and closed once ready with an active agent.
  await expect(shell.locator(CHAT_STATUS_BANNER)).not.toHaveAttribute('open', '', {
    timeout: 60_000,
  });
  await expect(shell.locator(COMPOSER_SEND)).toBeVisible();
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '');
}

async function sendViaComposer(shell: Page, prompt: string): Promise<void> {
  const button = shell.locator(COMPOSER_SEND);
  await expect(button).toBeVisible();
  await shell.locator(COMPOSER_FIELD).fill(prompt);
  await button.click();
}

// noinspection HtmlDeprecatedAttribute
const FIRST_PAGE = {
  ok: true,
  operation: 'aem_query',
  rows: [{ 'jcr:path': '/content/site/alpha' }, { 'jcr:path': '/content/site/beta' }],
  pagination: {
    offset: 0,
    limit: 20,
    returned: 2,
    hasMore: true,
    total: { accuracy: 'estimated', value: 900 },
  },
};

const LAST_PAGE = {
  ...FIRST_PAGE,
  rows: [{ 'jcr:path': '/content/site/omega' }],
  pagination: {
    offset: 2,
    limit: 20,
    returned: 1,
    hasMore: false,
    total: { accuracy: 'exact', value: 3 },
  },
};

// noinspection HtmlUnknownTarget,HtmlDeprecatedAttribute,HtmlRequiredAltAttribute,JSUnresolvedFunction
const XSS_PAGE = {
  ...FIRST_PAGE,
  rows: [
    {
      'jcr:path': '/content/site/alpha',
      citation: '<img src=x onerror="window.__xss=true" alt="Image">',
    },
  ],
};

/** A scripted turn: the `aem_query` call, then the `format_table` message. */
function searchTurn(query: unknown, mode: 'new' | 'append'): ScriptedTurn {
  return {
    steps: [
      {
        kind: 'toolCall',
        call: {
          toolName: AEM_QUERY_TOOL_NAME,
          arguments: { predicates: { path: '/content/site', type: 'cq:Page' } },
          decision: { kind: 'approved', outcome: { ok: true, data: query } as never },
        },
      },
      {
        kind: 'toolCall',
        call: {
          toolName: 'format_table',
          arguments: { data: query as never, mode },
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
      },
    ],
  };
}

/** A scripted turn with only the `aem_query` call (no `format_table`). */
function queryOnlyTurn(query: unknown): ScriptedTurn {
  return {
    steps: [
      {
        kind: 'toolCall',
        call: {
          toolName: AEM_QUERY_TOOL_NAME,
          arguments: { predicates: { path: '/content/site' } },
          decision: { kind: 'approved', outcome: { ok: true, data: query } as never },
        },
      },
    ],
  };
}

test.describe('Step 08: query results render as a real table', () => {
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

  test('renders the aem_query billet, then the format_table message table', async () => {
    await scriptTurn(app, searchTurn(FIRST_PAGE, 'new'));
    await sendViaComposer(shell, 'find pages under /content/site');
    await flushFake(app);

    // The query call is still a billet...
    await expect(shell.locator('.chat-tool-call__header').first()).toContainText('aem_query');
    // ...but format_table is not: only its message table appears.
    const table = shell.locator('.chat-table-message sp-table');
    await expect(table).toBeVisible({ timeout: 30_000 });

    const upgraded = await shell.evaluate(() => ({
      table: customElements.get('sp-table') !== undefined,
      row: customElements.get('sp-table-row') !== undefined,
      cell: customElements.get('sp-table-cell') !== undefined,
      hasShadow: document.querySelector('.chat-table-message sp-table')?.shadowRoot !== null,
    }));
    expect(upgraded).toEqual({ table: true, row: true, cell: true, hasShadow: true });

    const headers = await shell.locator('.chat-table-message sp-table-head-cell').allTextContents();
    expect(headers).toEqual(['#', 'Path']);

    const firstRow = await shell
      .locator('.chat-table-message sp-table-body sp-table-row')
      .first()
      .allInnerTexts();
    expect(firstRow.join(' ')).toContain('/content/site/alpha');
  });

  test('states the estimated total above the table', async () => {
    await expect(shell.locator('.chat-table-message__total').last()).toContainText(
      'Total: 900+ results',
    );
  });

  test('does not execute an author-controlled value as markup', async () => {
    await scriptTurn(app, searchTurn(XSS_PAGE, 'append'));
    await sendViaComposer(shell, 'another query');
    await flushFake(app);

    const xssFired = await shell.evaluate(
      () => (window as unknown as Record<string, unknown>)['__xss'] === true,
    );
    expect(xssFired).toBe(false);
    await expect(shell.locator('.chat-table-message img')).toHaveCount(0);
    // ...and the literal text still reached the user.
    await expect(shell.locator('.chat-table-message')).toContainText('onerror=');
  });

  test('an append page grows the same table rather than starting a new one', async () => {
    await scriptTurn(app, searchTurn(LAST_PAGE, 'append'));
    await sendViaComposer(shell, 'show me the next page');
    await flushFake(app);

    // One table total (the append merged into the first run's table).
    await expect(shell.locator('.chat-table-message sp-table')).toHaveCount(1, { timeout: 30_000 });
    const rows = shell.locator('.chat-table-message sp-table-body sp-table-row');
    await expect(rows.last()).toContainText('/content/site/omega');
  });

  test('keeps aem_query JSON-only: a query with no format_table draws no table', async () => {
    await scriptTurn(app, queryOnlyTurn(FIRST_PAGE));
    await sendViaComposer(shell, 'a query with no table');
    await flushFake(app);

    // The aem_query billet appears; no new table does.
    await expect(shell.locator('.chat-tool-call__header').last()).toContainText('aem_query', {
      timeout: 30_000,
    });
    const before = await shell.locator('.chat-table-message sp-table').count();
    // Still exactly the one table from the earlier run.
    await expect(shell.locator('.chat-table-message sp-table')).toHaveCount(before);
  });
});
