import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { AEM_QUERY_TOOL_NAME } from '../../src/agent/aemTool';
import type { ScriptedTurn } from '../../src/agent/fakeAgentService';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';

/**
 * Step 08 (docs/implementation-plan.md lines 389-426): the chat pane must
 * render the ACTUAL rows a query returned, and must show the pagination
 * status, against the REAL shipped `out/main/index.js` and its real
 * renderer bundle - not jsdom.
 *
 * What this proves that the unit tests cannot:
 *
 * 1. The Spectrum `<sp-table>` custom elements this build renders are
 *    actually registered in the shipped renderer bundle. The jsdom unit test
 *    would pass just as happily against unregistered tag names, because
 *    jsdom treats an unknown element as an ordinary `HTMLUnknownElement`.
 *    Here the elements must upgrade: `customElements.get("sp-table")` must
 *    resolve, and the table must have a shadow root. If `main.ts`'s
 *    side-effect imports were missing or misspelled, this is the only test
 *    in the suite that would notice.
 *
 * 2. The row data survives the real IPC boundary. A tool result crosses from
 *    the main process through `agent-chat:event` into the renderer via
 *    structured clone; a shape that a unit test hands directly to the store
 *    has never been serialised at all.
 *
 * 3. An author-controlled property value is not parsed as markup in the real
 *    DOM, where a real HTML parser (not jsdom's) is doing the work.
 *
 * The query itself is scripted through `createFakeAgentService` rather than
 * executed against AEM: this step's AEM-side behaviour is covered by
 * `tests/unit/main/aem/**` and its own mutation battery, and a real AEM
 * instance does not arrive until step 12.
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
const COMPOSER_NOTICE = '.chat-composer__notice';
const COMPOSER_FIELD = '.chat-composer textarea';

async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(shell.locator(COMPOSER_NOTICE)).toHaveText('', { timeout: 60_000 });
  await expect(shell.locator(COMPOSER_SEND)).toBeVisible();
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '');
}

async function sendViaComposer(shell: Page, prompt: string): Promise<void> {
  const button = shell.locator(COMPOSER_SEND);
  await expect(button).toBeVisible();
  await shell.locator(COMPOSER_FIELD).fill(prompt);
  await button.click();
}

/** A scripted `aem_query` tool call whose result is `data`. */
function queryTurn(data: unknown): ScriptedTurn {
  return {
    steps: [
      {
        kind: 'toolCall',
        call: {
          toolName: AEM_QUERY_TOOL_NAME,
          arguments: { predicates: { path: '/content/site', type: 'cq:Page' } },
          decision: { kind: 'approved', outcome: { ok: true, data } as never },
        },
      },
    ],
  };
}

const FIRST_PAGE = {
  ok: true,
  operation: 'aem_query',
  requestId: 'req-e2e-1',
  sourceOrigin: 'https://aem.example.com',
  serverRevision: 1,
  predicates: { path: '/content/site', type: 'cq:Page' },
  fetchedAt: 1_700_000_000_000,
  rows: [
    { 'jcr:path': '/content/site/alpha', 'jcr:title': 'Alpha', 'jcr:primaryType': 'cq:Page' },
    {
      'jcr:path': '/content/site/beta',
      'jcr:title': '<img src=x onerror="window.__xss=true" alt="Page">',
      'jcr:primaryType': 'cq:Page',
    },
  ],
  selection: { kind: 'selected', properties: ['jcr:path', 'jcr:title', 'jcr:primaryType'] },
  pagination: {
    offset: 0,
    limit: 2,
    returned: 2,
    hasMore: true,
    total: { accuracy: 'estimated', value: 900 },
  },
};

const LAST_PAGE = {
  ...FIRST_PAGE,
  requestId: 'req-e2e-2',
  rows: [{ 'jcr:path': '/content/site/omega', 'jcr:title': 'Omega', 'jcr:primaryType': 'cq:Page' }],
  pagination: {
    offset: 2,
    limit: 2,
    returned: 1,
    hasMore: false,
    total: { accuracy: 'exact', value: 3 },
  },
};

test.describe('Step 08: query results render as a real table with pagination status', () => {
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

  test('renders the actual result rows in an upgraded Spectrum table', async () => {
    await scriptTurn(app, queryTurn(FIRST_PAGE));
    await sendViaComposer(shell, 'find pages under /content/site');
    await flushFake(app);

    const table = shell.locator('.chat-tool-call sp-table');
    await expect(table).toBeVisible({ timeout: 30_000 });

    // The elements must be REGISTERED custom elements, not unknown tags -
    // the one thing the jsdom unit test structurally cannot check.
    const upgraded = await shell.evaluate(() => ({
      table: customElements.get('sp-table') !== undefined,
      row: customElements.get('sp-table-row') !== undefined,
      cell: customElements.get('sp-table-cell') !== undefined,
      hasShadow: document.querySelector('sp-table')?.shadowRoot !== null,
    }));
    expect(upgraded).toEqual({ table: true, row: true, cell: true, hasShadow: true });

    const cells = await shell.locator('sp-table-body sp-table-row').first().allInnerTexts();
    expect(cells.join(' ')).toContain('/content/site/alpha');
    expect(cells.join(' ')).toContain('Alpha');
  });

  test('shows one header per projected column with jcr:path first', async () => {
    const headers = await shell.locator('sp-table-head-cell').allTextContents();
    expect(headers).toEqual(['jcr:path', 'jcr:title', 'jcr:primaryType']);
  });

  test('states the page shown, the estimated total, and that more results exist', async () => {
    const status = shell.locator('.chat-tool-call__pagination').last();
    await expect(status).toContainText('Showing 1\u20132');
    await expect(status).toContainText('approximately 900 matches');
    await expect(status).toContainText('More results exist');
    // An estimate must never be stated as a fact.
    await expect(status).not.toContainText('This is the last page');
  });

  test('does not execute an author-controlled property value as markup', async () => {
    // Real Chromium, real HTML parser. If the cell were assigned through
    // innerHTML, the `onerror` would have fired by now.
    const xssFired = await shell.evaluate(
      () => (window as unknown as Record<string, unknown>)['__xss'] === true,
    );
    expect(xssFired).toBe(false);
    await expect(shell.locator('.chat-tool-call img')).toHaveCount(0);
    // ...and the literal text still reached the user.
    await expect(shell.locator('.chat-tool-call sp-table')).toContainText('onerror=');
  });

  test('a later page reports its own offset and an exact total without hedging', async () => {
    await scriptTurn(app, queryTurn(LAST_PAGE));
    await sendViaComposer(shell, 'show me the next page');
    await flushFake(app);

    const status = shell.locator('.chat-tool-call__pagination').last();
    await expect(status).toContainText('Showing 3\u20133', { timeout: 30_000 });
    await expect(status).toContainText('3 matches');
    await expect(status).toContainText('This is the last page');
    await expect(status).not.toContainText('approximately');
  });
});
