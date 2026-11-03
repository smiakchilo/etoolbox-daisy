import { describe, expect, it } from 'vitest';
import {
  applyPathTransform,
  parsePathTransform,
  resolvePathTransform,
  type PathTransform,
} from '../../../../src/shared';

const strip: PathTransform = { find: '^/content/acme/country', replace: '' };
const prepend: PathTransform = {
  find: '^(?!/content/acme)(/.*\\.html)$',
  replace: '/content/acme/country$1',
};

describe('parsePathTransform', () => {
  it('splits a rule on the first `->` and trims both halves', () => {
    expect(parsePathTransform('  ^/content/acme/country  ->  ')).toEqual({
      ok: true,
      value: { find: '^/content/acme/country', replace: '' },
    });
  });

  it('keeps the replacement and its group references as written', () => {
    expect(
      parsePathTransform('^(?!/content/acme)(/.*\\.html)$ -> /content/acme/country$1'),
    ).toEqual({
      ok: true,
      value: {
        find: '^(?!/content/acme)(/.*\\.html)$',
        replace: '/content/acme/country$1',
      },
    });
  });

  it('accepts `$$` for a literal dollar in the replacement', () => {
    expect(parsePathTransform('(/.*)$ -> $$1')).toEqual({
      ok: true,
      value: { find: '(/.*)$', replace: '$$1' },
    });
  });

  it('rejects a rule with no arrow', () => {
    expect(parsePathTransform('^/content/acme/country')).toEqual({
      ok: false,
      error: 'missing_arrow',
    });
  });

  it('rejects a rule whose find side is empty', () => {
    expect(parsePathTransform(' -> /content/acme')).toEqual({ ok: false, error: 'empty_find' });
  });

  it('rejects a find side that is not a valid regular expression', () => {
    expect(parsePathTransform('([unclosed -> x')).toEqual({ ok: false, error: 'invalid_regex' });
  });

  it('rejects a replacement naming a group the find does not have', () => {
    expect(parsePathTransform('(/a) -> $2')).toEqual({ ok: false, error: 'invalid_replacement' });
    expect(parsePathTransform('(/a) -> $0')).toEqual({ ok: false, error: 'invalid_replacement' });
  });

  it('rejects a bare `$` that is neither `$$` nor a group reference', () => {
    expect(parsePathTransform('(/a) -> cost: $')).toEqual({
      ok: false,
      error: 'invalid_replacement',
    });
  });
});

describe('applyPathTransform', () => {
  it('strips the author prefix when the rule matches', () => {
    expect(applyPathTransform(strip, '/content/acme/country/us/en/home.html')).toBe(
      '/us/en/home.html',
    );
  });

  it('prepends the author prefix when the path is not already in author form', () => {
    expect(applyPathTransform(prepend, '/us/en/home.html')).toBe(
      '/content/acme/country/us/en/home.html',
    );
  });

  it('leaves an already-author path unchanged (the negative-lookahead guard)', () => {
    expect(applyPathTransform(prepend, '/content/acme/country/us/en/home.html')).toBe(
      '/content/acme/country/us/en/home.html',
    );
  });

  it('leaves a path that does not match unchanged', () => {
    expect(applyPathTransform(strip, '/us/en/home.html')).toBe('/us/en/home.html');
    expect(applyPathTransform(prepend, '/crx/de/index.jsp')).toBe('/crx/de/index.jsp');
  });
});

describe('resolvePathTransform', () => {
  const transforms = {
    authorTransform: '^(?!/content/acme)(/.*\\.html)$ -> /content/acme/country$1',
    publishTransform: '^/content/acme/country -> ',
  };

  it('picks the author rule for an author host', () => {
    expect(resolvePathTransform('author', transforms)).toEqual(prepend);
  });

  it('picks the publish rule for a publish host', () => {
    expect(resolvePathTransform('publish', transforms)).toEqual(strip);
  });

  it('returns nothing for a host with no role', () => {
    expect(resolvePathTransform(undefined, transforms)).toBeUndefined();
  });

  it('returns nothing when the project is missing or writes no rule for the role', () => {
    expect(resolvePathTransform('author', undefined)).toBeUndefined();
    expect(resolvePathTransform('author', { publishTransform: '^/content/x -> ' })).toBeUndefined();
    expect(resolvePathTransform('publish', { authorTransform: '(/.*)$ -> $1' })).toBeUndefined();
  });

  it('returns nothing for an empty or unparseable rule, rather than failing the carry', () => {
    expect(resolvePathTransform('author', { authorTransform: '   ' })).toBeUndefined();
    expect(resolvePathTransform('author', { authorTransform: 'not a rule' })).toBeUndefined();
  });
});
