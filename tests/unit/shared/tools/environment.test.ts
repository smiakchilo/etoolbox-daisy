import { describe, expect, it } from 'vitest';
import {
  COMPONENT_ROOT_DEFAULT,
  CONTENT_ROOT_DEFAULT,
  DAM_ROOT_DEFAULT,
  effectiveRoots,
  parseRootText,
  parsePriorityPathText,
  planPrioritySegments,
  resolveEnvironmentRoots,
  resolveHostEnvironmentRoots,
  resolveSearchRoots,
} from '../../../../src/shared';

describe('parsePriorityPathText', () => {
  it('keeps the written order, not a sorted one', () => {
    expect(parsePriorityPathText('/content/z, /content/a')).toEqual(['/content/z', '/content/a']);
  });

  it('drops a path equal to or inside an earlier priority, keeps an enclosing one', () => {
    expect(parsePriorityPathText('/content/a/b, /content/a/b/c, /content/a/b, /content/a')).toEqual(
      ['/content/a/b', '/content/a'],
    );
  });

  it('returns [] for undefined', () => {
    expect(parsePriorityPathText(undefined)).toEqual([]);
  });
});

describe('planPrioritySegments', () => {
  it('returns undefined when no priority applies', () => {
    expect(planPrioritySegments(['/content/a'], [])).toBeUndefined();
    expect(planPrioritySegments(['/content/a'], ['/content/b/x'])).toBeUndefined();
    expect(planPrioritySegments(['/content/a'], ['/content/a'])).toBeUndefined();
  });

  it('reads each priority, then the root minus all priorities', () => {
    expect(planPrioritySegments(['/content/a'], ['/content/a/x', '/content/a/y'])).toEqual([
      { path: '/content/a/x', exclude: [] },
      { path: '/content/a/y', exclude: [] },
      { path: '/content/a', exclude: ['/content/a/x', '/content/a/y'] },
    ]);
  });

  it('excludes an earlier priority nested in a later one from that later segment', () => {
    expect(planPrioritySegments(['/content'], ['/content/a/b', '/content/a'])).toEqual([
      { path: '/content/a/b', exclude: [] },
      { path: '/content/a', exclude: ['/content/a/b'] },
      { path: '/content', exclude: ['/content/a/b', '/content/a'] },
    ]);
  });

  it('puts every priority first, then one remainder per root with only its own priorities', () => {
    expect(
      planPrioritySegments(['/content/a', '/content/b'], ['/content/b/x', '/content/a/y']),
    ).toEqual([
      { path: '/content/b/x', exclude: [] },
      { path: '/content/a/y', exclude: [] },
      { path: '/content/a', exclude: ['/content/a/y'] },
      { path: '/content/b', exclude: ['/content/b/x'] },
    ]);
  });

  it('ignores a priority outside the scope while applying the others', () => {
    expect(planPrioritySegments(['/content/a'], ['/content/b/x', '/content/a/y'])).toEqual([
      { path: '/content/a/y', exclude: [] },
      { path: '/content/a', exclude: ['/content/a/y'] },
    ]);
  });
});

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
    expect(resolveEnvironmentRoots({})).toEqual({
      contentRoots: [CONTENT_ROOT_DEFAULT],
      componentRoots: [COMPONENT_ROOT_DEFAULT],
      damRoots: [DAM_ROOT_DEFAULT],
      contentPriorityPaths: [],
    });
    expect(
      resolveEnvironmentRoots({ contentRoots: '/content/site', damRoots: '/content/dam/site' }),
    ).toEqual({
      contentRoots: ['/content/site'],
      componentRoots: [COMPONENT_ROOT_DEFAULT],
      damRoots: ['/content/dam/site'],
      contentPriorityPaths: [],
    });
  });

  it('normalizes and collapses configured roots', () => {
    expect(
      resolveEnvironmentRoots({
        contentRoots: '/content/a; /content/a/b',
        componentRoots: '/apps/x, /apps/y',
      }),
    ).toEqual({
      contentRoots: ['/content/a'],
      componentRoots: ['/apps/x', '/apps/y'],
      damRoots: [DAM_ROOT_DEFAULT],
      contentPriorityPaths: [],
    });
  });
});

describe('resolveSearchRoots', () => {
  it('reads content roots then DAM roots, collapsing a DAM root nested in a content root', () => {
    expect(
      resolveSearchRoots({ contentRoots: ['/content/site'], damRoots: ['/content/dam/site'] }),
    ).toEqual(['/content/site', '/content/dam/site']);
  });

  it('collapses the overlapping defaults to just `/content`', () => {
    expect(
      resolveSearchRoots({ contentRoots: [CONTENT_ROOT_DEFAULT], damRoots: [DAM_ROOT_DEFAULT] }),
    ).toEqual([CONTENT_ROOT_DEFAULT]);
  });

  it('falls back to `/content` when the host has no facts', () => {
    expect(resolveSearchRoots(undefined)).toEqual([CONTENT_ROOT_DEFAULT]);
  });
});

describe('resolveHostEnvironmentRoots', () => {
  const hpe = {
    id: 'project-hpe',
    contentRoots: '/content/a; /content/a/b',
    componentRoots: '/apps/a',
  };

  it('resolves priority paths through the selected project, in written order', () => {
    const project = { id: 'project-p', contentPriorityPaths: '/content/z, /content/a' };
    expect(
      resolveHostEnvironmentRoots({ projectId: 'project-p' }, [project]).contentPriorityPaths,
    ).toEqual(['/content/z', '/content/a']);
  });

  it('resolves DAM roots through the selected project', () => {
    const project = { id: 'project-dam', damRoots: '/content/dam/a; /content/dam/a/b' };
    expect(resolveHostEnvironmentRoots({ projectId: 'project-dam' }, [project]).damRoots).toEqual([
      '/content/dam/a',
    ]);
  });

  it('resolves a host’s roots through its selected project', () => {
    expect(resolveHostEnvironmentRoots({ projectId: 'project-hpe' }, [hpe])).toEqual({
      contentRoots: ['/content/a'],
      componentRoots: ['/apps/a'],
      damRoots: [DAM_ROOT_DEFAULT],
      contentPriorityPaths: [],
    });
  });

  it('applies the defaults when the host has no project', () => {
    expect(resolveHostEnvironmentRoots({}, [hpe])).toEqual({
      contentRoots: [CONTENT_ROOT_DEFAULT],
      componentRoots: [COMPONENT_ROOT_DEFAULT],
      damRoots: [DAM_ROOT_DEFAULT],
      contentPriorityPaths: [],
    });
  });

  it('applies the defaults when the named project no longer exists', () => {
    expect(resolveHostEnvironmentRoots({ projectId: 'project-gone' }, [hpe])).toEqual({
      contentRoots: [CONTENT_ROOT_DEFAULT],
      componentRoots: [COMPONENT_ROOT_DEFAULT],
      damRoots: [DAM_ROOT_DEFAULT],
      contentPriorityPaths: [],
    });
  });

  it('applies the defaults for a project that writes no roots', () => {
    expect(
      resolveHostEnvironmentRoots({ projectId: 'project-bare' }, [{ id: 'project-bare' }]),
    ).toEqual({
      contentRoots: [CONTENT_ROOT_DEFAULT],
      componentRoots: [COMPONENT_ROOT_DEFAULT],
      damRoots: [DAM_ROOT_DEFAULT],
      contentPriorityPaths: [],
    });
  });
});
