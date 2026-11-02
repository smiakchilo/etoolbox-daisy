import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPDATE_REF,
  UPDATE_REPOSITORIES,
  packageJsonUrl,
  parseUpdateSource,
  sourceArchiveUrl,
} from '../../../../src/main/updates/source';
import { updateSourceSchema } from '../../../../src/shared';

/**
 * The grammar of the Settings "Update source": both default repositories are
 * read unless the value names one, and a value that looks like a repository
 * never quietly turns into a ref (or the other way round).
 */

const PRIMARY = UPDATE_REPOSITORIES[0];
const SECONDARY = UPDATE_REPOSITORIES[1];

describe('parseUpdateSource', () => {
  it.each([undefined, '', '   '])('reads both default repositories for %j', (source) => {
    expect(parseUpdateSource(source)).toEqual({
      kind: 'repositories',
      repositories: UPDATE_REPOSITORIES,
      ref: DEFAULT_UPDATE_REF,
    });
  });

  it('reads a ref of the default repositories', () => {
    expect(parseUpdateSource('release/1.2')).toEqual({
      kind: 'repositories',
      repositories: UPDATE_REPOSITORIES,
      ref: 'release/1.2',
    });
  });

  it('reads one repository named as owner/name@ref', () => {
    expect(parseUpdateSource(`${SECONDARY}@release/2.0`)).toEqual({
      kind: 'repositories',
      repositories: [SECONDARY],
      ref: 'release/2.0',
    });
  });

  it('reads a bare owner/name as a ref, never as a repository', () => {
    expect(parseUpdateSource('someone/fork')).toEqual({
      kind: 'repositories',
      repositories: UPDATE_REPOSITORIES,
      ref: 'someone/fork',
    });
  });

  it.each([
    ['github.com/owner/name', 'owner/name', DEFAULT_UPDATE_REF],
    ['github.com/owner/name@v1.2.0', 'owner/name', 'v1.2.0'],
    ['https://github.com/owner/name', 'owner/name', DEFAULT_UPDATE_REF],
    ['https://github.com/owner/name.git', 'owner/name', DEFAULT_UPDATE_REF],
    ['https://github.com/owner/name/', 'owner/name', DEFAULT_UPDATE_REF],
  ])('reads %s as one repository', (source, repository, ref) => {
    expect(parseUpdateSource(source)).toEqual({
      kind: 'repositories',
      repositories: [repository],
      ref,
    });
  });

  it.each([
    'https://example.com/source.zip',
    'https://github.com/owner/name/archive/refs/heads/master.zip',
  ])('treats %s as a whole source zip', (url) => {
    expect(parseUpdateSource(url)).toEqual({ kind: 'archive', url });
  });

  it('addresses the default repositories package.json by repository and ref', () => {
    const url = packageJsonUrl(PRIMARY, 'release/1.0');
    expect(url.hostname).toBe('raw.githubusercontent.com');
    expect(url.pathname).toBe(`/${PRIMARY}/release/1.0/package.json`);
  });

  it('addresses a repository archive by repository and ref', () => {
    expect(sourceArchiveUrl(SECONDARY, DEFAULT_UPDATE_REF)).toBe(
      `https://github.com/${SECONDARY}/archive/${DEFAULT_UPDATE_REF}.zip`,
    );
  });
});

describe('updateSourceSchema', () => {
  it.each([
    'master',
    'release/1.2',
    `${SECONDARY}@master`,
    `${SECONDARY}@release/2.0`,
    'github.com/owner/name',
    'github.com/owner/name@v1.2.0',
    'https://github.com/owner/name',
    'https://example.com/source.zip',
  ])('accepts %s', (source) => {
    expect(updateSourceSchema.parse(source)).toBe(source);
  });

  it.each([
    'owner/name@',
    '@master',
    'github.com/owner',
    'github.com/owner/name/extra',
    '/release/1.2',
    'release/../1.2',
    'ftp://example.com/source.zip',
  ])('rejects %s', (source) => {
    expect(updateSourceSchema.safeParse(source).success).toBe(false);
  });

  it('never parses an accepted source into an empty check', () => {
    for (const source of [`${SECONDARY}@dev`, 'github.com/owner/name', 'dev']) {
      const target = parseUpdateSource(updateSourceSchema.parse(source));
      expect(target.kind).toBe('repositories');
      if (target.kind !== 'repositories') continue;
      expect(target.repositories.length).toBeGreaterThan(0);
      expect(target.ref).not.toBe('');
    }
  });
});
