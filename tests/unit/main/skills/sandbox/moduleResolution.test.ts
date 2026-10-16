import { describe, expect, it } from 'vitest';
import {
  normalizeModuleKey,
  resolveModuleSpecifier,
} from '../../../../../src/main/skills/sandbox/moduleResolution';

const known = new Set(['scripts/main.js', 'scripts/util.js', 'lib/shared.mjs', 'top.js']);
const has = (key: string): boolean => known.has(key);

describe('normalizeModuleKey', () => {
  it.each([
    ['a/b/../c.js', 'a/c.js'],
    ['./a//b/./c.js', 'a/b/c.js'],
    ['/a/b.js', 'a/b.js'],
  ])('collapses %s', (input, expected) => {
    expect(normalizeModuleKey(input)).toBe(expected);
  });

  it('refuses to climb above the root', () => {
    expect(normalizeModuleKey('../x.js')).toBeUndefined();
    expect(normalizeModuleKey('a/../../x.js')).toBeUndefined();
  });
});

describe('resolveModuleSpecifier', () => {
  it.each([
    ['scripts/main.js', './util.js', 'scripts/util.js'],
    ['scripts/main.js', '../lib/shared.mjs', 'lib/shared.mjs'],
    ['scripts/main.js', '../scripts/./util.js', 'scripts/util.js'],
    ['', './top.js', 'top.js'],
  ])('resolves %s -> %s', (importer, specifier, expected) => {
    expect(resolveModuleSpecifier(importer, specifier, has)).toEqual({ ok: true, key: expected });
  });

  it.each([
    ['a bare specifier', 'lodash'],
    ['a node: module', 'node:fs'],
    ['an absolute path', '/etc/passwd'],
    ['a drive path', 'C:/Windows/win.ini'],
    ['a backslash path', '.\\util.js'],
    ['an escape above the root', '../../outside.js'],
    ['a deep escape', '../../../../x.js'],
    ['an unknown file', './missing.js'],
    ['a NUL byte', './util.js\0.txt'],
    ['an empty specifier', ''],
  ])('refuses %s', (_label, specifier) => {
    const resolution = resolveModuleSpecifier('scripts/main.js', specifier, has);
    expect(resolution.ok).toBe(false);
  });

  it('only ever returns a key the caller knows', () => {
    for (const specifier of ['./util.js', '../lib/shared.mjs', '../top.js', './x/../util.js']) {
      const resolution = resolveModuleSpecifier('scripts/main.js', specifier, has);
      if (resolution.ok) expect(known.has(resolution.key)).toBe(true);
    }
  });
});
