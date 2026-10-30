import { describe, expect, it } from 'vitest';
import {
  addonDescriptorSchema,
  addonIdSchema,
  isSafeRelativePath,
} from '../../../../src/main/addons/manifest';

/**
 * A built add-on's descriptor is read from disk at startup, so its rules are
 * tested as rules: a descriptor that names another folder's path, an unusable
 * id or a stray key is refused.
 */

const js = { id: 'example-addon', apiVersion: 1, entry: 'index.js' };

describe('addonDescriptorSchema', () => {
  it('accepts a descriptor with an entry point', () => {
    expect(addonDescriptorSchema.safeParse(js).success).toBe(true);
  });

  it('refuses a descriptor without an entry point', () => {
    expect(addonDescriptorSchema.safeParse({ id: js.id, apiVersion: 1 }).success).toBe(false);
  });

  it.each(['../escape.js', '/absolute.js', 'C:/windows.js', 'a/../../b.js'])(
    'refuses the unsafe entry %s',
    (entry) => {
      expect(addonDescriptorSchema.safeParse({ ...js, entry }).success).toBe(false);
    },
  );

  it('refuses an unusable id', () => {
    expect(addonDescriptorSchema.safeParse({ ...js, id: 'Not An Id' }).success).toBe(false);
  });

  it.each([0, -1, 1.5])('refuses the api version %s', (apiVersion) => {
    expect(addonDescriptorSchema.safeParse({ ...js, apiVersion }).success).toBe(false);
  });

  it('refuses a key it does not know', () => {
    expect(addonDescriptorSchema.safeParse({ ...js, identity: '0123456789abcdef' }).success).toBe(
      false,
    );
  });

  it('accepts the contributions the build derived', () => {
    const parsed = addonDescriptorSchema.safeParse({
      ...js,
      contributes: { tools: [], skills: [] },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('addonIdSchema', () => {
  it('accepts a lowercase kebab-case id', () => {
    expect(addonIdSchema.safeParse('sample-addon').success).toBe(true);
  });

  it.each(['', '1abc', 'Abc', 'a_b', '../x'])('refuses %j', (value) => {
    expect(addonIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('isSafeRelativePath', () => {
  it('accepts a nested relative path', () => {
    expect(isSafeRelativePath('dist/index.js')).toBe(true);
  });

  it.each(['', '/a', '\\a', 'C:a', 'a//b', 'a/../b'])('refuses %j', (value) => {
    expect(isSafeRelativePath(value)).toBe(false);
  });
});
