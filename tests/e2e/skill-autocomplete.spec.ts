import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import { COMPOSER_FIELD, waitForComposerReady } from '../support/e2e/composer';
import { createScratchDirs } from '../support/e2e/profile';

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

const scratchBase = path.resolve(__dirname, '../../test-results', 'skill-autocomplete-scratch');

const SKILL_OVERLAY = 'sp-overlay.chat-skill-overlay';
const SKILL_NAME = '.chat-composer__skills .chat-composer__skill-name';
const SKILL_ROW = '.chat-composer__skills .chat-composer__skill';
const SELECTED_NAME = '.chat-composer__skill[aria-selected="true"] .chat-composer__skill-name';

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
    app = await launchApp(createScratchDirs(scratchBase), { fakeAgent: true });
    shell = await app.firstWindow();
    await waitForComposerReady(shell, { expectSendVisible: false });
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('lists the skills, navigates with the arrows, and inserts on Enter, Tab or click', async () => {
    const field = shell.locator(COMPOSER_FIELD);
    await field.click();
    await field.fill('/');

    // The real catalogue, read from resources/skills on disk: whatever skills
    // are bundled, at least one is offered and every later step derives its
    // expectation from the listed names rather than from a hard-coded list.
    await expect.poll(() => skillOverlayOpen(shell)).toBe(true);
    await expect(shell.locator(SKILL_NAME).first()).toBeVisible();
    const names = (await shell.locator(SKILL_NAME).allTextContents()).map((name) => name.trim());
    expect(names.length).toBeGreaterThanOrEqual(1);
    const prefix = (names[0] ?? '').slice(0, 1);
    expect(prefix).not.toBe('');
    const withPrefix = names.filter((name) => name.startsWith(prefix));
    const secondIndex = Math.min(1, withPrefix.length - 1);
    const second = withPrefix[secondIndex] ?? '';
    // Filtering by a longer prefix keeps every name that still starts with it.
    const fullName = names[0] ?? '';
    const withFullName = names.filter((name) => name.startsWith(fullName));

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

    // A typed prefix narrows the list to the names starting with it; the first
    // listed one is highlighted.
    await field.fill(`/${prefix}`);
    await expect(shell.locator(SKILL_NAME)).toHaveCount(withPrefix.length);
    await expect(shell.locator(SELECTED_NAME)).toHaveText(withPrefix[0] ?? '');

    // Down moves the highlight (when there is another row); Tab accepts it,
    // inserting the name and a space.
    if (withPrefix.length > 1) await field.press('ArrowDown');
    await expect(shell.locator(SELECTED_NAME)).toHaveText(second);
    await field.press('Tab');
    await expect(field).toHaveValue(`/${second} `);
    await expect.poll(() => skillOverlayOpen(shell)).toBe(false);

    // Enter accepts the highlighted suggestion too - the intuitive key - rather
    // than submitting the half-typed token.
    await field.fill(`/${prefix}`);
    await expect(shell.locator(SELECTED_NAME)).toHaveText(withPrefix[0] ?? '');
    await field.press('Enter');
    await expect(field).toHaveValue(`/${withPrefix[0]} `);
    await expect.poll(() => skillOverlayOpen(shell)).toBe(false);

    // Escape dismisses without editing the text.
    await field.fill(`/${fullName}`);
    await expect(shell.locator(SKILL_NAME)).toHaveCount(withFullName.length);
    await field.press('Escape');
    await expect(field).toHaveValue(`/${fullName}`);
    await expect.poll(() => skillOverlayOpen(shell)).toBe(false);

    // Clicking a suggestion inserts it and closes the popup.
    await field.fill(`/${fullName}`);
    await expect(shell.locator(SKILL_NAME)).toHaveCount(withFullName.length);
    const clickedName = ((await shell.locator(SKILL_NAME).first().textContent()) ?? '').trim();
    await shell.locator(SKILL_ROW).first().click();
    await expect(field).toHaveValue(`/${clickedName} `);
    await expect.poll(() => skillOverlayOpen(shell)).toBe(false);
  });
});
