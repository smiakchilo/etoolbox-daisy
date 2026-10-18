import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { DaisyAppApi } from '../../src/shared';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import { COMPOSER_FIELD, sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { advanceFake, flushFake, scriptTurn } from '../support/e2e/fakeAgent';
import { createScratchDirs } from '../support/e2e/profile';
import { readRevealedPaths, stubShowItemInFolder } from '../support/e2e/shellStubs';
import { byField, byTestId } from '../support/selectors';

/**
 * Two cosmetic chat-transcript features (owner request, 2026-10-06), proven
 * against the REAL shipped `out/main/index.js` and renderer bundle because the
 * pieces they add cross the IPC boundary a unit test cannot vouch for:
 *
 *  - the interruption notice ("Session stopped" / "Session interrupted by
 *    navigation") is driven by the real `cancelling` event a Stop produces, and
 *  - the transcript footer's left summary (agent / model / reasoning) opens
 *    Settings on the Agents tab, and its right icon calls the real
 *    `agent-chat:reveal-journal` preload bridge with the active chat id. The
 *    footer's summary is shown even for an empty conversation (the full-height
 *    composer), while the reveal icon waits for conversation content.
 *
 * `shell.showItemInFolder` is stubbed to a recorder (the shared
 * `support/e2e/shellStubs` helper) so the reveal does not open a real Explorer
 * window.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/chat-session-footer.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'chat-session-footer-scratch');

const COMPOSER_STOP = '.chat-composer__stop';
const INTERRUPTION = '.chat-message--interruption';
const SESSION_ID = byTestId('chat-reveal-log');
const AGENT_SUMMARY = byTestId('chat-agent-summary');
const COMPOSER = '.chat-composer';

/** APPDATA/LOCALAPPDATA must agree with USERPROFILE/HOME or Electron crashes on this machine. */

interface TestWindow {
  daisy: DaisyAppApi;
}
declare const window: TestWindow;

test.describe('Chat transcript: session id footer and interruption notices', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
    shell = await app.firstWindow();
    await waitForComposerReady(shell, { expectSendVisible: false });
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('a user Stop shows a "Session stopped" notice in the transcript', async () => {
    await scriptTurn(app, {
      steps: [
        { kind: 'delta', text: 'Working on it' },
        { kind: 'delta', text: '...' },
      ],
    });
    await sendViaComposer(shell, 'do a long task', { requireVisible: true, requireEnabled: true });

    // started + first delta only, so a turn is genuinely in flight.
    expect(await advanceFake(app)).toBe(true);
    expect(await advanceFake(app)).toBe(true);
    await expect(shell.locator('.chat-message--assistant').last()).toHaveText('Working on it');

    const stop = shell.locator(COMPOSER_STOP);
    await expect(stop).toBeVisible();
    await stop.click();

    // The Cancel returns the keyboard to the prompt field, so the user can type
    // straight away rather than having to click back into it.
    await expect(shell.locator(COMPOSER_FIELD)).toBeFocused();

    const notice = shell.locator(INTERRUPTION);
    await expect(notice.locator('.chat-message__interruption-label')).toHaveText(/\S/, {
      timeout: 10_000,
    });

    // The live notice offers a quiet Resume action; pressing it sends "Resume"
    // as an ordinary prompt, so a "Resume" user message appears and the same
    // session continues.
    const resume = notice.locator('[data-interruption-resume]');
    await expect(resume).toBeVisible();
    await expect(resume).toHaveAttribute('quiet', '');
    await resume.click();
    await expect(shell.locator('.chat-message--user').last()).toHaveText('Resume');

    // The send created a fresh (empty) turn; drain it so the shared app is idle
    // for the next case.
    await flushFake(app);
  });

  test('the footer summarises the agent and reveals its journal file', async () => {
    await scriptTurn(app, { steps: [{ kind: 'delta', text: 'First answer' }] });
    await sendViaComposer(shell, 'footer please', { requireVisible: true, requireEnabled: true });
    await flushFake(app);

    const chatId = await shell.evaluate(async () => {
      const status = await window.daisy.agentChat.getStatus();
      return status.activeChatId;
    });
    expect(chatId).not.toBeNull();

    // Left: agent / model / reasoning summary.
    await expect(shell.locator(AGENT_SUMMARY)).toHaveText(/\S/);

    // The line sits directly beneath the composer.
    const composerBox = await shell.locator(COMPOSER).boundingBox();
    const footerBox = await shell.locator(AGENT_SUMMARY).boundingBox();
    expect(composerBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(footerBox!.y).toBeGreaterThanOrEqual(composerBox!.y + composerBox!.height - 1);

    // Right: the reveal icon (no literal session id anymore).
    const anchor = shell.locator(SESSION_ID);
    await expect(anchor).toBeVisible();
    await expect(anchor.locator('sp-icon-file-txt')).toHaveCount(1);

    await stubShowItemInFolder(app);
    await anchor.click();

    await expect
      .poll(async () => readRevealedPaths(app))
      .toContainEqual(expect.stringMatching(new RegExp(`${chatId as string}\\.jsonl$`)));

    // The summary opens Settings on the Agents tab.
    await shell.locator(AGENT_SUMMARY).click();
    await expect(shell.locator(byTestId('settings-panel'))).toBeVisible();
    await expect(shell.locator('.agents-section')).toBeVisible();
  });

  test('the footer follows a model chosen in Settings instead of keeping the old one', async () => {
    // The previous case left Settings open on the Agents tab; re-open it via
    // the summary if that ever changes, then commit a model choice.
    if (!(await shell.locator(byTestId('settings-panel')).isVisible())) {
      await shell.locator(AGENT_SUMMARY).click();
    }
    const section = shell.locator('.agents-section');
    await expect(section).toBeVisible();

    const modelPicker = section.locator(byField('agent-model')).first();
    await expect(modelPicker).toBeEnabled();
    await modelPicker.evaluate((node: HTMLElement & { value: string }) => {
      node.value = 'fake-model-reasoning';
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // The committed change must reach the footer at once. Before the fix a model
    // save never told the shell, so the summary kept showing the previously
    // chosen model until some unrelated settings edit reloaded it.
    await expect(shell.locator(AGENT_SUMMARY)).toContainText('Fake Model (reasoning)');
  });

  test('shows the footer summary, but not the reveal icon, while the composer is full height', async () => {
    // Close Settings, which the previous case left open, then start a fresh,
    // empty conversation - the full-height composer.
    if (await shell.locator(byTestId('settings-panel')).isVisible()) {
      await shell.locator(byTestId('settings-panel-close')).click();
    }
    await shell.locator(byTestId('chat-new-session')).click();
    await expect(shell.locator('.chat-pane--empty')).toBeVisible();

    // The empty conversation still carries the agent summary in the footer - it
    // is useful before the first prompt - but the reveal-log icon has no
    // conversation content to point at, so it is hidden.
    await expect(shell.locator(AGENT_SUMMARY)).toBeVisible();
    await expect(shell.locator(SESSION_ID)).toBeHidden();
  });
});
