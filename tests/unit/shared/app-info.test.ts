import { describe, expect, it } from 'vitest';
import { parseAppInfo } from '../../../src/shared/app-info';

describe('parseAppInfo', () => {
  it('accepts a well-formed app-info payload', () => {
    const info = parseAppInfo({ name: 'EToolbox Daisy', version: '0.1.0', apiVersion: 1 });
    expect(info).toEqual({ name: 'EToolbox Daisy', version: '0.1.0', apiVersion: 1 });
  });

  it('rejects a payload with a malformed version string', () => {
    expect(() =>
      parseAppInfo({ name: 'EToolbox Daisy', version: 'not-a-version', apiVersion: 1 }),
    ).toThrow();
  });

  it('rejects an unsupported apiVersion', () => {
    expect(() =>
      parseAppInfo({ name: 'EToolbox Daisy', version: '0.1.0', apiVersion: 2 }),
    ).toThrow();
  });

  it('rejects a missing name', () => {
    expect(() => parseAppInfo({ version: '0.1.0', apiVersion: 1 })).toThrow();
  });

  it('rejects non-object input, matching the IPC-boundary threat model', () => {
    expect(() => parseAppInfo('not an object')).toThrow();
    expect(() => parseAppInfo(null)).toThrow();
    expect(() => parseAppInfo(undefined)).toThrow();
  });
});
