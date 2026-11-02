import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  injectUpdateStatus,
  markUserRequestedUpdateCheck,
  shouldAnnounceUpdate,
  subscribeUpdateStatus,
  type UpdateStatusOrigin,
} from '../../../src/renderer/src/lib/updateStatusFeed';
import type { UpdateStatus } from '../../../src/shared';
import { installJsdomGlobals } from '../../support/jsdomGlobals';

/**
 * How the renderer tells apart the checks that may raise the chat pane's
 * fallback notice (`lib/updateStatusFeed.ts`): only an automatic one (the opt-in
 * startup check) may, a check the reader ran from Settings may not, and the
 * dev preview is delivered as its own origin.
 */

let dom: JSDOM;
let restoreGlobals: () => void;
let pushFromMain: ((status: UpdateStatus) => void) | undefined;

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  pushFromMain = undefined;
  Reflect.set(dom.window, 'daisy', {
    updates: {
      onStatusChanged: (listener: (status: UpdateStatus) => void) => {
        pushFromMain = listener;
        return () => undefined;
      },
    },
  });
});

afterEach(() => {
  restoreGlobals();
});

/** Subscribes for one test and returns the origins main's pushes were labelled with. */
function collectOrigins(): {
  readonly origins: UpdateStatusOrigin[];
  readonly unsubscribe: () => void;
} {
  const origins: UpdateStatusOrigin[] = [];
  const unsubscribe = subscribeUpdateStatus((_status, origin) => origins.push(origin));
  return { origins, unsubscribe };
}

function push(status: UpdateStatus): void {
  if (pushFromMain === undefined) throw new Error('the feed never subscribed to main');
  pushFromMain(status);
}

describe('subscribeUpdateStatus', () => {
  it('labels an unprompted push as automatic', () => {
    const { origins, unsubscribe } = collectOrigins();
    push({ kind: 'checking' });
    push({ kind: 'available', version: '2.0.0' });
    expect(origins).toEqual(['automatic', 'automatic']);
    unsubscribe();
  });

  it('labels the outcome of a check the reader started as their own', () => {
    const { origins, unsubscribe } = collectOrigins();
    markUserRequestedUpdateCheck();
    push({ kind: 'checking' });
    push({ kind: 'available', version: '2.0.0' });
    expect(origins).toEqual(['automatic', 'user']);

    // The marker belongs to that one check: a later push is automatic again.
    push({ kind: 'upToDate' });
    expect(origins.at(-1)).toBe('automatic');
    unsubscribe();
  });

  it('labels an injected preview as the preview', () => {
    const { origins, unsubscribe } = collectOrigins();
    injectUpdateStatus({ kind: 'available', version: '9.9.9' });
    expect(origins).toEqual(['preview']);
    unsubscribe();
  });
});

describe('shouldAnnounceUpdate', () => {
  it('announces an automatic or previewed update only while no Update button is on screen', () => {
    expect(shouldAnnounceUpdate({ origin: 'automatic', offerOnScreen: false })).toBe(true);
    expect(shouldAnnounceUpdate({ origin: 'automatic', offerOnScreen: true })).toBe(false);
    expect(shouldAnnounceUpdate({ origin: 'preview', offerOnScreen: false })).toBe(true);
    expect(shouldAnnounceUpdate({ origin: 'preview', offerOnScreen: true })).toBe(false);
  });

  it('never announces the result of a check the reader ran themselves', () => {
    expect(shouldAnnounceUpdate({ origin: 'user', offerOnScreen: false })).toBe(false);
    expect(shouldAnnounceUpdate({ origin: 'user', offerOnScreen: true })).toBe(false);
  });
});
