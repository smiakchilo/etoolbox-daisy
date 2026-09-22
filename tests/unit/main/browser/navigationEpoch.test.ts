import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  attachNavigationEpochTracking,
  createNavigationEpochTracker,
  type NavigationEpochChange,
} from '../../../../src/main/browser/navigationEpoch';
import { classifyStaleness } from '../../../../src/shared';
import type { ToolRequestEnvelope } from '../../../../src/shared';

/**
 * A minimal stand-in for the AEM view's `WebContents` that records handlers so
 * a test can fire an event the way Electron would. Only the members
 * `attachNavigationEpochTracking` actually touches are implemented.
 */
function createFakeWebContents(): {
  readonly webContents: WebContents;
  emit(event: string, ...args: readonly unknown[]): void;
  listenerCount(event: string): number;
  destroy(): void;
} {
  const handlers = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  let destroyed = false;
  const add = (event: string, handler: (...args: readonly unknown[]) => void): void => {
    const existing = handlers.get(event) ?? new Set();
    existing.add(handler);
    handlers.set(event, existing);
  };
  const fake = {
    on: (event: string, handler: (...args: readonly unknown[]) => void) => {
      add(event, handler);
      return fake;
    },
    once: (event: string, handler: (...args: readonly unknown[]) => void) => {
      add(event, handler);
      return fake;
    },
    off: (event: string, handler: (...args: readonly unknown[]) => void) => {
      handlers.get(event)?.delete(handler);
      return fake;
    },
    isDestroyed: () => destroyed,
  };
  return {
    webContents: fake as unknown as WebContents,
    emit(event, ...args) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
    },
    listenerCount: (event) => handlers.get(event)?.size ?? 0,
    destroy: () => {
      destroyed = true;
    },
  };
}

const startNavigation = (
  overrides: Partial<{ isMainFrame: boolean; isSameDocument: boolean }> = {},
): unknown => ({
  url: 'https://aem.example.com/content/site.html',
  isMainFrame: overrides.isMainFrame ?? true,
  isSameDocument: overrides.isSameDocument ?? false,
  frame: null,
});

describe('createNavigationEpochTracker', () => {
  it('starts at zero and moves forward one step per bump', () => {
    const tracker = createNavigationEpochTracker();
    expect(tracker.current()).toBe(0);
    expect(tracker.bump('document_navigation')).toBe(1);
    expect(tracker.bump('server_switch')).toBe(2);
    expect(tracker.current()).toBe(2);
  });

  it('never moves backwards, whatever the reason', () => {
    const tracker = createNavigationEpochTracker();
    const seen: number[] = [];
    tracker.subscribe((change) => seen.push(change.epoch));
    for (const reason of [
      'document_navigation',
      'server_switch',
      'render_process_gone',
      'view_destroyed',
      'document_navigation',
    ] as const) {
      tracker.bump(reason);
    }
    // `classifyStaleness` compares with a symmetric `!==` precisely because a
    // counter that went backwards would silently mark a stale reply "fresh".
    expect(seen).toStrictEqual([1, 2, 3, 4, 5]);
  });

  it('reports the reason alongside the new epoch', () => {
    const tracker = createNavigationEpochTracker();
    const changes: NavigationEpochChange[] = [];
    tracker.subscribe((change) => changes.push(change));
    tracker.bump('server_switch');
    expect(changes).toStrictEqual([{ epoch: 1, reason: 'server_switch' }]);
  });

  it('stops notifying after unsubscribe', () => {
    const tracker = createNavigationEpochTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);
    tracker.bump('document_navigation');
    unsubscribe();
    tracker.bump('document_navigation');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tolerates a listener that unsubscribes itself during the notification', () => {
    // The request broker does exactly this: it cancels, and cancelling removes
    // its own subscription. Iterating the live set would skip the next listener.
    const tracker = createNavigationEpochTracker();
    const second = vi.fn();
    const unsubscribeFirst = tracker.subscribe(() => unsubscribeFirst());
    tracker.subscribe(second);
    expect(() => tracker.bump('document_navigation')).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('can start from a non-zero epoch so a restart never reuses a value', () => {
    expect(createNavigationEpochTracker(7).current()).toBe(7);
  });
});

describe('attachNavigationEpochTracking', () => {
  it('invalidates on a cross-document main-frame navigation', () => {
    const fake = createFakeWebContents();
    const tracker = createNavigationEpochTracker();
    attachNavigationEpochTracking(fake.webContents, tracker);
    fake.emit('did-start-navigation', startNavigation());
    expect(tracker.current()).toBe(1);
  });

  it('does NOT invalidate on same-document navigation', () => {
    // Fragment changes and pushState keep the same document, origin and script
    // context. AEM's authoring UI does this constantly; invalidating here would
    // make the tool fail for reasons that have nothing to do with safety.
    const fake = createFakeWebContents();
    const tracker = createNavigationEpochTracker();
    attachNavigationEpochTracking(fake.webContents, tracker);
    fake.emit('did-start-navigation', startNavigation({ isSameDocument: true }));
    expect(tracker.current()).toBe(0);
  });

  it('does NOT invalidate on sub-frame navigation', () => {
    const fake = createFakeWebContents();
    const tracker = createNavigationEpochTracker();
    attachNavigationEpochTracking(fake.webContents, tracker);
    fake.emit('did-start-navigation', startNavigation({ isMainFrame: false }));
    expect(tracker.current()).toBe(0);
  });

  it('invalidates when the renderer dies or the view is destroyed', () => {
    const fake = createFakeWebContents();
    const tracker = createNavigationEpochTracker();
    attachNavigationEpochTracking(fake.webContents, tracker);
    fake.emit('render-process-gone');
    expect(tracker.current()).toBe(1);
    fake.emit('destroyed');
    expect(tracker.current()).toBe(2);
  });

  it('treats did-navigate as a backstop for an unobserved navigation start', () => {
    const fake = createFakeWebContents();
    const tracker = createNavigationEpochTracker();
    attachNavigationEpochTracking(fake.webContents, tracker);
    fake.emit('did-navigate');
    expect(tracker.current()).toBe(1);
  });

  it('detaches every listener it added', () => {
    const fake = createFakeWebContents();
    const tracker = createNavigationEpochTracker();
    const detach = attachNavigationEpochTracking(fake.webContents, tracker);
    detach();
    for (const event of [
      'did-start-navigation',
      'did-navigate',
      'render-process-gone',
      'destroyed',
    ]) {
      expect(fake.listenerCount(event)).toBe(0);
    }
    fake.emit('did-start-navigation', startNavigation());
    expect(tracker.current()).toBe(0);
  });

  it('does not throw when detaching after the view is already destroyed', () => {
    const fake = createFakeWebContents();
    const detach = attachNavigationEpochTracking(fake.webContents, createNavigationEpochTracker());
    fake.destroy();
    expect(() => detach()).not.toThrow();
  });
});

describe('epoch integration with classifyStaleness', () => {
  const envelopeAt = (navigationEpoch: number): ToolRequestEnvelope =>
    ({
      operation: 'aem_get_json',
      conversationId: 'c1',
      requestId: 'r1',
      serverId: 's1',
      serverRevision: 0,
      navigationEpoch,
      deadlineMs: 1,
      args: { path: '/content', includeChildren: false },
    }) as unknown as ToolRequestEnvelope;

  it('marks a request issued before a navigation as stale afterwards', () => {
    const tracker = createNavigationEpochTracker();
    const envelope = envelopeAt(tracker.current());
    expect(
      classifyStaleness(envelope, { serverRevision: 0, navigationEpoch: tracker.current() }),
    ).toBe('fresh');
    tracker.bump('document_navigation');
    expect(
      classifyStaleness(envelope, { serverRevision: 0, navigationEpoch: tracker.current() }),
    ).toBe('stale_navigation_epoch');
  });
});
