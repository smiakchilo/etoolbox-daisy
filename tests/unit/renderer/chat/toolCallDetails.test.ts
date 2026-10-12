import { describe, expect, it } from 'vitest';
import { describeToolCall } from '../../../../src/renderer/src/chat/toolCallDetails';

describe('describeToolCall - aem_get_json', () => {
  it('summarises the requested path and shows it, plus the effective request, as parameters', () => {
    const details = describeToolCall('aem_get_json', { path: '/content/acme/en/us/home' });

    expect(details.summary).toBe('/content/acme/en/us/home');
    expect(details.parameters).toContainEqual({
      label: 'Path',
      value: '/content/acme/en/us/home',
    });
    expect(details.parameters).toContainEqual({
      label: 'Request',
      value: '/content/acme/en/us/home.0.json',
    });
  });

  it('reflects includeChildren in the request selector and adds an explicit row', () => {
    const details = describeToolCall('aem_get_json', {
      path: '/content/acme',
      includeChildren: true,
    });

    expect(details.parameters).toContainEqual({
      label: 'Request',
      value: '/content/acme.1.json',
    });
    expect(details.parameters).toContainEqual({ label: 'Include children', value: 'Yes' });
  });

  it('lists the requested properties when present', () => {
    const details = describeToolCall('aem_get_json', {
      path: '/content/acme',
      properties: ['jcr:title', 'jcr:description'],
    });

    expect(details.parameters).toContainEqual({
      label: 'Properties',
      value: 'jcr:title, jcr:description',
    });
  });

  it('degrades honestly when path is missing rather than inventing one', () => {
    const details = describeToolCall('aem_get_json', {});

    expect(details.summary).toBeUndefined();
    expect(details.parameters).toContainEqual({ label: 'Path', value: '(not provided)' });
    expect(details.parameters.some((parameter) => parameter.label === 'Request')).toBe(false);
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
    expect(details.parameters).toContainEqual({
      label: 'Query',
      value: 'path=/content/site&type=cq:Page',
    });
    expect(details.parameters).toContainEqual({ label: 'Offset', value: '0' });
    expect(details.parameters).toContainEqual({ label: 'Limit', value: '25' });
  });

  it('shows the property projection space-separated, matching the wire parameter', () => {
    const details = describeToolCall('aem_query', {
      predicates: { path: '/content' },
      properties: ['jcr:path', 'jcr:title'],
    });

    expect(details.parameters).toContainEqual({
      label: 'Properties',
      value: 'jcr:path jcr:title',
    });
  });

  it('treats a non-string predicate value as no usable query', () => {
    const details = describeToolCall('aem_query', { predicates: { depth: 2 } });

    expect(details.summary).toBeUndefined();
    expect(details.parameters).toContainEqual({ label: 'Query', value: '(no predicates)' });
  });

  it('shows the roots being fanned out across when present', () => {
    const details = describeToolCall('aem_query', {
      predicates: { type: 'cq:Page' },
      roots: ['/content/a', '/content/b'],
    });

    expect(details.parameters).toContainEqual({
      label: 'Roots',
      value: '/content/a, /content/b',
    });
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
    expect(details.parameters).toContainEqual({
      label: 'Current host',
      value: 'https://author.example',
    });
    expect(details.parameters).toContainEqual({ label: 'Content roots', value: '/content/a' });
    expect(details.parameters).toContainEqual({ label: 'Component roots', value: '/apps' });
    expect(details.parameters).toContainEqual({
      label: 'Hosts',
      value: 'HPE DEV (current): https://author.example; Staging: https://stage.example',
    });
  });

  it('falls back to the generic argument view before the result arrives', () => {
    const details = describeToolCall('environment_facts', {});

    expect(details.parameters).toEqual([{ label: 'Arguments', value: '(none)' }]);
  });
});

describe('describeToolCall - browser_navigate', () => {
  it('summarises the host and path, and reads the outcome from the result', () => {
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

    expect(details.summary).toBe('Open HPE DEV: /content/wknd.html');
    expect(details.parameters).toEqual([
      { label: 'Host', value: 'HPE DEV' },
      { label: 'Origin', value: 'https://author.example' },
      { label: 'Path', value: '/content/wknd.html' },
      { label: 'Result', value: 'Opened' },
    ]);
  });

  it('reads the host from the arguments while the call is pending', () => {
    const details = describeToolCall('browser_navigate', {
      host: 'HPE DEV',
      path: '/crx/de',
    });

    expect(details.summary).toBe('Open HPE DEV: /crx/de');
    expect(details.parameters).toEqual([
      { label: 'Host', value: 'HPE DEV' },
      { label: 'Path', value: '/crx/de' },
    ]);
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

    expect(details.summary).toBe('Search: waldo');
    expect(details.parameters.map((row) => row.label)).toEqual([
      'Terms',
      'Roots',
      'Page size',
      'Pages',
      'Rows',
      'Total',
    ]);
  });
});

describe('describeToolCall - aem_semantic_search', () => {
  it('summarises the terms and the page, and reads the progress from the result', () => {
    const details = describeToolCall(
      'aem_semantic_search',
      { searchId: 's-1', matches: [1] },
      {
        operation: 'aem_semantic_search',
        terms: 'waldo',
        context: 'Waldo is good',
        roots: ['/content/a'],
        pageSize: 50,
        page: 2,
        candidatesRead: 100,
        matchesShown: 3,
        total: { accuracy: 'estimated', value: 140 },
        hasMore: true,
      },
    );

    expect(details.summary).toBe('Semantic search: waldo (page 2)');
    expect(details.parameters.map((row) => row.label)).toEqual([
      'Terms',
      'Context',
      'Roots',
      'Page size',
      'Page',
      'Candidates read',
      'Matches shown',
      'AEM hits',
    ]);
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

    expect(details.parameters).toEqual([{ label: 'Arguments', value: '(none)' }]);
  });
});
