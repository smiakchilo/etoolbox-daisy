import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { ScriptedTurn } from '../../src/main/agents/fakeAgentService';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';

/**
 * The ask-user (interactive question) UI: the composer swaps its text field for
 * a radio group / checkbox list / dropdown, the transcript paints the question
 * and answer as messages (no billet), and the answer travels back to the turn.
 *
 * Why this is an E2E and not a unit test: the controls are Spectrum custom
 * elements, and AGENTS.md section 9 is explicit that jsdom cannot prove a
 * custom element is registered - it renders an unknown tag as
 * `HTMLUnknownElement`, so a unit test passes even if a `main.ts` side-effect
 * import is missing. This spec asserts real `customElements.get(...)`
 * registrations against the BUILT app.
 *
 * The deterministic fake scripts an `inputRequest` turn (which pauses until the
 * answer arrives), so the whole composer -> IPC -> turn loop is exercised with
 * no model and no AEM instance.
 *
 * Run against the BUILT app (this file never builds it itself):
 *   npm run build
 *   npx playwright test tests/e2e/ask-user.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'ask-user-scratch');

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

function flushFake(app: ElectronApp): Promise<number> {
  return app.evaluate(
    (_electronNamespace, arg: FakeHandleArg) => {
      const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
        readonly flush: () => number;
      };
      return fake.flush();
    },
    { globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY },
  );
}

declare const customElements: { get(name: string): unknown };

const COMPOSER_SEND = '.chat-composer__send';
const COMPOSER_STOP = '.chat-composer__stop';
const CHAT_STATUS_BANNER = '.chat-status-banner';
const COMPOSER_FIELD = '.chat-composer textarea';
const ASK_PANEL = '.chat-ask';
const ASK_QUESTION = '.chat-ask__question';
const ASK_USER = '.chat-ask-user';

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

/** Answers the outstanding question and lets the fake finish the turn. */
async function submitAnswer(app: ElectronApp, shell: Page): Promise<void> {
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '');
  await shell.locator(COMPOSER_SEND).click();
  await flushFake(app);
}

function registered(shell: Page, tag: string): Promise<boolean> {
  return shell.evaluate((name: string) => customElements.get(name) !== undefined, tag);
}

test.describe('ask-user interactive question', () => {
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

  test('a single-select question shows a radio group, and the answer becomes a user message', async () => {
    await scriptTurn(app, {
      steps: [
        { kind: 'inputRequest', question: 'Pick a colour', options: ['Red', 'Green', 'Blue'] },
      ],
    });
    await sendViaComposer(shell, 'ask me');
    await flushFake(app);

    await expect(shell.locator(ASK_PANEL)).toBeVisible();
    // The turn is waiting on the user, not thinking. The transcript repaints
    // every 100 ms, so give it several to show the billet if it were going to.
    await shell.waitForTimeout(500);
    await expect(shell.locator('.chat-message--thinking')).toHaveCount(0);
    await expect(shell.locator(ASK_QUESTION)).toHaveText('Pick a colour');
    await expect(shell.locator('.chat-ask sp-radio')).toHaveCount(3);
    await expect.poll(() => registered(shell, 'sp-radio')).toBe(true);
    await expect.poll(() => registered(shell, 'sp-radio-group')).toBe(true);
    // The text field is hidden while the controls are shown.
    await expect(shell.locator(COMPOSER_FIELD)).toBeHidden();

    // Stop is shown alongside Submit, and its icon is the real registered
    // `sp-icon-cross600` (not an inert unknown tag from a missing import).
    await expect(shell.locator(`${COMPOSER_STOP} sp-icon-cross600`)).toHaveCount(1);
    await expect.poll(() => registered(shell, 'sp-icon-cross600')).toBe(true);

    await shell.locator('.chat-ask sp-radio').nth(0).click();
    await submitAnswer(app, shell);

    await expect(shell.locator(ASK_PANEL)).toBeHidden();
    await expect(shell.locator(`${ASK_USER} .chat-message--assistant`).last()).toHaveText(
      'Pick a colour',
    );
    await expect(shell.locator(`${ASK_USER} .chat-message--user`).last()).toHaveText('Red');
  });

  test('a multiple-select question shows checkboxes and returns every choice', async () => {
    await scriptTurn(app, {
      steps: [
        {
          kind: 'inputRequest',
          question: 'Pick toppings',
          options: ['Cheese', 'Ham', 'Olives', 'Chilli'],
          multiple: true,
        },
      ],
    });
    await sendViaComposer(shell, 'ask me again');
    await flushFake(app);

    await expect(shell.locator('.chat-ask sp-checkbox')).toHaveCount(4);
    await expect.poll(() => registered(shell, 'sp-checkbox')).toBe(true);

    await shell.locator('.chat-ask sp-checkbox').nth(0).click();
    await shell.locator('.chat-ask sp-checkbox').nth(2).click();
    await submitAnswer(app, shell);

    await expect(shell.locator(`${ASK_USER} .chat-message--user`).last()).toHaveText(
      'Cheese, Olives',
    );
  });

  test('the free-input link swaps the controls for the text field', async () => {
    await scriptTurn(app, {
      steps: [
        {
          kind: 'inputRequest',
          question: 'Which one?',
          options: ['A', 'B'],
          freeInput: true,
        },
      ],
    });
    await sendViaComposer(shell, 'ask me freely');
    await flushFake(app);

    await expect(shell.locator('.chat-ask sp-radio')).toHaveCount(2);
    await shell.locator('.chat-ask__free').click();

    await expect(shell.locator('.chat-ask sp-radio')).toHaveCount(0);
    await expect(shell.locator(COMPOSER_FIELD)).toBeVisible();
    await shell.locator(COMPOSER_FIELD).fill('something else');
    await submitAnswer(app, shell);

    await expect(shell.locator(`${ASK_USER} .chat-message--user`).last()).toHaveText(
      'something else',
    );
  });

  test('more than five options becomes a dropdown', async () => {
    await scriptTurn(app, {
      steps: [
        {
          kind: 'inputRequest',
          question: 'Pick one of many',
          options: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'],
        },
      ],
    });
    await sendViaComposer(shell, 'ask me many');
    await flushFake(app);

    await expect(shell.locator('.chat-ask sp-radio')).toHaveCount(0);
    await expect(shell.locator('.chat-ask sp-picker')).toBeVisible();
    await expect.poll(() => registered(shell, 'sp-picker')).toBe(true);

    // Spans the panel's width, and defaults to the first option rather than a
    // "Choose an option" placeholder (so Submit is enabled immediately).
    const panelBox = await shell.locator(ASK_PANEL).boundingBox();
    const pickerBox = await shell.locator('.chat-ask sp-picker').boundingBox();
    expect(panelBox).not.toBeNull();
    expect(pickerBox).not.toBeNull();
    if (panelBox && pickerBox) expect(pickerBox.width).toBeGreaterThan(panelBox.width - 16);
    await expect(shell.locator('.chat-ask sp-picker')).toContainText('Alpha');
    await expect(shell.locator('.chat-ask')).not.toContainText('Choose an option');
    await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '');

    await shell.locator('.chat-ask sp-picker').click();
    await shell.locator('sp-menu-item[value="Delta"]').click();
    await submitAnswer(app, shell);

    await expect(shell.locator(`${ASK_USER} .chat-message--user`).last()).toHaveText('Delta');
  });

  test('more than five options with multiple becomes a multi-select menu', async () => {
    await scriptTurn(app, {
      steps: [
        {
          kind: 'inputRequest',
          question: 'Pick several',
          options: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'],
          multiple: true,
        },
      ],
    });
    await sendViaComposer(shell, 'ask me many multi');
    await flushFake(app);

    await expect(shell.locator('.chat-ask sp-checkbox')).toHaveCount(0);
    await expect(shell.locator('.chat-ask__multi-button')).toBeVisible();

    // The trigger spans the panel's content width and defaults to the first
    // option (no "Choose options" placeholder).
    const panelBox = await shell.locator(ASK_PANEL).boundingBox();
    const multiBox = await shell.locator('.chat-ask__multi-button').boundingBox();
    expect(panelBox).not.toBeNull();
    expect(multiBox).not.toBeNull();
    if (panelBox && multiBox) expect(multiBox.width).toBeGreaterThan(panelBox.width - 16);
    await expect(shell.locator('.chat-ask__multi-label')).toHaveText('Alpha');

    // The label is left-aligned, not centred.
    const labelBox = await shell.locator('.chat-ask__multi-label').boundingBox();
    if (multiBox && labelBox) expect(labelBox.x - multiBox.x).toBeLessThan(60);

    // Submit and Stop are both on screen while a question is open; they must not
    // touch.
    const sendBox = await shell.locator(COMPOSER_SEND).boundingBox();
    const stopBox = await shell.locator(COMPOSER_STOP).boundingBox();
    if (sendBox && stopBox) expect(stopBox.x - (sendBox.x + sendBox.width)).toBeGreaterThan(2);

    // The menu lives in a lazily-attached overlay, so it enters the DOM only
    // once the button opens it.
    await shell.locator('.chat-ask__multi-button').click();
    await expect(shell.locator('sp-menu[selects="multiple"] sp-menu-item')).toHaveCount(7);
    await expect.poll(() => registered(shell, 'sp-menu')).toBe(true);

    // Deselect the defaulted first option, then choose two others.
    await shell.locator('sp-menu-item[value="Alpha"]').click();
    await shell.locator('sp-menu-item[value="Bravo"]').click();
    await shell.locator('sp-menu-item[value="Echo"]').click();
    // Close the overlay before submitting.
    await shell.keyboard.press('Escape');
    await submitAnswer(app, shell);

    await expect(shell.locator(`${ASK_USER} .chat-message--user`).last()).toHaveText('Bravo, Echo');
    await expect(shell.locator('.chat-ask__popover')).toHaveCount(0);
  });

  test('an actions prompt fits its buttons and Cancel on one line, and paints nothing in the transcript', async () => {
    await scriptTurn(app, {
      steps: [{ kind: 'inputRequest', actions: ['Refine', 'Show more'] }],
    });
    // A `/search` prompt: its assistant prose is suppressed, so nothing but the
    // (absent) message is left for the transcript to draw.
    await sendViaComposer(shell, '/search waldo');
    await flushFake(app);

    await expect(shell.locator('.chat-ask__actions')).toBeVisible();
    await expect(shell.locator('.chat-ask__action')).toHaveCount(2);
    await expect(shell.locator('.chat-ask__action').nth(0)).toHaveText('Refine');
    await expect(shell.locator('.chat-ask__action').nth(1)).toHaveText('Show more');
    // Actions have no caption sentence, no text field, and no Send - just the
    // buttons and Cancel.
    await expect(shell.locator(ASK_QUESTION)).toHaveCount(0);
    await expect(shell.locator(COMPOSER_FIELD)).toBeHidden();
    await expect(shell.locator(COMPOSER_SEND)).toBeHidden();
    await expect(shell.locator(COMPOSER_STOP)).toBeVisible();
    await expect.poll(() => registered(shell, 'sp-action-button')).toBe(true);

    // All buttons share one line: the two actions and Cancel's vertical extents
    // overlap, the actions are separated by a gap, and Cancel is rightmost.
    const first = await shell.locator('.chat-ask__action').nth(0).boundingBox();
    const second = await shell.locator('.chat-ask__action').nth(1).boundingBox();
    const cancel = await shell.locator(COMPOSER_STOP).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(cancel).not.toBeNull();
    if (first && second && cancel) {
      expect(first.y).toBeLessThan(second.y + second.height);
      expect(second.y).toBeLessThan(first.y + first.height);
      expect(second.y).toBeLessThan(cancel.y + cancel.height);
      expect(cancel.y).toBeLessThan(second.y + second.height);
      // A visible gap between the two action buttons...
      expect(second.x - (first.x + first.width)).toBeGreaterThan(2);
      // ...and Cancel sits to the right of the last action.
      expect(cancel.x).toBeGreaterThan(second.x + second.width);
    }

    // The frame becomes a contrasting gray strip with no visible border while
    // the action buttons are shown.
    const frameStyle = await shell.locator('.chat-composer__frame').evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, borderColor: style.borderTopColor };
    });
    // `--spectrum-gray-200` resolves to #e6e6e6 under the pinned Spectrum theme.
    expect(frameStyle.background).toBe('rgb(230, 230, 230)');
    expect(frameStyle.borderColor).toBe('rgba(0, 0, 0, 0)');

    // One click answers; no Submit.
    await shell.locator('.chat-ask__action').first().click();
    await flushFake(app);

    await expect(shell.locator(ASK_PANEL)).toBeHidden();
    // Leaving actions mode restores the ordinary bordered white input.
    await expect
      .poll(() =>
        shell
          .locator('.chat-composer__frame')
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe('rgb(255, 255, 255)');
    // The actions call renders nothing in the transcript: the (empty)
    // `.chat-ask-user` shell it owns carries no message at all.
    await expect(shell.locator('.chat-ask-user').last().locator('.chat-message')).toHaveCount(0);
  });

  test('Cancel on a pending question dismisses it without ending the turn', async () => {
    await scriptTurn(app, {
      steps: [{ kind: 'inputRequest', actions: ['Load more'] }],
    });
    await sendViaComposer(shell, '/search waldo');
    await flushFake(app);

    await expect(shell.locator('.chat-ask__action')).toHaveText('Load more');
    // Cancel is the composer's Stop: it means "no answer" here, not "stop the
    // session" (the /search Load-more loop's cancel) - see `chatPane.onStop`.
    await shell.locator(COMPOSER_STOP).click();
    await flushFake(app);

    // The question is dismissed and the ordinary bordered composer returns...
    await expect(shell.locator('.chat-ask__actions')).toBeHidden();
    await expect
      .poll(() =>
        shell
          .locator('.chat-composer__frame')
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe('rgb(255, 255, 255)');
    // ...and the turn was never aborted, so no "Session stopped" notice exists.
    await expect(shell.locator('.chat-message--interruption')).toHaveCount(0);
    await expect(shell.locator(COMPOSER_SEND)).toBeVisible();
  });

  test('Cancel still works after several "Load more" clicks (no state desync)', async () => {
    await scriptTurn(app, {
      steps: [
        { kind: 'inputRequest', actions: ['Load more'] },
        { kind: 'inputRequest', actions: ['Load more'] },
        { kind: 'inputRequest', actions: ['Load more'] },
      ],
    });
    await sendViaComposer(shell, '/search Greenlake');
    await flushFake(app);

    // Answer the first two questions with the action, as a real run does.
    await shell.locator('.chat-ask__action').click();
    await flushFake(app);
    await expect(shell.locator('.chat-ask__action')).toBeVisible();
    await shell.locator('.chat-ask__action').click();
    await flushFake(app);
    await expect(shell.locator('.chat-ask__action')).toBeVisible();

    // Then cancel the third: still a "no answer", still no session stop.
    await shell.locator(COMPOSER_STOP).click();
    await flushFake(app);

    await expect(shell.locator('.chat-ask__actions')).toBeHidden();
    await expect(shell.locator('.chat-message--interruption')).toHaveCount(0);
    await expect(shell.locator(COMPOSER_SEND)).toBeVisible();
  });
});
