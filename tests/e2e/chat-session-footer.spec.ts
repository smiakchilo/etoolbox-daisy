import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { ScriptedTurn } from '../../src/main/agents/fakeAgentService';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';
import type { DaisyAppApi } from '../../src/shared';

/**
 * Two cosmetic chat-transcript features (owner request, 2026-10-06), proven
 * against the REAL shipped `out/main/index.js` and renderer bundle because the
 * pieces they add cross the IPC boundary a unit test cannot vouch for:
 *
 *  - the interruption notice ("Session stopped" / "Session interrupted by
 *    navigation") is driven by the real `cancelling` event a Stop produces, and
 *  - the transcript footer's left summary (agent / model / reasoning) opens
 *    Settings on the Agents tab, and its right icon calls the real
 *    `agent-chat:reveal-journal` preload bridge with the active chat id.
 *
 * `shell.showItemInFolder` is stubbed to a recorder so the reveal does not open
 * a real Explorer window - the same technique `message-links.spec.ts` uses for
 * `shell.openExternal`.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/chat-session-footer.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'chat-session-footer-scratch');

const COMPOSER_SEND = '.chat-composer__send';
const COMPOSER_STOP = '.chat-composer__stop';
const COMPOSER_FIELD = '.chat-composer textarea';
const CHAT_STATUS_BANNER = '.chat-status-banner';
const INTERRUPTION = '.chat-message--interruption';
const SESSION_ID = '.chat-session-id';
const AGENT_SUMMARY = '.chat-agent-summary';
const COMPOSER = '.chat-composer';

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

interface TestWindow {
  daisy: DaisyAppApi;
}
declare const window: TestWindow;

async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(shell.locator(CHAT_STATUS_BANNER)).not.toHaveAttribute('open', '', {
    timeout: 60_000,
  });
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

/** Replaces main's `shell.showItemInFolder` with a recorder, so no Explorer window opens. */
async function stubShowItemInFolder(app: ElectronApp): Promise<void> {
  await app.evaluate(({ shell }) => {
    const scope = globalThis as Record<string, unknown>;
    scope['__revealedJournal'] = [] as string[];
    (shell as unknown as { showItemInFolder: (fullPath: string) => void }).showItemInFolder = (
      fullPath,
    ) => {
      (scope['__revealedJournal'] as string[]).push(fullPath);
    };
  });
}

function readRevealedJournal(app: ElectronApp): Promise<string[]> {
  return app.evaluate(
    () => ((globalThis as Record<string, unknown>)['__revealedJournal'] as string[]) ?? [],
  );
}

test.describe('Chat transcript: session id footer and interruption notices', () => {
  let app: ElectronApp;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    app = await launch(makeScratchProfile());
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
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
    await sendViaComposer(shell, 'do a long task');

    // started + first delta only, so a turn is genuinely in flight.
    expect(await advanceFake(app)).toBe(true);
    expect(await advanceFake(app)).toBe(true);
    await expect(shell.locator('.chat-message--assistant').last()).toHaveText('Working on it');

    const stop = shell.locator(COMPOSER_STOP);
    await expect(stop).toBeVisible();
    await stop.click();

    await expect(shell.locator(INTERRUPTION)).toHaveText('Session stopped', { timeout: 10_000 });
  });

  test('the footer summarises the agent and reveals its journal file', async () => {
    await scriptTurn(app, { steps: [{ kind: 'delta', text: 'First answer' }] });
    await sendViaComposer(shell, 'footer please');
    await flushFake(app);

    const chatId = await shell.evaluate(async () => {
      const status = await window.daisy.agentChat.getStatus();
      return status.activeChatId;
    });
    expect(chatId).not.toBeNull();

    // Left: agent / model / reasoning. No model or effort is chosen in a fresh
    // profile, so both read "(Auto)".
    await expect(shell.locator(AGENT_SUMMARY)).toHaveText('GitHub Copilot / (Auto) / (Auto)');

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
      .poll(async () => readRevealedJournal(app))
      .toContainEqual(expect.stringMatching(new RegExp(`${chatId as string}\\.jsonl$`)));

    // The summary opens Settings on the Agents tab.
    await shell.locator(AGENT_SUMMARY).click();
    await expect(shell.locator('.settings-panel')).toBeVisible();
    await expect(shell.locator('.settings-panel section[aria-label="Agents"]')).toBeVisible();
  });
});
