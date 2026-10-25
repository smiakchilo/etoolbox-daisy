import { describe, expect, it } from 'vitest';
import { describeToolCall } from '../../../../src/renderer/src/chat/toolCallDetails';
import { MEMO_PREVIEW_MAX_LENGTH } from '../../../../src/tools/memo/renderer';

type Details = ReturnType<typeof describeToolCall>;

/** The row values only: labels are the renderer's own wording and are not pinned here. */
function valuesOf(details: Details): string[] {
  return details.parameters.map((parameter) => parameter.value);
}

describe('describeToolCall - aem_get_json', () => {
  it('summarises the requested path and shows it, plus the effective request, as parameters', () => {
    const details = describeToolCall('aem_get_json', { path: '/content/acme/en/us/home' });

    expect(details.summary).toBe('/content/acme/en/us/home');
    expect(valuesOf(details)).toContain('/content/acme/en/us/home');
    expect(valuesOf(details)).toContain('/content/acme/en/us/home.0.json');
  });

  it('reflects includeChildren in the request selector and adds an explicit row', () => {
    const without = describeToolCall('aem_get_json', { path: '/content/acme' });
    const details = describeToolCall('aem_get_json', {
      path: '/content/acme',
      includeChildren: true,
    });

    expect(valuesOf(details)).toContain('/content/acme.1.json');
    expect(valuesOf(details)).not.toContain('/content/acme.0.json');
    expect(details.parameters.length).toBe(without.parameters.length + 1);
  });

  it('lists the requested properties when present', () => {
    const details = describeToolCall('aem_get_json', {
      path: '/content/acme',
      properties: ['jcr:title', 'jcr:description'],
    });

    expect(valuesOf(details)).toContain('jcr:title, jcr:description');
  });

  it('degrades honestly when path is missing rather than inventing one', () => {
    const details = describeToolCall('aem_get_json', {});

    expect(details.summary).toBeUndefined();
    expect(details.parameters.length).toBeGreaterThan(0);
    expect(valuesOf(details).some((value) => value.endsWith('.json'))).toBe(false);
  });
});

describe('describeToolCall - http_fetch', () => {
  it('summarises the URL and lists the request options only when given', () => {
    const plain = describeToolCall('http_fetch', { url: 'https://example.com/a' });
    const probe = describeToolCall('http_fetch', {
      url: 'https://example.com/a',
      method: 'HEAD',
      accept: 'text/html',
    });

    expect(plain.summary).toBe('https://example.com/a');
    expect(valuesOf(plain)).toContain('https://example.com/a');
    expect(valuesOf(probe)).toEqual(expect.arrayContaining(['HEAD', 'text/html']));
    expect(probe.parameters.length).toBeGreaterThan(plain.parameters.length);
  });

  it('degrades honestly when the URL is missing', () => {
    const details = describeToolCall('http_fetch', {});

    expect(details.summary).toBeUndefined();
    expect(details.parameters.length).toBeGreaterThan(0);
  });
});

describe('describeToolCall - page_read', () => {
  it('summarises the selector and reads the counts from the finished result', () => {
    const pending = describeToolCall('page_read', { selector: 'a.cta', attributes: ['href'] });
    const done = describeToolCall(
      'page_read',
      { selector: 'a.cta', limit: 5 },
      { matched: 12, items: [{ tag: 'a' }, { tag: 'a' }] },
    );

    expect(pending.summary).toBe('a.cta');
    expect(valuesOf(pending)).toContain('href');
    expect(valuesOf(done)).toEqual(expect.arrayContaining(['12', '2']));
  });

  it('degrades honestly when the selector is missing', () => {
    const details = describeToolCall('page_read', {});

    expect(details.parameters.length).toBeGreaterThan(0);
  });
});

describe('describeToolCall - page_audit', () => {
  it('summarises the URL and reads the scores from the finished result', () => {
    const pending = describeToolCall('page_audit', {
      url: 'https://example.com/a',
      categories: ['seo', 'performance'],
    });
    const done = describeToolCall(
      'page_audit',
      {},
      {
        url: 'https://example.com/b',
        formFactor: 'mobile',
        scores: [{ category: 'seo', score: 80 }],
        failureCount: 7,
      },
    );

    expect(pending.summary).toBe('https://example.com/a');
    expect(valuesOf(pending)).toContain('seo, performance');
    expect(done.summary).toBe('https://example.com/b');
    expect(valuesOf(done)).toEqual(expect.arrayContaining(['seo 80', '7']));
  });

  it('still describes a call that names nothing', () => {
    const details = describeToolCall('page_audit', {});

    expect(details.parameters.length).toBeGreaterThan(0);
  });
});

describe('describeToolCall - aem_query', () => {
  it('summarises the exact query and repeats it as a labelled parameter', () => {
    const details = describeToolCall('aem_query', {
      predicates: { path: '/content/site', type: 'cq:Page' },
      offset: 0,
      limit: 25,
    });

    expect(details.summary).toBe('path=/content/site&type=cq:Page');
    expect(valuesOf(details)).toContain('path=/content/site&type=cq:Page');
    expect(valuesOf(details)).toContain('0');
    expect(valuesOf(details)).toContain('25');
  });

  it('shows the property projection space-separated, matching the wire parameter', () => {
    const details = describeToolCall('aem_query', {
      predicates: { path: '/content' },
      properties: ['jcr:path', 'jcr:title'],
    });

    expect(valuesOf(details)).toContain('jcr:path jcr:title');
  });

  it('treats a non-string predicate value as no usable query', () => {
    const details = describeToolCall('aem_query', { predicates: { depth: 2 } });

    expect(details.summary).toBeUndefined();
    expect(details.parameters.length).toBeGreaterThan(0);
    expect(valuesOf(details).some((value) => value.includes('depth'))).toBe(false);
  });

  it('shows the roots being fanned out across when present', () => {
    const details = describeToolCall('aem_query', {
      predicates: { type: 'cq:Page' },
      roots: ['/content/a', '/content/b'],
    });

    expect(valuesOf(details)).toContain('/content/a, /content/b');
  });
});

describe('describeToolCall - environment_facts', () => {
  const data = {
    operation: 'environment_facts',
    hosts: [
      {
        label: 'HPE DEV',
        origin: 'https://author.example',
        contentRoots: ['/content/a'],
        componentRoots: ['/apps'],
        current: true,
      },
      {
        label: 'Staging',
        origin: 'https://stage.example',
        contentRoots: ['/content'],
        componentRoots: ['/apps'],
        current: false,
      },
    ],
  };

  it('summarises with the current host URL and lists the facts as rows, read from the result', () => {
    const details = describeToolCall('environment_facts', {}, data);

    expect(details.summary).toBe('https://author.example');
    expect(valuesOf(details)).toContain('https://author.example');
    expect(valuesOf(details)).toContain('/content/a');
    expect(valuesOf(details)).toContain('/apps');
    const hosts = valuesOf(details).find((value) => value.includes('Staging'));
    expect(hosts).toContain('HPE DEV');
    expect(hosts).toContain('https://author.example');
    expect(hosts).toContain('https://stage.example');
  });

  it('falls back to the generic argument view before the result arrives', () => {
    const details = describeToolCall('environment_facts', {});

    expect(details.parameters.length).toBeGreaterThan(0);
  });
});

describe('describeToolCall - browser_navigate', () => {
  it('summarises the host and path, and reads the full URL and outcome from the result', () => {
    const details = describeToolCall(
      'browser_navigate',
      { host: 'HPE DEV', path: '/content/wknd.html' },
      {
        operation: 'browser_navigate',
        hostLabel: 'HPE DEV',
        origin: 'https://author.example',
        path: '/content/wknd.html',
        url: 'https://author.example/content/wknd.html',
        switched: false,
      },
    );

    expect(details.summary).toContain('HPE DEV');
    expect(details.summary).toContain('/content/wknd.html');
    expect(valuesOf(details)).toContain('https://author.example/content/wknd.html');
    expect(details.parameters).toHaveLength(2);
  });

  it('shows the mode from the arguments and the URL the application built', () => {
    const withoutMode = describeToolCall(
      'browser_navigate',
      { host: 'HPE DEV', path: '/content/hpe/languages/jp-apj/home' },
      {
        operation: 'browser_navigate',
        hostLabel: 'HPE DEV',
        origin: 'https://author.example',
        path: '/content/hpe/languages/jp-apj/home.html',
        url: 'https://author.example/content/hpe/languages/jp-apj/home.html',
        switched: false,
      },
    );
    const details = describeToolCall(
      'browser_navigate',
      { host: 'HPE DEV', path: '/content/hpe/languages/jp-apj/home', mode: 'sites' },
      {
        operation: 'browser_navigate',
        hostLabel: 'HPE DEV',
        origin: 'https://author.example',
        path: '/sites.html/content/hpe/languages/jp-apj/home',
        url: 'https://author.example/sites.html/content/hpe/languages/jp-apj/home',
        switched: false,
        mode: 'sites',
      },
    );

    expect(details.summary).toContain('/content/hpe/languages/jp-apj/home');
    expect(valuesOf(details)).toContain(
      'https://author.example/sites.html/content/hpe/languages/jp-apj/home',
    );
    expect(details.parameters.length).toBe(withoutMode.parameters.length + 1);
  });

  it('names a standard place in the summary and a Place row', () => {
    const details = describeToolCall('browser_navigate', {
      host: 'HPE DEV',
      place: 'package_manager',
    });

    expect(details.summary).toContain('HPE DEV');
    expect(details.parameters).toHaveLength(1);
    // The place row and the summary name the same place.
    expect(details.summary).toContain(details.parameters[0]?.value ?? '');
  });

  it('shows only the mode while the call is pending', () => {
    const details = describeToolCall('browser_navigate', {
      host: 'HPE DEV',
      path: '/crx/de',
    });

    expect(details.summary).toContain('HPE DEV');
    expect(details.summary).toContain('/crx/de');
    expect(details.parameters).toEqual([]);
  });
});

describe('describeToolCall - skill tools', () => {
  it('skill: names the skill while pending and adds source and counts once it succeeded', () => {
    const pending = describeToolCall('load_skill', { name: 'demo' });
    const done = describeToolCall(
      'load_skill',
      { name: 'demo' },
      { operation: 'load_skill', skill: 'demo', source: 'user', fileCount: 4, scriptCount: 2 },
    );

    expect(pending.summary).toBe('demo');
    expect(done.summary).toBe('demo');
    expect(pending.parameters).toHaveLength(1);
    expect(done.parameters.length).toBeGreaterThan(pending.parameters.length);
    expect(valuesOf(done)).toEqual(expect.arrayContaining(['demo', '4', '2']));
  });

  it('skill: omits the scripts row when the skill has none and tells built-in from user', () => {
    const user = describeToolCall(
      'load_skill',
      { name: 'demo' },
      { operation: 'load_skill', skill: 'demo', source: 'user', fileCount: 1, scriptCount: 0 },
    );
    const bundled = describeToolCall(
      'load_skill',
      { name: 'demo' },
      { operation: 'load_skill', skill: 'demo', source: 'bundled', fileCount: 1, scriptCount: 0 },
    );

    expect(user.parameters).toHaveLength(3);
    expect(valuesOf(user)).not.toEqual(valuesOf(bundled));
  });

  it('skill_resource: summarises the file and reads lines, size and entries from the result', () => {
    const file = describeToolCall(
      'skill_resource',
      { skill: 'demo', path: 'references/a.md' },
      {
        operation: 'skill_resource',
        kind: 'file',
        size: 120,
        startLine: 1,
        endLine: 9,
        totalLines: 9,
      },
    );
    const listing = describeToolCall(
      'skill_resource',
      { skill: 'demo', path: '.' },
      { operation: 'skill_resource', kind: 'directory', entryCount: 3 },
    );
    const pending = describeToolCall('skill_resource', { skill: 'demo', path: 'references/a.md' });

    expect(file.summary).toContain('references/a.md');
    expect(valuesOf(file)).toEqual(expect.arrayContaining(['1-9 of 9']));
    expect(valuesOf(listing)).toContain('3');
    expect(listing.summary).not.toBe(file.summary);
    expect(pending.parameters).toHaveLength(2);
  });

  it('skill_script: shows the input at once and the result, logs and duration after success', () => {
    const pending = describeToolCall('skill_script', {
      skill: 'demo',
      script: 'scripts/run.js',
      input: { values: [1, 2] },
    });
    const done = describeToolCall(
      'skill_script',
      { skill: 'demo', script: 'scripts/run.js', input: { values: [1, 2] } },
      { operation: 'skill_script', output: { total: 3 }, logs: 'saw 2 values', durationMs: 7 },
    );

    expect(pending.summary).toContain('scripts/run.js');
    expect(valuesOf(pending)).toContain('{"values":[1,2]}');
    expect(valuesOf(done)).toEqual(expect.arrayContaining(['7 ms', '{"total":3}', 'saw 2 values']));
  });

  it('skill_script: cuts a long input to a bounded preview', () => {
    const details = describeToolCall('skill_script', {
      skill: 'demo',
      script: 'scripts/run.js',
      input: { text: 'x'.repeat(1000) },
    });
    const input = valuesOf(details).find((value) => value.startsWith('{'));
    expect(input?.length ?? 0).toBeLessThan(400);
  });

  it('falls back to the generic rows when a skill tool call has no usable arguments', () => {
    for (const name of ['load_skill', 'skill_resource', 'skill_script']) {
      const details = describeToolCall(name, { unexpected: 1 });
      expect(details.parameters.length).toBeGreaterThan(0);
    }
  });
});

describe('describeToolCall - aem_query_format_ask', () => {
  it('summarises the search terms and reads the totals from the finished result', () => {
    const details = describeToolCall(
      'aem_query_format_ask',
      { terms: 'waldo' },
      {
        operation: 'aem_query_format_ask',
        roots: ['/content/a'],
        pageSize: 50,
        pages: 1,
        rows: 3,
        total: { accuracy: 'exact', value: 3 },
        hasMore: false,
      },
    );

    expect(details.summary).toContain('waldo');
    // Terms, roots, page size, pages, rows and total.
    expect(details.parameters).toHaveLength(6);
    expect(valuesOf(details)).toContain('waldo');
    expect(valuesOf(details)).toContain('/content/a');
  });
});

describe('describeToolCall - aem_semantic_search', () => {
  it('summarises a start call and reads the progress from its result', () => {
    const details = describeToolCall(
      'aem_semantic_search',
      { terms: 'waldo', context: 'Waldo is good' },
      {
        operation: 'aem_semantic_search',
        terms: 'waldo',
        context: 'Waldo is good',
        roots: ['/content/a'],
        pageSize: 20,
        page: 2,
        candidatesRead: 100,
        matchesShown: 3,
        total: { accuracy: 'atLeast', value: 140 },
        hasMore: true,
      },
    );

    expect(details.summary).toContain('waldo');
    expect(details.summary).toContain('2');
    // Terms, context, roots, page size, page, candidates read, matches shown, AEM hits.
    expect(details.parameters).toHaveLength(8);
    expect(valuesOf(details)).toContain('Waldo is good');
  });
});

describe('describeToolCall - memo', () => {
  const args = { title: 'Both paths', text: 'Show both paths.', trigger: 'correction' };
  const saved = {
    operation: 'memo',
    id: 'skills/search/x.md',
    title: 'Both paths',
    fileName: 'x.md',
    skill: 'search',
  };

  it('names the title and shows the scope, trigger, text and, once saved, the file', () => {
    const pending = describeToolCall('memo', args);
    expect(pending.summary).toContain('Both paths');
    expect(valuesOf(pending)).toEqual(expect.arrayContaining(['Both paths', 'Show both paths.']));
    expect(valuesOf(pending)).not.toContain('x.md');

    const done = describeToolCall('memo', { ...args, skill: 'search' }, saved);
    expect(done.summary).toContain('search');
    expect(valuesOf(done)).toEqual(expect.arrayContaining(['search', 'x.md']));
  });

  it('cuts a long memo text to a bounded preview', () => {
    const details = describeToolCall('memo', { ...args, text: 'x'.repeat(1000) });
    const longest = Math.max(...valuesOf(details).map((value) => value.length));
    expect(longest).toBe(MEMO_PREVIEW_MAX_LENGTH);
  });
});

describe('describeToolCall - unknown tools', () => {
  it('falls back to the full argument object so no tool is ever invisible', () => {
    const details = describeToolCall('aem_unknown_tool', {
      foo: 'bar',
      count: 3,
      nested: { a: 1 },
    });

    expect(details.summary).toBeUndefined();
    expect(details.parameters).toContainEqual({ label: 'foo', value: 'bar' });
    expect(details.parameters).toContainEqual({ label: 'count', value: '3' });
    expect(details.parameters).toContainEqual({ label: 'nested', value: '{"a":1}' });
  });

  it('never returns an empty parameter list', () => {
    const details = describeToolCall('aem_unknown_tool', {});

    expect(details.parameters.length).toBeGreaterThan(0);
  });
});
