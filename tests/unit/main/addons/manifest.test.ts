import { describe, expect, it } from 'vitest';
import {
  ADDON_PLATFORM_ANY,
  MAX_ADDON_ARCHIVE_BYTES,
  addonCatalogSchema,
  addonDescriptorSchema,
  isSafeRelativePath,
} from '../../../../src/main/addons/manifest';

/**
 * The published catalogue and an installed add-on's descriptor. Both are parsed
 * at a trust boundary (a downloaded file), so the rules are tested as rules:
 * an unusable catalogue is ignored, and a descriptor that could write outside
 * its own folder is refused.
 */

function catalogue(): unknown {
  return {
    addons: {
      'page-audit': {
        '1.0.0': {
          platforms: {
            [ADDON_PLATFORM_ANY]: {
              file: 'page-audit-1.0.0-any.zip',
              sha512: 'a'.repeat(128),
              size: 1024,
            },
          },
        },
      },
    },
  };
}

describe('addonCatalogSchema', () => {
  it('accepts a catalogue with one version and an any-platform archive', () => {
    expect(addonCatalogSchema.safeParse(catalogue()).success).toBe(true);
  });

  it('ignores fields a newer publisher adds', () => {
    const withExtra = catalogue() as {
      addons: Record<string, Record<string, { platforms: Record<string, object> }>>;
      somethingNew?: boolean;
    };
    withExtra.somethingNew = true;
    const platform = withExtra.addons['page-audit']?.['1.0.0']?.platforms[ADDON_PLATFORM_ANY];
    if (platform !== undefined) {
      Reflect.set(platform, 'notes', 'a newer field');
    }

    expect(addonCatalogSchema.safeParse(withExtra).success).toBe(true);
  });

  it.each([
    ['a non-hex checksum', { sha512: 'nope' }],
    ['a zero size', { size: 0 }],
    ['an oversized archive', { size: MAX_ADDON_ARCHIVE_BYTES + 1 }],
    ['a file name with a path', { file: '../escape.zip' }],
  ])('refuses %s', (_label, patch) => {
    const broken = catalogue() as {
      addons: Record<string, Record<string, { platforms: Record<string, object> }>>;
    };
    Object.assign(
      broken.addons['page-audit']?.['1.0.0']?.platforms[ADDON_PLATFORM_ANY] ?? {},
      patch,
    );

    expect(addonCatalogSchema.safeParse(broken).success).toBe(false);
  });

  it('refuses a version that is not dotted numeric', () => {
    const broken = catalogue() as {
      addons: Record<string, Record<string, unknown>>;
    };
    broken.addons['page-audit'] = { latest: broken.addons['page-audit']?.['1.0.0'] };

    expect(addonCatalogSchema.safeParse(broken).success).toBe(false);
  });
});

describe('addonDescriptorSchema', () => {
  const js = { id: 'page-audit', version: '1.0.0', kind: 'js', apiVersion: 1, entry: 'index.js' };

  it('accepts a js descriptor with an entry', () => {
    expect(addonDescriptorSchema.safeParse(js).success).toBe(true);
  });

  it('accepts a binary descriptor with named files', () => {
    expect(
      addonDescriptorSchema.safeParse({
        id: 'copilot-cli',
        version: '1.0.83',
        kind: 'binary',
        apiVersion: 1,
        files: { cli: 'copilot.exe' },
      }).success,
    ).toBe(true);
  });

  it('refuses a js descriptor with no entry', () => {
    expect(addonDescriptorSchema.safeParse({ ...js, entry: undefined }).success).toBe(false);
  });

  it('refuses a binary descriptor with no files', () => {
    expect(
      addonDescriptorSchema.safeParse({
        id: 'copilot-cli',
        version: '1.0.83',
        kind: 'binary',
        apiVersion: 1,
        files: {},
      }).success,
    ).toBe(false);
  });

  it.each(['../escape.js', '/absolute.js', 'C:/windows.js', 'a/../../b.js'])(
    'refuses the unsafe entry %s',
    (entry) => {
      expect(addonDescriptorSchema.safeParse({ ...js, entry }).success).toBe(false);
    },
  );

  it('refuses a descriptor kind it does not know', () => {
    expect(addonDescriptorSchema.safeParse({ ...js, kind: 'native' }).success).toBe(false);
  });

  it('keeps a relative nested path working', () => {
    expect(isSafeRelativePath('lib/index.js')).toBe(true);
    expect(isSafeRelativePath('lib\\index.js')).toBe(true);
  });
});
