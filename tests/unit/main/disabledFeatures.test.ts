import { describe, expect, it } from 'vitest';
import { mergeDisabledFeatures } from '../../../src/main/disabledFeatures';

describe('mergeDisabledFeatures', () => {
  it('appends the feature to a non-empty existing list', () => {
    expect(mergeDisabledFeatures('Translate,MediaRouter', 'WebAuthenticationUseNativeWinApi')).toBe(
      'Translate,MediaRouter,WebAuthenticationUseNativeWinApi',
    );
  });

  it('returns just the feature when nothing was disabled before', () => {
    expect(mergeDisabledFeatures('', 'WebAuthenticationUseNativeWinApi')).toBe(
      'WebAuthenticationUseNativeWinApi',
    );
  });

  it('never duplicates a feature that is already disabled', () => {
    expect(
      mergeDisabledFeatures(
        'Translate,WebAuthenticationUseNativeWinApi',
        'WebAuthenticationUseNativeWinApi',
      ),
    ).toBe('Translate,WebAuthenticationUseNativeWinApi');
  });

  it('drops empty entries so a trailing comma does not create one', () => {
    expect(mergeDisabledFeatures('Translate,,MediaRouter,', 'Foo')).toBe(
      'Translate,MediaRouter,Foo',
    );
  });
});
