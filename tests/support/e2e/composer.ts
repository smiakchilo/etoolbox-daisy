import { expect, type Page } from '@playwright/test';
import { byTestId } from '../selectors';

export const COMPOSER_SEND = '.chat-composer__send';
export const COMPOSER_FIELD = '.chat-composer textarea';
export const CHAT_STATUS_BANNER = '.chat-status-banner';

/** Defaults wait for everything; each flag opts a spec out of one wait it never made. */
export interface ComposerReadyOptions {
  /** Wait for the chat status banner to close (default `true`). */
  readonly awaitBannerClosed?: boolean;
  /** Assert Send is visible before asserting it is enabled (default `true`). */
  readonly expectSendVisible?: boolean;
  /** Timeout of the "Send is enabled" assertion; Playwright's default when omitted. */
  readonly sendEnabledTimeoutMs?: number;
}

export async function waitForComposerReady(
  shell: Page,
  options: ComposerReadyOptions = {},
): Promise<void> {
  const { awaitBannerClosed = true, expectSendVisible = true, sendEnabledTimeoutMs } = options;
  await shell.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
  if (awaitBannerClosed) {
    // The composer's messages live on the pane's banner: it is open while the
    // service is still "connecting" and closed once ready with an active agent.
    await expect(shell.locator(CHAT_STATUS_BANNER)).not.toHaveAttribute('open', '', {
      timeout: 60_000,
    });
  }
  if (expectSendVisible) await expect(shell.locator(COMPOSER_SEND)).toBeVisible();
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute(
    'disabled',
    '',
    sendEnabledTimeoutMs === undefined ? undefined : { timeout: sendEnabledTimeoutMs },
  );
}

/** Which preconditions to assert on Send before typing; none by default. */
export interface SendViaComposerOptions {
  readonly requireVisible?: boolean;
  readonly requireEnabled?: boolean;
}

export async function sendViaComposer(
  shell: Page,
  prompt: string,
  options: SendViaComposerOptions = {},
): Promise<void> {
  const button = shell.locator(COMPOSER_SEND);
  if (options.requireVisible === true) await expect(button).toBeVisible();
  if (options.requireEnabled === true) await expect(button).not.toHaveAttribute('disabled', '');
  await shell.locator(COMPOSER_FIELD).fill(prompt);
  await button.click();
}
