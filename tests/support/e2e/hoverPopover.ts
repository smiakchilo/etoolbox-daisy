import { expect, type Page } from '@playwright/test';
import { byTestId } from '../selectors';

/**
 * Clicks one action inside the transcript's travelling hover popover.
 *
 * Spectrum positions the overlay a frame or two after it opens, so a click
 * fired the instant the button appears can land on the content underneath it
 * (the error is a deceptive "intercepts pointer events" from the transcript).
 * Waiting until the button is the actual hit-test target makes the click
 * deterministic. Shared by every spec that drives the Edit/CRX (or
 * Copy/Export) popover, which lives once for the whole transcript.
 */
export async function clickPopoverAction(shell: Page, actionTestId: string): Promise<void> {
  const button = shell.locator(byTestId(actionTestId));
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      shell.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (element === null) return false;
        const rect = element.getBoundingClientRect();
        return (
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element
        );
      }, byTestId(actionTestId)),
    )
    .toBe(true);
  await button.click();
}
