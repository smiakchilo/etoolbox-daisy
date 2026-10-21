import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import type { ScriptedStep } from '../../src/main/agents/fakeAgentService';
import { mainEntry, type ElectronApp } from '../support/e2e/app';
import { sendViaComposer, COMPOSER_SEND, waitForComposerReady } from '../support/e2e/composer';
import { advanceFake, scriptTurn } from '../support/e2e/fakeAgent';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * An interrupted tool call must never keep spinning - live, and again after the
 * app restarts and repaints the conversation from its journal.
 *
 * Reported: a turn cancelled by a navigation left its running
 * `aem_query_format_ask` billet spinning beside the "Session interrupted by
 * navigation" notice, and it was *still* spinning after a restart.
 *
 * Root cause (measured, not guessed). The transcript store keeps a separate
 * "is anything running?" index beside the tool calls themselves, and the
 * interruption notice only emptied that index - the call's own status stayed
 * `requested`, which is what the billet paints its spinner from. A journal
 * replay settles every call the journal left running, but it replays the
 * `interruption` record *first*, which emptied the index too, so the final
 * settle found nothing left to settle and the spinner came back forever.
 *
 * The spec drives the real built app twice: run 1 stops a turn while a tool
 * call is approved and running (the fake agent still has that call's result
 * queued, and discards it - exactly what a real abort does), then run 2
 * relaunches and repaints the same conversation from the journal.
 *
 *   npm run build
 *   npx playwright test tests/e2e/chat-interrupted-tool-call.spec.ts
 */

const scratchBase = path.resolve(
  __dirname,
  '../../test-results',
  'chat-interrupted-tool-call-scratch',
);

const PROMPT = 'read a page for me';
const TOOL_CALL = '.chat-tool-call';
/** The indeterminate spinner a *running* billet wears in place of its tool icon. */
const RUNNING_ICON = `${TOOL_CALL} sp-progress-circle`;
/** The static tool icon a settled billet wears. */
const SETTLED_ICON = `${TOOL_CALL} sp-icon-actions`;
const INTERRUPTION = '.chat-message--interruption';

/** A scripted tool call whose result the fake queues but does not deliver yet. */
const READ_PAGE: ScriptedStep = {
  kind: 'toolCall',
  call: {
    toolName: 'aem_get_json',
    arguments: { path: '/content/site' },
    decision: {
      kind: 'approved',
      outcome: { ok: true, data: { path: '/content/site', status: 200 } } as never,
    },
  },
};

/**
 * Advances the fake one event at a time until the billet shows its running
 * spinner, so the turn is stopped with the call's result still queued - the
 * state a real abort leaves behind.
 */
async function advanceUntilRunning(app: ElectronApp, page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await page.locator(RUNNING_ICON).count()) > 0) return;
    await advanceFake(app);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the tool call never showed a running billet');
}

test.describe('an interrupted tool call', () => {
  test('stops spinning when its turn is stopped, and stays settled after a restart', async () => {
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

    // --- run 1: stop a turn with a running tool call -------------------------
    const first = await electron.launch({ args: [mainEntry], env: profile.env });
    const firstPage = await first.firstWindow();
    await firstPage.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
    await waitForComposerReady(firstPage, { awaitBannerClosed: false, expectSendVisible: false });

    await scriptTurn(first, { steps: [READ_PAGE] });
    await sendViaComposer(firstPage, PROMPT, { requireEnabled: true });
    await advanceUntilRunning(first, firstPage);

    await firstPage.locator('.chat-composer__stop').click();

    // The live half: the stopped turn's call settles - the static tool icon, no
    // spinner, no progress line - beside the interruption notice.
    await expect(firstPage.locator(INTERRUPTION)).toBeVisible({ timeout: 15_000 });
    await expect(firstPage.locator(RUNNING_ICON)).toHaveCount(0);
    await expect(firstPage.locator(SETTLED_ICON)).toHaveCount(1);
    await expect(firstPage.locator(COMPOSER_SEND)).toBeVisible({ timeout: 15_000 });
    await first.close();

    // --- run 2: the restored transcript repaints the same, settled billet -----
    const second = await electron.launch({ args: [mainEntry], env: profile.env });
    const secondPage = await second.firstWindow();
    await waitForComposerReady(secondPage, { awaitBannerClosed: false, expectSendVisible: false });
    await expect(secondPage.locator('.chat-message--user')).toContainText(PROMPT, {
      timeout: 60_000,
    });
    await expect(secondPage.locator(TOOL_CALL)).toBeVisible();
    await expect(secondPage.locator(INTERRUPTION)).toBeVisible();

    // The reported defect: this used to be the indeterminate spinner forever.
    await expect(secondPage.locator(RUNNING_ICON)).toHaveCount(0);
    await expect(secondPage.locator(SETTLED_ICON)).toHaveCount(1);
    await expect(secondPage.locator(`${TOOL_CALL} .chat-tool-call__progress`)).toBeHidden();

    await second.close();
    server.close();
  });
});
