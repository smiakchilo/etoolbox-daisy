import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBannerPresentation,
  BANNER_ACTION_MARKER,
  BANNER_ROW_COPY_CLASS,
  BANNER_ROW_LOADING_CLASS,
  buildBannerCopy,
  buildBannerPrompt,
  createBannerActionButton,
  createBannerRow,
} from '../../../src/renderer/src/lib/alertBanner';
import { installJsdomGlobals } from '../../support/jsdomGlobals';

/**
 * The shared banner-row builders (lib/alertBanner.ts). These are pure DOM
 * composition, so jsdom can pin the structure that carries the layout: an
 * action button is an *inline part of the copy sentence* (`buildBannerPrompt`
 * / `buildBannerCopy`), not a sibling in its own column or line, so it flows
 * beside the text and wraps with it. The actual geometry is proven against the
 * built app in the Step 05 E2E, because jsdom does not lay out.
 */

let restoreGlobals: () => void;

beforeEach(() => {
  ({ restore: restoreGlobals } = installJsdomGlobals());
});

afterEach(() => {
  restoreGlobals();
});

describe('buildBannerPrompt', () => {
  it('puts the action where the copy names it, with text still following it', () => {
    const button = createBannerActionButton('OK');
    const [copy] = buildBannerPrompt(`Press ${BANNER_ACTION_MARKER} to continue`, [button]);

    expect(copy?.classList.contains(BANNER_ROW_COPY_CLASS)).toBe(true);
    // The button is a child of the copy span - inline in the sentence - so it
    // can never be pushed onto a line of its own.
    expect(copy?.querySelector('sp-action-button')).toBe(button);
    expect(copy?.textContent).toBe('Press OK to continue');
    expect(copy?.firstChild?.textContent).toBe('Press ');
    expect(copy?.lastChild?.textContent).toBe(' to continue');
  });

  it('appends buttons inline after the copy when it names no action, with a space', () => {
    const button = createBannerActionButton('Reload');
    const [copy] = buildBannerPrompt('Timed out. Check the address', [button]);

    expect(copy?.classList.contains(BANNER_ROW_COPY_CLASS)).toBe(true);
    // The separator is part of the row's own text, so the control is never glued
    // to the last word and the whole row still copies/reads as a sentence.
    expect(copy?.textContent).toBe('Timed out. Check the address Reload');
    expect(copy?.lastChild).toBe(button);
  });

  it('separates a control placed flush against the text by the marker', () => {
    const button = createBannerActionButton('Open in folder');
    const [copy] = buildBannerPrompt('Exported to table.csv{action}', [button]);

    expect(copy?.textContent).toBe('Exported to table.csv Open in folder');
  });

  it('does not double the space a copy already carries around the marker', () => {
    const button = createBannerActionButton('OK');
    const [copy] = buildBannerPrompt(`Press ${BANNER_ACTION_MARKER} to continue`, [button]);

    expect(copy?.textContent).toBe('Press OK to continue');
    expect(copy?.firstChild?.textContent).toBe('Press ');
    expect(copy?.lastChild?.textContent).toBe(' to continue');
  });

  it('returns a single copy span, never a separate actions sibling', () => {
    const nodes = buildBannerPrompt(`Press ${BANNER_ACTION_MARKER} to allow it`, [
      createBannerActionButton('OK'),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.classList.contains(BANNER_ROW_COPY_CLASS)).toBe(true);
  });
});

describe('buildBannerCopy', () => {
  it('keeps inline parts in order inside one copy span', () => {
    const button = createBannerActionButton('Settings');
    const span = buildBannerCopy(['Activate an agent in ', button, ' to send messages']);

    expect(span.classList.contains(BANNER_ROW_COPY_CLASS)).toBe(true);
    expect(span.textContent).toBe('Activate an agent in Settings to send messages');
    expect(span.querySelector('sp-action-button')).toBe(button);
  });

  it('supplies the space a caller forgot between text and a control', () => {
    const button = createBannerActionButton('Reload');
    const span = buildBannerCopy(['Timed out. Check the address', button]);

    // Never "addressReload": one word, and no visual gap.
    expect(span.textContent).toBe('Timed out. Check the address Reload');
  });
});

describe('the close-control rule (applyBannerPresentation)', () => {
  it('starts every row dismissible - the default is ON', () => {
    const row = createBannerRow('test-surface');
    expect(row.hasAttribute('dismissible')).toBe(true);
  });

  it('keeps the close control only for the default presentation', () => {
    const row = createBannerRow('test-surface');

    applyBannerPresentation(row, 'default');
    expect(row.hasAttribute('dismissible')).toBe(true);
    expect(row.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(false);

    // Loading: work in flight - no close control, and the loading fill.
    applyBannerPresentation(row, 'loading');
    expect(row.hasAttribute('dismissible')).toBe(false);
    expect(row.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(true);

    // Transient (auto-hiding, e.g. "Settings saved"): no close control.
    applyBannerPresentation(row, 'transient');
    expect(row.hasAttribute('dismissible')).toBe(false);
    expect(row.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(false);

    // Hidden: a torn-down row leaves no close control behind.
    applyBannerPresentation(row, 'hidden');
    expect(row.hasAttribute('dismissible')).toBe(false);
    expect(row.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(false);
  });
});
