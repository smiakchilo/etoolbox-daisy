import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * The chat pane's remembered conversation, proven across a full quit and
 * relaunch against the real built app.
 *
 * Only `localStorage` persistence and the real journal files survive a restart,
 * so neither the pointer nor the replay is provable in jsdom. The deterministic
 * fake agent service is used (the same switch `agent-chat.spec.ts` uses),
 * so no Copilot sign-in is needed and the SDK "resume" always succeeds.
 *
 * Flow: seed one configured host; run 1 loads its page, sends one prompt, and
 * quits; run 2 must reopen the same page, resume the same conversation, and
 * repaint the prompt from the journal.
 *
 *   npm run build
 *   npx playwright test tests/e2e/chat-restore.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'chat-restore-scratch');

/** A profile directory both launches share - localStorage, the journal and window state live under it. */

function addressBarValue(page: Page): Promise<string> {
  return page
    .locator(byTestId('browser-address'))
    .evaluate((element) => (element as unknown as { value: string }).value);
}

test.describe('chat restore across a relaunch', () => {
  test('reopens the remembered conversation and repaints it', async () => {
    test.setTimeout(180_000);
    const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
    const home = env['USERPROFILE'] ?? '';

    const hits = { count: 0 };
    const server: Server = createServer((_req, res) => {
      hits.count += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>echo</title><p>ok</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    const base = defaultAppSettings();
    writeSettings(
      home,
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

    const prompt = 'remember this question';

    // --- run 1: load the host's page, send one prompt, then quit --------------
    const first = await electron.launch({ args: [mainEntry], env });
    const firstPage = await first.firstWindow();
    await firstPage.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
    await expect.poll(() => hits.count > 0, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => addressBarValue(firstPage), { timeout: 30_000 }).toContain(origin);
    await waitForComposerReady(firstPage, { expectSendVisible: false });

    await sendViaComposer(firstPage, prompt);
    await expect(firstPage.locator('.chat-message--user')).toContainText(prompt, {
      timeout: 30_000,
    });
    await first.close();

    // --- run 2: both the page and the conversation are restored --------------
    const second = await electron.launch({ args: [mainEntry], env });
    const secondPage = await second.firstWindow();
    // The page is reopened without the startup hosts picker...
    await expect.poll(() => addressBarValue(secondPage), { timeout: 30_000 }).toContain(origin);
    await expect(
      secondPage.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`),
    ).not.toBeVisible();
    // ...and the previously sent prompt is repainted from the journal, proving
    // the conversation was resumed rather than started fresh.
    await expect(secondPage.locator('.chat-message--user')).toContainText(prompt, {
      timeout: 30_000,
    });

    await second.close();
    server.close();
  });
});
