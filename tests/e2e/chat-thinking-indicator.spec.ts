import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { ScriptedTurn } from '../../src/agent/fakeAgentService';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';

/**
 * The transcript's trailing "Thinking" indicator (spinner + label) shown while
 * a turn is in flight, alongside the composer's Stop button.
 *
 * Why this is an E2E and not a unit test: the indicator is the first UI use of
 * `@spectrum-web-components/progress-circle`, and AGENTS.md §9 is explicit
 * that jsdom cannot prove a custom element is registered - it renders an
 * unknown tag as `HTMLUnknownElement`, so a unit test passes even if the
 * `sp-progress-circle.js` side-effect import is missing from `main.ts`. This
 * spec asserts a real `customElements.get(...)` registration and a real
 * `shadowRoot` against the BUILT app, which is the only way to catch that.
 *
 * The deterministic `createFakeAgentService` fake is driven from
 * `application.evaluate` the same way `step07-agent-chat.spec.ts` does (see
 * that file's doc comment for the full rationale).
 *
 * Run against the BUILT app (this file never builds it itself):
 *   npm run build
 *   npx playwright test tests/e2e/chat-thinking-indicator.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'chat-thinking-scratch');

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

async function advanceFakeTimes(app: ElectronApp, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const delivered = await advanceFake(app);
    if (!delivered) {
      throw new Error(
        `advanceFake: expected a pending event on call ${String(i + 1)} of ${String(times)}, but none was queued.`,
      );
    }
  }
}

// File-local minimal DOM shape (tsconfig.test.json has no "dom" lib) - real at
// runtime inside the renderer, same convention as step07-agent-chat.spec.ts.
declare const document: {
  querySelector(selector: string): { readonly shadowRoot: unknown } | null;
};
declare const customElements: { get(name: string): unknown };

const COMPOSER_SEND = '.chat-composer__send';
const COMPOSER_STOP = '.chat-composer__stop';
const COMPOSER_NOTICE = '.chat-composer__notice';
const COMPOSER_FIELD = '.chat-composer textarea';
const ASSISTANT_MESSAGE = '.chat-message--assistant';
const THINKING = '.chat-message--thinking';

async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(shell.locator(COMPOSER_NOTICE)).toHaveText('', { timeout: 60_000 });
  await expect(shell.locator(COMPOSER_SEND)).toBeVisible();
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '');
}

async function sendViaComposer(shell: Page, prompt: string): Promise<void> {
  const button = shell.locator(COMPOSER_SEND);
  await expect(button).toBeVisible();
  await expect(button).not.toHaveAttribute('disabled', '');
  await shell.locator(COMPOSER_FIELD).fill(prompt);
  await button.click();
}

/**
 * Whether the thinking node contains a genuinely upgraded `<sp-progress-circle>`
 * - registered AND with a real shadow root. `false` for an inert unknown tag,
 * which is exactly what a missing `main.ts` side-effect import produces.
 */
function progressCircleUpgraded(shell: Page): Promise<boolean> {
  return shell.evaluate(() => {
    const node = document.querySelector('.chat-message--thinking sp-progress-circle');
    return (
      node !== null &&
      customElements.get('sp-progress-circle') !== undefined &&
      node.shadowRoot !== null
    );
  });
}

test.describe('transcript thinking indicator', () => {
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

  test('shows a registered sp-progress-circle "Thinking" indicator while in flight, and removes it once text streams', async () => {
    await scriptTurn(app, { steps: [{ kind: 'delta', text: 'Hello' }] });
    await sendViaComposer(shell, 'say hello');

    const thinking = shell.locator(THINKING);
    // Visible the moment a turn is in flight, before any text has arrived.
    await expect(thinking).toBeVisible();
    await expect(thinking).toContainText('Thinking');
    // The composer's Stop button is visible at the same time (same predicate).
    await expect(shell.locator(COMPOSER_STOP)).toBeVisible();

    // The real registration proof: not an inert `HTMLUnknownElement`.
    await expect.poll(() => progressCircleUpgraded(shell)).toBe(true);

    // Deliver `assistant.message.started` only - still no text, indicator stays.
    await advanceFakeTimes(app, 1);
    await expect(thinking).toBeVisible();

    // Deliver the first text delta - the indicator must disappear.
    await advanceFakeTimes(app, 1);
    await expect(thinking).toHaveCount(0);
    await expect(shell.locator(ASSISTANT_MESSAGE).last()).toHaveText('Hello');

    // Still gone after the turn completes.
    await flushFake(app);
    await expect(thinking).toHaveCount(0);
  });
});
