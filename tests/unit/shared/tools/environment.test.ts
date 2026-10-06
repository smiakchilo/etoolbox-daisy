import { describe, expect, it } from 'vitest';
import {
  COMPONENT_ROOT_DEFAULT,
  CONTENT_ROOT_DEFAULT,
  effectiveRoots,
  parseRootText,
  resolveEnvironmentRoots,
} from '../../../../src/shared';

describe('parseRootText', () => {
  it('splits on commas when one is present and trims each chunk', () => {
    expect(parseRootText(' /content/a , /content/b ,/content/c ')).toEqual([
      '/content/a',
      '/content/b',
      '/content/c',
    ]);
  });

  it('splits on semicolons when there is no comma', () => {
    expect(parseRootText('/content/a; /content/b')).toEqual(['/content/a', '/content/b']);
  });

  it('lets a comma win over a semicolon, so a semicolon can stay inside a token', () => {
    expect(parseRootText('/content/a; /content/b, /content/c')).toEqual([
      '/content/a; /content/b',
      '/content/c',
    ]);
  });

  it('drops empty and unusable chunks and de-duplicates, preserving order', () => {
    expect(parseRootText('/content/a;; not-a-path ;/content/a;/content/b/')).toEqual([
      '/content/a',
      '/content/b',
    ]);
  });

  it('returns [] for undefined and for whitespace only', () => {
    expect(parseRootText(undefined)).toEqual([]);
    expect(parseRootText('   ')).toEqual([]);
  });
});

describe('effectiveRoots', () => {
  it('drops a root nested inside another and de-duplicates', () => {
    expect(effectiveRoots(['/content/a', '/content/a/b', '/content/a', '/content/b'])).toEqual([
      '/content/a',
      '/content/b',
    ]);
  });

  it('is a no-op for disjoint roots, preserving written order', () => {
    expect(effectiveRoots(['/content/z', '/content/a'])).toEqual(['/content/z', '/content/a']);
  });

  it('drops every root when the repository root is present', () => {
    expect(effectiveRoots(['/content/a', '/'])).toEqual(['/']);
  });
});

describe('resolveEnvironmentRoots', () => {
  it('defaults each family independently', () => {
    expect(resolveEnvironmentRoots(undefined, undefined)).toEqual({
      contentRoots: [CONTENT_ROOT_DEFAULT],
      componentRoots: [COMPONENT_ROOT_DEFAULT],
    });
    expect(resolveEnvironmentRoots('/content/site', undefined)).toEqual({
      contentRoots: ['/content/site'],
      componentRoots: [COMPONENT_ROOT_DEFAULT],
    });
  });

  it('normalizes and collapses configured roots', () => {
    expect(resolveEnvironmentRoots('/content/a; /content/a/b', '/apps/x, /apps/y')).toEqual({
      contentRoots: ['/content/a'],
      componentRoots: ['/apps/x', '/apps/y'],
    });
  });
});
