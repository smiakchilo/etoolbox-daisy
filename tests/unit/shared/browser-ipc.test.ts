import { describe, expect, it } from 'vitest';
import { parseBrowserAuthIncident } from '../../../src/shared';

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
