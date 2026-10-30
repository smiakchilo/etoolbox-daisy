import { describe, expect, it } from 'vitest';
import {
  isCancelledNavigation,
  parseBrowserAuthIncident,
  type BrowserIpcVoidResult,
} from '../../../src/shared';

describe('parseBrowserAuthIncident', () => {
  it('accepts a lost incident of either severity', () => {
    for (const severity of ['certain', 'suspected'] as const) {
      expect(parseBrowserAuthIncident({ state: 'lost', severity, hostLabel: 'Author' })).toEqual({
        state: 'lost',
        severity,
        hostLabel: 'Author',
      });
    }
  });

  it('accepts a recovery', () => {
    expect(parseBrowserAuthIncident({ state: 'recovered' })).toEqual({ state: 'recovered' });
  });

  it('rejects a malformed payload', () => {
    expect(() =>
      parseBrowserAuthIncident({ state: 'lost', severity: 'maybe', hostLabel: 'A' }),
    ).toThrow();
    expect(() => parseBrowserAuthIncident({ state: 'lost', severity: 'certain' })).toThrow();
    expect(() => parseBrowserAuthIncident({ state: 'other' })).toThrow();
    expect(() => parseBrowserAuthIncident(undefined)).toThrow();
  });
});

describe('isCancelledNavigation', () => {
  const networkError = (errorCode: string): BrowserIpcVoidResult => ({
    ok: false,
    error: { code: 'network_error', message: 'net::ERR', errorCode },
  });

  it('treats both Chromium cancellation codes as cancellation, not failure', () => {
    // ERR_ABORTED is a redirect taking the load over; ERR_FAILED is Electron
    // 44's rejection for a stopped load. Neither means the page failed.
    expect(isCancelledNavigation(networkError('ERR_ABORTED'))).toBe(true);
    expect(isCancelledNavigation(networkError('ERR_FAILED'))).toBe(true);
  });

  it('does not treat a genuine network failure as cancellation', () => {
    expect(isCancelledNavigation(networkError('ERR_CONNECTION_REFUSED'))).toBe(false);
    expect(isCancelledNavigation(networkError('ERR_NAME_NOT_RESOLVED'))).toBe(false);
  });

  it('does not treat a non-network error or a success as cancellation', () => {
    expect(
      isCancelledNavigation({
        ok: false,
        error: { code: 'server_not_found', message: 'no server' },
      }),
    ).toBe(false);
    expect(isCancelledNavigation({ ok: true })).toBe(false);
  });
});
