import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { waitForComposerReady } from '../support/e2e/composer';
import {
  closeFixtureServer,
  listenOnLoopback,
  startFixtureServer,
  switchHost,
} from '../support/e2e/hostFixture';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { readRevealedPaths, stubShowItemInFolder } from '../support/e2e/shellStubs';
import { byTestId } from '../support/selectors';
import { TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY } from '../../src/main/agentComposition';

/**
 * The History panel, proven against the real built app.
 *
 * The list is derived from real journal files on disk and the panel is a
 * Spectrum/DOM surface over the suspended native view, so neither is provable
 * in jsdom. The deterministic fake agent service is used (the same switch
 * `chat-restore.spec.ts` uses), so no Copilot sign-in is needed and the SDK
 * "resume" always succeeds.
 *
 * Flow: one host; send a first prompt; start a New session and send a second;
 * open History and assert both rows (title, host, date) and that the panel's
 * single travelling set of actions is revealed only by the row it has reached;
 * resume the first and assert its transcript returns; reveal the second's file
 * in the OS file manager; delete the second (confirmed in the pane's alert
 * banner) and assert the row is gone.
 *
 *   npm run build
 *   npx playwright test tests/e2e/history.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'history-scratch');

async function sendViaComposer(page: Page, prompt: string): Promise<void> {
  await page.locator('.chat-composer textarea').fill(prompt);
  await page.locator('.chat-composer__send').click();
  await expect(page.locator('.chat-message--user')).toContainText(prompt, { timeout: 30_000 });
}

function row(page: Page, text: string) {
  return page.locator(byTestId('history-item'), { hasText: text });
}

/** The journal files a profile has written, under `<home>/etoolbox-daisy/chats`. */
function journalFiles(home: string): readonly string[] {
  const dir = path.join(home, 'etoolbox-daisy', 'chats');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name));
}

/** Every `sessionId` the live fake agent was asked to delete, in order. */
function readDeletedSessionIds(app: ElectronApplication): Promise<readonly string[]> {
  return app.evaluate((_electronNamespace, globalKey: string) => {
    const fake = (globalThis as Record<string, unknown>)[globalKey] as {
      readonly deletedSessionIds: () => readonly string[];
    };
    return fake.deletedSessionIds();
  }, TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY);
}

test.describe('History panel', () => {
  test('lists stored conversations, resumes one, and deletes another', async () => {
    test.setTimeout(180_000);
    const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
    const home = env['USERPROFILE'] ?? '';

    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>echo</title><p>ok</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    const echoId = randomUUID();

    const base = defaultAppSettings();
    writeSettings(
      home,
      appSettingsSchema.parse({
        ...base,
        hosts: [
          ...base.hosts,
          {
            id: echoId,
            label: 'Echo',
            origin,
            color: { kind: 'swatch', swatch: 'blue' },
            revision: 0,
          },
        ],
      }),
    );

    const app = await electron.launch({ args: [mainEntry], env });
    try {
      const page = await app.firstWindow();
      // Switch through the awaited IPC, not the picker's fire-and-forget click:
      // the chat records the host it is first used on, and a prompt sent while
      // the switch is still settling records none.
      await switchHost(page, echoId);
      await waitForComposerReady(page, { expectSendVisible: false });

      // Two conversations, so History has something to distinguish.
      await sendViaComposer(page, 'first question about media');
      await page.locator(byTestId('chat-new-session')).click();
      await expect(page.locator('.chat-message--user')).toHaveCount(0, { timeout: 30_000 });
      await sendViaComposer(page, 'second question about assets');

      // The History button opens the panel; both chats are listed, newest first.
      await page.locator(byTestId('chat-history')).click();
      await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(byTestId('history-item'))).toHaveCount(2, { timeout: 30_000 });

      const firstRow = row(page, 'first question about media');
      const secondRow = row(page, 'second question about assets');
      await expect(firstRow).toBeVisible();
      await expect(secondRow).toBeVisible();
      // Each row carries a formatted start date and the host the chat was first
      // *used* on. The first chat's header was still deferred when it was opened
      // at startup (before any host was picked), so it takes the host its first
      // prompt named; the second opened after the page loaded, so it names Echo
      // too.
      await expect(firstRow.locator('.history-item__date')).not.toBeEmpty();
      await expect(firstRow.locator('.history-item__server-label')).toHaveText('Echo');
      await expect(secondRow.locator('.history-item__server-label')).toHaveText('Echo');

      // One travelling set of the *other* actions (Reveal / Delete) for the
      // whole list, never one per row: it starts on the top row, whose open
      // button the panel focused when its first batch painted, and it is hidden
      // while that row is neither hovered nor focused.
      await expect(page.locator(byTestId('history-actions'))).toHaveCount(1);
      await expect(secondRow.locator(byTestId('history-reveal'))).toBeVisible();
      await page.locator(byTestId('history-panel-close')).focus();
      await expect(secondRow.locator(byTestId('history-reveal'))).toBeHidden();

      // Reaching another row carries the actions to it, leaving no buttons at
      // all on the rows it has left.
      await firstRow.hover();
      await expect(firstRow.locator(byTestId('history-actions'))).toHaveCount(1);
      await expect(firstRow.locator(byTestId('history-reveal'))).toBeVisible();
      await expect(secondRow.locator(byTestId('history-reveal'))).toHaveCount(0);

      // Resuming is the row itself: no Resume control is left anywhere, and
      // every row carries its own open button instead.
      await expect(page.locator(byTestId('history-resume'))).toHaveCount(0);
      await expect(page.locator(byTestId('history-open'))).toHaveCount(2);
      await expect(firstRow.locator(byTestId('history-actions'))).toHaveCount(1);

      // Reveal in folder and the chat footer's reveal-log control are the same
      // action, so they must wear the same glyph: two names for one thing cannot
      // drift apart.
      const glyph = (locator: ReturnType<Page['locator']>) =>
        locator.evaluate((element) => element.firstElementChild?.tagName.toLowerCase() ?? '');
      expect(await glyph(firstRow.locator(byTestId('history-reveal')))).toBe(
        await glyph(page.locator(byTestId('chat-reveal-log'))),
      );

      // Newest first: the second chat sits above the first.
      const order = await page.locator('.history-item__title').allInnerTexts();
      expect(order[0]).toContain('second question about assets');

      // Clicking the row resumes it: the panel closes and the transcript
      // returns. The click lands on the row's text (its center), never on the
      // travelling action strip at the right edge.
      await firstRow.click();
      await expect(page.locator(byTestId('history-panel'))).not.toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.chat-message--user')).toContainText(
        'first question about media',
        {
          timeout: 30_000,
        },
      );

      // Delete the second: the confirmation is the pane's one-button alert
      // banner (the same prompt Settings uses for a removal), never a
      // row-local dialog.
      await page.locator(byTestId('chat-history')).click();
      await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(byTestId('history-item'))).toHaveCount(2, { timeout: 30_000 });
      await secondRow.hover();
      await secondRow.locator(byTestId('history-delete')).click();
      const confirmBanner = page.locator('.surface-status-banner[open]');
      await expect(confirmBanner).toHaveText(/\S/);
      const confirmOk = confirmBanner.locator(byTestId('banner-confirm'));
      await confirmOk.click();
      await expect(page.locator(byTestId('history-item'))).toHaveCount(1, { timeout: 30_000 });
      await expect(row(page, 'second question about assets')).toHaveCount(0);
      await expect(row(page, 'first question about media')).toBeVisible();
      // The outcome takes the same banner row after the confirmation clears.
      await expect(page.locator('.surface-status-banner[open]')).toHaveText(/\S/);
    } finally {
      await app.close();
      server.close();
    }
  });

  test('deleting a chat whose journal recorded several sessions removes every session', async () => {
    test.setTimeout(180_000);
    const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
    const home = env['USERPROFILE'] ?? '';

    const app = await electron.launch({ args: [mainEntry], env });
    try {
      const page = await app.firstWindow();
      await waitForComposerReady(page, { expectSendVisible: false });
      await sendViaComposer(page, 'a chat that will be recycled');

      // This chat now has one journal, whose header names its first SDK session.
      const journalPaths = journalFiles(home);
      expect(journalPaths).toHaveLength(1);
      const journalPath = journalPaths[0];
      if (journalPath === undefined) throw new Error('no journal was written');
      const records = readFileSync(journalPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const header = records.find((record) => record['recordType'] === 'header');
      const chatId = header?.['chatId'];
      const headerSession = header?.['sessionId'];
      if (typeof chatId !== 'string' || typeof headerSession !== 'string') {
        throw new Error('the journal has no header');
      }

      // A runtime recycle re-opens the same chat under a new SDK session; this
      // is the exact record `chatJournal.openChat` appends for it. The fake
      // cannot recycle itself (its `reconcile` is deliberately inert), so the
      // second session is written here rather than driven through Settings -
      // the point under test is deletion, not how the record came to exist.
      const recycledSession = 'sdk-recycled-e2e';
      appendFileSync(
        journalPath,
        JSON.stringify({
          recordType: 'session.opened',
          at: Date.now(),
          chatId,
          sessionId: recycledSession,
        }) + '\n',
        'utf8',
      );

      // Delete the chat through History.
      await page.locator(byTestId('chat-history')).click();
      await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 30_000 });
      const target = row(page, 'a chat that will be recycled');
      // No host was configured or picked in this profile, so the chat stayed
      // host-less and its row shows no host chip at all (omitted, never a
      // placeholder).
      await expect(target.locator('.history-item__server')).toHaveCount(0);
      await target.hover();
      await target.locator(byTestId('history-delete')).click();
      await page.locator(`.surface-status-banner[open] ${byTestId('banner-confirm')}`).click();
      await expect(page.locator(byTestId('history-item'))).toHaveCount(0, { timeout: 30_000 });

      // The stored transcript is gone...
      expect(existsSync(journalPath)).toBe(false);
      // ...and the SDK was asked to delete *both* sessions, in journal order.
      expect(await readDeletedSessionIds(app)).toEqual([headerSession, recycledSession]);
    } finally {
      await app.close();
    }
  });

  test('resuming a chat whose host never answers still shows its transcript and resumes the session', async () => {
    test.setTimeout(180_000);
    const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
    const home = env['USERPROFILE'] ?? '';

    // Echo answers until `hang` is set, then holds every request open - a host
    // that is up but never replies, so its load stays in flight.
    let hang = false;
    const held: ServerResponse[] = [];
    const echo = createServer((_req, res) => {
      if (hang) {
        held.push(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>echo</title><p>ok</p>');
    });
    const other = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>other</title><p>ok</p>');
    });
    const echoOrigin = await listenOnLoopback(echo);
    const otherOrigin = await listenOnLoopback(other);
    const echoId = randomUUID();
    const otherId = randomUUID();

    const base = defaultAppSettings();
    writeSettings(
      home,
      appSettingsSchema.parse({
        ...base,
        hosts: [
          ...base.hosts,
          {
            id: echoId,
            label: 'Echo',
            origin: echoOrigin,
            color: { kind: 'swatch', swatch: 'blue' },
            revision: 0,
          },
          {
            id: otherId,
            label: 'Other',
            origin: otherOrigin,
            color: { kind: 'swatch', swatch: 'green' },
            revision: 0,
          },
        ],
      }),
    );

    const app = await electron.launch({ args: [mainEntry], env });
    try {
      const page = await app.firstWindow();
      // Awaited so the chat records the host it is first used on (a prompt sent
      // mid-switch records none).
      await switchHost(page, echoId);
      await waitForComposerReady(page, { expectSendVisible: false });
      await sendViaComposer(page, 'a question asked on echo');

      // Leave the chat and the host: an empty conversation, with the pane on Other.
      await page.locator(byTestId('chat-new-session')).click();
      await expect(page.locator('.chat-message--user')).toHaveCount(0, { timeout: 30_000 });
      await switchHost(page, otherId);

      // From here on Echo never answers.
      hang = true;
      await page.locator(byTestId('chat-history')).click();
      await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 30_000 });
      const target = row(page, 'a question asked on echo');
      await target.click();

      // The host switch is in flight - Echo has the request and is holding it -
      // and the transcript is already on screen, not waiting behind it.
      await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect(page.locator('.chat-message--user')).toContainText('a question asked on echo', {
        timeout: 10_000,
      });

      // Once the host answers, the resumed session is usable.
      hang = false;
      for (const res of held) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>echo</title><p>ok</p>');
      }
      await page.locator('.chat-composer textarea').fill('and a follow-up');
      await page.locator('.chat-composer__send').click();
      await expect(page.locator('.chat-message--user').last()).toContainText('and a follow-up', {
        timeout: 30_000,
      });
    } finally {
      await app.close();
      echo.close();
      other.close();
    }
  });

  test('resuming from History over the Home veil reveals the page the host switch loads', async () => {
    test.setTimeout(180_000);
    const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
    const home = env['USERPROFILE'] ?? '';

    // A host whose root page immediately navigates itself on to `/landed` -
    // the shape of AEM author's own root hop, and the case Chromium reports as
    // a *cancelled* load (ERR_ABORTED) even though the destination loads fine.
    const redirecting = await startFixtureServer(
      (url) =>
        url.startsWith('/landed')
          ? '<!doctype html><title>landed</title><p>ok</p>'
          : '<!doctype html><title>hop</title><script>location.replace("/landed")</script>',
      // The resume re-loads the root: Chromium must ask the server again rather
      // than answer from its heuristic HTML cache, or the test observes nothing.
      { headers: { 'cache-control': 'no-store' } },
    );
    const other = await startFixtureServer(() => '<!doctype html><title>other</title><p>ok</p>');
    const redirectOrigin = redirecting.origin;
    const otherOrigin = other.origin;
    const redirectId = randomUUID();
    const otherId = randomUUID();

    const base = defaultAppSettings();
    writeSettings(
      home,
      appSettingsSchema.parse({
        ...base,
        hosts: [
          ...base.hosts,
          {
            id: redirectId,
            label: 'Redirect',
            origin: redirectOrigin,
            color: { kind: 'swatch', swatch: 'blue' },
            revision: 0,
          },
          {
            id: otherId,
            label: 'Other',
            origin: otherOrigin,
            color: { kind: 'swatch', swatch: 'green' },
            revision: 0,
          },
        ],
      }),
    );

    const app = await electron.launch({ args: [mainEntry], env });
    try {
      const page = await app.firstWindow();
      const addressInput = page.locator(`${byTestId('browser-address')} input`);
      // Awaited so the chat records the host it is first used on.
      await switchHost(page, redirectId);
      await waitForComposerReady(page, { expectSendVisible: false });
      await sendViaComposer(page, 'a question asked on the redirecting host');

      // Leave the host (the chat keeps the one it was used on), then veil the
      // page with Home.
      await switchHost(page, otherId);
      await expect
        .poll(async () => await addressInput.inputValue(), { timeout: 60_000 })
        .toBe(`${otherOrigin}/`);
      await page.locator(byTestId('browser-home')).click();
      await expect(page.locator('.browser-home')).toBeVisible();
      await expect(page.locator('.browser-view-host')).toBeHidden();

      // The reported sequence: History, opened from the home screen, then
      // Resume - which switches the host straight through `browser.switchServer`.
      await page.locator(byTestId('home-history')).click();
      await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 30_000 });
      const target = row(page, 'a question asked on the redirecting host');
      await target.click();

      // The destination is on screen: the veil went with the switch, and the
      // page the host's root hopped to is what loaded. The address is the proof
      // the resume re-loaded the host (a cached document may answer it without
      // a second request, so the server's hit count is not used here).
      await expect(page.locator('.browser-home')).toBeHidden({ timeout: 60_000 });
      await expect(page.locator('.browser-view-host')).toBeVisible();
      await expect
        .poll(async () => await addressInput.inputValue(), { timeout: 60_000 })
        .toBe(`${redirectOrigin}/landed`);

      // And the cancelled load was not reported as a failure: the pane's
      // surface row stays empty. Wait for the switch to settle first (the
      // Refresh control replaces Stop), since its outcome is what would raise
      // the error.
      await expect(page.locator(byTestId('browser-refresh'))).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('.surface-status-banner')).not.toHaveAttribute('open', '');
    } finally {
      await app.close();
      await closeFixtureServer(redirecting.server);
      await closeFixtureServer(other.server);
    }
  });

  test('a host switch cancelled while resuming from History is not reported as an error', async () => {
    test.setTimeout(180_000);
    const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
    const home = env['USERPROFILE'] ?? '';

    // The chat's host answers until `hang` is set, then holds every request
    // open, so the resume's switch stays in flight until it is stopped.
    let hang = false;
    const held: ServerResponse[] = [];
    const slow = createServer((_req, res) => {
      if (hang) {
        held.push(res);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // The resume re-loads the root: it must reach the server (and hang)
        // rather than be answered from Chromium's heuristic HTML cache.
        'cache-control': 'no-store',
      });
      res.end('<!doctype html><title>slow</title><p>ok</p>');
    });
    const other = await startFixtureServer(() => '<!doctype html><title>other</title><p>ok</p>');
    const slowOrigin = await listenOnLoopback(slow);
    const otherOrigin = other.origin;
    const slowId = randomUUID();
    const otherId = randomUUID();

    const base = defaultAppSettings();
    writeSettings(
      home,
      appSettingsSchema.parse({
        ...base,
        hosts: [
          ...base.hosts,
          {
            id: slowId,
            label: 'Slow',
            origin: slowOrigin,
            color: { kind: 'swatch', swatch: 'blue' },
            revision: 0,
          },
          {
            id: otherId,
            label: 'Other',
            origin: otherOrigin,
            color: { kind: 'swatch', swatch: 'green' },
            revision: 0,
          },
        ],
      }),
    );

    const app = await electron.launch({ args: [mainEntry], env });
    try {
      const page = await app.firstWindow();
      const addressInput = page.locator(`${byTestId('browser-address')} input`);
      // Awaited so the chat records the host it is first used on.
      await switchHost(page, slowId);
      await waitForComposerReady(page, { expectSendVisible: false });
      await sendViaComposer(page, 'a question asked on the slow host');

      await switchHost(page, otherId);
      await expect
        .poll(async () => await addressInput.inputValue(), { timeout: 60_000 })
        .toBe(`${otherOrigin}/`);
      await page.locator(byTestId('browser-home')).click();
      await expect(page.locator('.browser-home')).toBeVisible();

      // The resume's switch to Slow never gets an answer, so it is still in
      // flight when the user stops it - Electron rejects the pending load with
      // ERR_FAILED, which is a *cancellation*, not a failure to report.
      hang = true;
      const heldBeforeResume = held.length;
      await page.locator(byTestId('home-history')).click();
      await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 30_000 });
      const target = row(page, 'a question asked on the slow host');
      await target.click();
      await expect.poll(() => held.length, { timeout: 60_000 }).toBeGreaterThan(heldBeforeResume);

      // The switch already revealed its destination over the veil.
      await expect(page.locator('.browser-home')).toBeHidden();

      await page.locator(byTestId('browser-stop')).click();
      // The switch has settled once the toolbar is back to Refresh.
      await expect(page.locator(byTestId('browser-refresh'))).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('.surface-status-banner')).not.toHaveAttribute('open', '');
    } finally {
      await app.close();
      slow.close();
      await closeFixtureServer(other.server);
    }
  });

  test('reveals the journal of the row its Reveal action acts on', async () => {
    test.setTimeout(180_000);
    const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
    const home = env['USERPROFILE'] ?? '';

    const app = await electron.launch({ args: [mainEntry], env });
    try {
      const page = await app.firstWindow();
      await waitForComposerReady(page, { expectSendVisible: false });
      await sendViaComposer(page, 'a chat worth revealing');

      await page.locator(byTestId('chat-history')).click();
      await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 30_000 });
      const target = row(page, 'a chat worth revealing');
      await expect(target).toBeVisible({ timeout: 30_000 });
      const chatId = await target.getAttribute('data-chat-id');
      if (chatId === null) throw new Error('the row carries no chat id');

      // The Reveal action is the chat footer's own call: main derives the
      // journal's path from the id, never from anything the panel sends.
      await stubShowItemInFolder(app);
      await target.hover();
      await target.locator(byTestId('history-reveal')).click();

      await expect
        .poll(() => readRevealedPaths(app))
        .toContainEqual(path.join(home, 'etoolbox-daisy', 'chats', `${chatId}.jsonl`));
    } finally {
      await app.close();
    }
  });
});
