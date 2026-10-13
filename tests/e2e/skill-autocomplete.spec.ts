import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { FAKE_AGENT_SERVICE_ENV_VAR } from '../../src/main/agentComposition';

/**
 * The composer's `/skillname` autocomplete, driven end to end against the
 * BUILT app.
 *
 * Why this is an E2E: the popup is a Spectrum `sp-overlay` + `sp-popover`
 * (see `skillPopover.ts`), which jsdom cannot register - so it can only be
 * exercised against the real bundle. This also proves the whole catalogue wire:
 * the renderer's `listSkills()` call, the `agent-chat:list-skills` IPC channel,
 * the preload's schema parse, main reading the bundled `resources/skills`
 * directory from disk, and the `user-invocable` filter.
 *
 * Run against the BUILT app (this file never builds it itself):
 *   npm run build
 *   npx playwright test tests/e2e/skill-autocomplete.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'skill-autocomplete-scratch');

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

const COMPOSER_FIELD = '.chat-composer textarea';
const COMPOSER_SEND = '.chat-composer__send';
const CHAT_STATUS_BANNER = '.chat-status-banner';
const SKILL_OVERLAY = 'sp-overlay.chat-skill-overlay';
const SKILL_NAME = '.chat-composer__skills .chat-composer__skill-name';
const SKILL_ROW = '.chat-composer__skills .chat-composer__skill';
const SELECTED_NAME = '.chat-composer__skill[aria-selected="true"] .chat-composer__skill-name';

async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(shell.locator(CHAT_STATUS_BANNER)).not.toHaveAttribute('open', '', {
    timeout: 60_000,
  });
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '');
}

/** Whether the skill overlay is open, read the same way `message-links.spec.ts` reads the link popover. */
function skillOverlayOpen(shell: Page): Promise<boolean> {
  return shell
    .locator(SKILL_OVERLAY)
    .evaluate((element) => (element as unknown as { open: boolean }).open);
}

test.describe('composer skill autocomplete', () => {
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

  test('lists only the user-invocable skills, navigates with the arrows, and inserts on Enter, Tab or click', async () => {
    const field = shell.locator(COMPOSER_FIELD);
    await field.click();
    await field.fill('/');

    // The real catalogue, read from resources/skills on disk. Only
    // user-invocable skills appear - `query-results` (and `daisy-conventions`)
    // are auxiliary (`user-invocable: false`) and must not be offered.
    await expect.poll(() => skillOverlayOpen(shell)).toBe(true);
    await expect(shell.locator(SKILL_NAME)).toHaveCount(4);
    await expect(shell.locator(SKILL_NAME, { hasText: /^navigate$/ })).toHaveCount(1);
    await expect(shell.locator(SKILL_NAME, { hasText: /^search$/ })).toHaveCount(1);
    await expect(shell.locator(SKILL_NAME, { hasText: /^search-component$/ })).toHaveCount(1);
    await expect(shell.locator(SKILL_NAME, { hasText: 'semantic-search' })).toHaveCount(1);
    await expect(shell.locator(SKILL_NAME, { hasText: 'query-results' })).toHaveCount(0);

    // The empty composer fills the pane, so there is no room above it: the list
    // must be flipped to open *below* the first line of typed text (never over
    // it) and nudged just right of the composer's left border so the two edges
    // do not merge. Loose bounds keep this a behaviour check, not a pixel
    // assertion.
    await expect(shell.locator('sp-popover.chat-skill-popover')).toBeVisible();

    const popoverBox = await shell.locator('sp-popover.chat-skill-popover').boundingBox();
    const frameBox = await shell.locator('.chat-composer__frame').boundingBox();
    const viewport = await shell.evaluate(() => ({ height: window.innerHeight }));
    expect(popoverBox).not.toBeNull();
    expect(frameBox).not.toBeNull();
    if (popoverBox !== null && frameBox !== null) {
      expect(popoverBox.x - frameBox.x).toBeGreaterThanOrEqual(8);
      expect(popoverBox.x - frameBox.x).toBeLessThanOrEqual(24);
      expect(popoverBox.y).toBeGreaterThanOrEqual(frameBox.y + 20);
      expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(viewport.height);
    }

    // Pointer hover shades the row (the first is highlighted at rest).
    const firstRow = shell.locator(SKILL_ROW).first();
    const restingColor = await firstRow.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await firstRow.hover();
    const hoverColor = await firstRow.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(hoverColor).not.toBe(restingColor);

    // `/s` matches the three s-skills; the first (sorted) is highlighted.
    await field.fill('/s');
    await expect(shell.locator(SKILL_NAME)).toHaveCount(3);
    await expect(shell.locator(SELECTED_NAME)).toHaveText('search');

    // Down moves the highlight; Tab accepts it, inserting the name and a space.
    await field.press('ArrowDown');
    await expect(shell.locator(SELECTED_NAME)).toHaveText('search-component');
    await field.press('ArrowDown');
    await expect(shell.locator(SELECTED_NAME)).toHaveText('semantic-search');
    await field.press('Tab');
    await expect(field).toHaveValue('/semantic-search ');
    await expect.poll(() => skillOverlayOpen(shell)).toBe(false);

    // Enter accepts the highlighted suggestion too - the intuitive key - rather
    // than submitting the half-typed `/s` token.
    await field.fill('/s');
    await expect(shell.locator(SELECTED_NAME)).toHaveText('search');
    await field.press('Enter');
    await expect(field).toHaveValue('/search ');
    await expect.poll(() => skillOverlayOpen(shell)).toBe(false);

    // Escape dismisses without editing the text.
    await field.fill('/search');
    await expect(shell.locator(SKILL_NAME)).toHaveCount(2);
    await field.press('Escape');
    await expect(field).toHaveValue('/search');
    await expect.poll(() => skillOverlayOpen(shell)).toBe(false);

    // Clicking a suggestion inserts it and closes the popup.
    await field.fill('/search');
    await expect(shell.locator(SKILL_NAME)).toHaveCount(2);
    await shell.locator(SKILL_ROW).first().click();
    await expect(field).toHaveValue('/search ');
    await expect.poll(() => skillOverlayOpen(shell)).toBe(false);
  });
});
