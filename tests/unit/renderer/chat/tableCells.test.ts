import { describe, expect, it } from 'vitest';
import { statusLightVariant } from '../../../../src/renderer/src/chat/tableCells';

describe('statusLightVariant', () => {
  it.each([
    ['pass', 'positive'],
    ['  PASSED ', 'positive'],
    ['warn', 'notice'],
    ['Needs improvement', 'notice'],
    ['fail', 'negative'],
    ['Broken', 'negative'],
    ['manual', 'info'],
    ['something else', 'neutral'],
    ['', 'neutral'],
  ])('reads %j as %s', (value, variant) => {
    expect(statusLightVariant(value)).toBe(variant);
  });
});
