import { describe, expect, it, vi } from 'vitest';
import {
  type JsonValue,
  type ToolHost,
  type ToolReportMessage,
  chatIdSchema,
  newToolCallId,
  ok,
  requestIdSchema,
  serverIdSchema,
  turnIdSchema,
} from '../../../shared';
import {
  PAGE_AUDIT_RUN_ORDER,
  buildPageAuditReport,
  createPageAuditExecutorFactory,
  pageAuditArgsSchema,
  renderPageAuditSuccess,
  type PageAuditSuccess,
} from '../tool';
import {
  PAGE_AUDIT_CATEGORIES,
  type PageAuditFailureKind,
  type PageAuditOutcome,
  type PageAuditReport,
  type PageAuditRequest,
  type PageAuditRunner,
} from '../types';
import { createCountingIdGenerator } from '../../../../tests/support/testIds';
import { NO_SKILLS } from '../../../../tests/support/fakeSkillHost';

const REPORT: PageAuditReport = {
  kind: 'report',
  url: 'https://author.example/page.html',
  formFactor: 'mobile',
  scores: [
    { category: 'performance', score: 0.456 },
    { category: 'seo', score: null },
  ],
  failures: [
    {
      category: 'seo',
      id: 'meta-description',
      title: 'No meta description',
      score: 0,
      evidence: [{ kind: 'text', value: 'The page has no meta description.' }],
    },
    {
      category: 'performance',
      id: 'lcp',
      title: 'Slow LCP',
      score: 0.5,
      displayValue: '4.2 s',
      evidence: [
        {
          kind: 'table',
          columns: [{ key: 'node', label: 'Failing elements' }],
          rows: [
            [
              {
                kind: 'selector',
                selector: 'h1.hero',
                snippet: '<h1 class="hero">Welcome</h1>',
                label: 'h1',
              },
            ],
          ],
        },
      ],
    },
  ],
};

function runnerReturning(outcome: PageAuditOutcome) {
  // The real runner reports the form factor it measured; echo the request so a
  // dual call's two runs are distinguishable.
  return vi.fn<PageAuditRunner>((request) =>
    Promise.resolve(
      outcome.kind === 'report' ? { ...outcome, formFactor: request.formFactor } : outcome,
    ),
  );
}

/**
 * The tool host the executor is built with. Local to this spec: the add-on's
 * tool needs only the clock, the id generator, the live turn context and the
 * progress sink.
 */
function toolHost(report?: (toolCallId: unknown, text: string) => void): ToolHost {
  const ids = createCountingIdGenerator('audit');
  return {
    bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
    currentContext: () => ({
      origin: 'https://author.example',
      serverId: serverIdSchema.parse('server-1'),
      serverRevision: 1,
      navigationEpoch: 0,
      chatId: chatIdSchema.parse('chat-1'),
      turnId: turnIdSchema.parse('turn-1'),
    }),
    environmentFacts: () => undefined,
    configuredHosts: () => [],
    skills: NO_SKILLS,
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
    invokeTool: () => Promise.resolve(ok({})),
    clock: () => 42,
    idGenerator: ids,
    ...(report === undefined ? {} : { reportToolProgress: report }),
  } as unknown as ToolHost;
}

const callContext = {
  toolCallId: newToolCallId(createCountingIdGenerator('call')),
  signal: undefined,
};

async function execute(
  audit: PageAuditRunner,
  args: Readonly<Record<string, JsonValue>>,
  report?: (toolCallId: unknown, text: string) => void,
): Promise<{
  readonly ok: boolean;
  readonly value?: PageAuditSuccess & { readonly textResultForLlm?: string };
  readonly error?: { code: string; requiredAction?: string };
}> {
  const executor = createPageAuditExecutorFactory(audit)(toolHost(report), {
    name: 'page_audit',
    description: '',
    parameters: {},
  });
  const result = (await executor(args, callContext)) as
    | { ok: true; value: JsonValue }
    | { ok: false; error: { code: string; requiredAction?: string } };
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    value: result.value as unknown as PageAuditSuccess & { textResultForLlm?: string },
  };
}

describe('pageAuditArgsSchema', () => {
  it.each([
    ['an empty url', { url: ' ' }],
    ['an unknown category', { categories: ['pwa'] }],
    ['no categories', { categories: [] }],
    ['an unknown form factor', { formFactor: 'tablet' }],
    ['an unknown key', { throttling: 'none' }],
  ])('refuses %s', (_label, args) => {
    expect(pageAuditArgsSchema.safeParse(args).success).toBe(false);
  });

  it('accepts no arguments at all', () => {
    expect(pageAuditArgsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts "both" as the explicit default', () => {
    expect(pageAuditArgsSchema.safeParse({ formFactor: 'both' }).success).toBe(true);
  });
});

describe('the audit executor', () => {
  it('measures both form factors, desktop then mobile, when nothing is named', async () => {
    const audit = runnerReturning(REPORT);

    await execute(audit, {});

    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenNthCalledWith(
      1,
      {
        url: undefined,
        categories: PAGE_AUDIT_CATEGORIES,
        formFactor: 'desktop',
      } satisfies PageAuditRequest,
      undefined,
      expect.any(Function),
    );
    expect(audit).toHaveBeenNthCalledWith(
      2,
      {
        url: undefined,
        categories: PAGE_AUDIT_CATEGORIES,
        formFactor: 'mobile',
      } satisfies PageAuditRequest,
      undefined,
      expect.any(Function),
    );
    expect(PAGE_AUDIT_RUN_ORDER).toEqual(['desktop', 'mobile']);
  });

  it('measures both when the model passes "both" explicitly', async () => {
    const audit = runnerReturning(REPORT);

    await execute(audit, { formFactor: 'both' });

    expect(audit).toHaveBeenCalledTimes(2);
  });

  it('runs only the named form factor', async () => {
    const audit = runnerReturning(REPORT);
    const controller = new AbortController();
    const executor = createPageAuditExecutorFactory(audit)(toolHost(), {
      name: 'page_audit',
      description: '',
      parameters: {},
    });

    await executor(
      { url: '/content/x.html', categories: ['seo'], formFactor: 'desktop' },
      { toolCallId: callContext.toolCallId, signal: controller.signal },
    );

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      { url: '/content/x.html', categories: ['seo'], formFactor: 'desktop' },
      controller.signal,
      expect.any(Function),
    );
  });

  it('reports scores as whole percentages and keeps a missing score missing', async () => {
    const result = await execute(runnerReturning(REPORT), {});

    expect(result.value).toMatchObject({
      auditedAt: 42,
      formFactorLabel: 'desktop, mobile',
      runs: [
        {
          formFactor: 'desktop',
          scores: [
            { category: 'performance', score: 46 },
            { category: 'seo', score: null },
          ],
        },
        {
          formFactor: 'mobile',
          scores: [
            { category: 'performance', score: 46 },
            { category: 'seo', score: null },
          ],
        },
      ],
    });
    const desktop = result.value?.runs[0];
    expect(desktop?.failures[1]).toMatchObject({ score: 50, displayValue: '4.2 s' });
    expect(desktop?.failures[1]?.evidence).toHaveLength(1);
    expect('displayValue' in (desktop?.failures[0] ?? {})).toBe(false);
    expect('runtimeError' in (desktop ?? {})).toBe(false);
  });

  it('carries a run’s own runtime error when there is one', async () => {
    const result = await execute(
      runnerReturning({ ...REPORT, runtimeError: 'The page timed out' }),
      {},
    );

    expect(result.value?.runs[0]).toMatchObject({ runtimeError: 'The page timed out' });
  });

  it.each([
    ['auth_required', 'AUTH_REQUIRED'],
    ['blocked', 'ACCESS_DENIED'],
    ['cancelled', 'CANCELLED'],
    ['failed', 'NETWORK_ERROR'],
    ['invalid_url', 'INVALID_ARGUMENT'],
    ['no_page', 'ACCESS_DENIED'],
    ['timeout', 'TIMEOUT'],
  ] as [PageAuditFailureKind, string][])('maps a %s outcome to %s', async (kind, code) => {
    const result = await execute(runnerReturning({ kind }), {});

    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it('asks the user to sign in when the host showed its sign-in page', async () => {
    const result = await execute(runnerReturning({ kind: 'auth_required' }), {});

    expect(result).toMatchObject({
      ok: false,
      error: { requiredAction: 'sign_in_to_host', retryable: false },
    });
  });

  it('asks the user to pick a host when there is no page to audit', async () => {
    const result = await execute(runnerReturning({ kind: 'no_page' }), {});

    expect(result).toMatchObject({ ok: false, error: { requiredAction: 'select_server' } });
  });

  it('returns a payload whose text lists the failing audits, and reports progress', async () => {
    const report = vi.fn();

    const result = await execute(runnerReturning(REPORT), {}, report);

    expect(result.value?.textResultForLlm).toContain('meta-description');
    expect(report).toHaveBeenCalledWith(callContext.toolCallId, expect.any(String));
  });

  it('keeps the evidence in the result, so the model can discuss it', async () => {
    const result = await execute(runnerReturning(REPORT), {});

    expect(result.value?.runs[0]?.failures).toMatchObject([
      { evidence: [{ kind: 'text', value: 'The page has no meta description.' }] },
      {
        evidence: [
          {
            kind: 'table',
            rows: [[{ kind: 'selector', selector: 'h1.hero' }]],
          },
        ],
      },
    ]);
  });

  it('forwards the stages the run reports as live progress', async () => {
    const report = vi.fn();
    const audit = vi.fn<PageAuditRunner>((_request, _signal, progress) => {
      progress?.('Stage one');
      return Promise.resolve(REPORT);
    });

    await execute(audit, {}, report);

    expect(report).toHaveBeenLastCalledWith(callContext.toolCallId, 'Stage one');
  });

  it('rejects arguments that are not valid before auditing anything', async () => {
    const audit = runnerReturning(REPORT);

    const result = await execute(audit, { formFactor: 'tablet' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(audit).not.toHaveBeenCalled();
  });

  it('carries the report the transcript paints under the payload', async () => {
    const result = await execute(runnerReturning(REPORT), {});

    const report = (result.value as unknown as { report?: ToolReportMessage }).report;
    expect(report?.summary?.rows).toHaveLength(2);
    expect(report?.sections.map((section) => section.title)).toEqual(['Performance', 'SEO']);
  });
});

describe('buildPageAuditReport', () => {
  const success: PageAuditSuccess = {
    ok: true,
    operation: 'page_audit',
    requestId: requestIdSchema.parse('req-1'),
    url: 'https://author.example/page.html',
    runs: [
      {
        formFactor: 'mobile',
        scores: [
          { category: 'performance', score: 46 },
          { category: 'seo', score: null },
        ],
        failures: [
          {
            category: 'seo',
            id: 'meta',
            title: 'No meta',
            score: 0,
            evidence: [{ kind: 'text', value: 'x' }],
          },
        ],
      },
    ],
    formFactorLabel: 'mobile',
    auditedAt: 1,
  };

  it('leads with the score table and statuses each score for a single run', () => {
    const report = buildPageAuditReport(success);

    expect(report.summary?.rows).toEqual([
      [
        { kind: 'text', value: 'Performance' },
        { kind: 'text', value: '46' },
        { kind: 'text', value: 'fail' },
      ],
      [
        { kind: 'text', value: 'SEO' },
        { kind: 'text', value: 'n/a' },
        { kind: 'text', value: 'warn' },
      ],
    ]);
  });

  it('groups the failures into one section per category that has one', () => {
    const report = buildPageAuditReport(success);

    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]).toMatchObject({ title: 'SEO' });
    expect(report.sections[0]?.entries[0]).toMatchObject({ id: 'seo:meta', title: 'No meta' });
    expect(report.sections[0]?.entries[0]?.evidence).toEqual([
      { formFactors: ['mobile'], block: { kind: 'text', value: 'x' } },
    ]);
  });

  it('gives the score table a column per device for a dual run', () => {
    const report = buildPageAuditReport({
      ...success,
      formFactorLabel: 'desktop, mobile',
      runs: [
        {
          formFactor: 'desktop',
          scores: [
            { category: 'performance', score: 70 },
            { category: 'seo', score: 100 },
          ],
          failures: [],
        },
        {
          formFactor: 'mobile',
          scores: [
            { category: 'performance', score: 40 },
            { category: 'seo', score: 100 },
          ],
          failures: [],
        },
      ],
    });

    expect(report.summary?.columns.map((column) => column.label)).toEqual([
      'Category',
      'Desktop',
      'Mobile',
    ]);
    expect(report.summary?.rows[0]).toEqual([
      { kind: 'text', value: 'Performance' },
      { kind: 'status', value: '70', variant: 'notice' },
      { kind: 'status', value: '40', variant: 'negative' },
    ]);
  });

  /** One audit reported by both devices, with each run's evidence. */
  function dualReport(desktopEvidence: readonly unknown[], mobileEvidence: readonly unknown[]) {
    const failure = (evidence: readonly unknown[]) => ({
      category: 'seo' as const,
      id: 'meta',
      title: 'No meta',
      score: 0,
      evidence,
    });
    return buildPageAuditReport({
      ...success,
      formFactorLabel: 'desktop, mobile',
      runs: [
        {
          formFactor: 'desktop',
          scores: [{ category: 'seo', score: 80 }],
          failures: [failure(desktopEvidence)],
        },
        {
          formFactor: 'mobile',
          scores: [{ category: 'seo', score: 60 }],
          failures: [failure(mobileEvidence)],
        },
      ],
    });
  }

  it('collapses word-for-word prose into one block marked both devices', () => {
    const prose = { kind: 'text', value: 'Same explanation.' };
    const entry = dualReport([prose], [prose]).sections[0]?.entries[0];

    expect(entry?.evidence).toEqual([{ formFactors: ['desktop', 'mobile'], block: prose }]);
  });

  it('keeps prose the devices disagree on once per device', () => {
    const entry = dualReport(
      [{ kind: 'text', value: 'Desktop explanation.' }],
      [{ kind: 'text', value: 'Mobile explanation.' }],
    ).sections[0]?.entries[0];

    expect(entry?.evidence).toEqual([
      { formFactors: ['desktop'], block: { kind: 'text', value: 'Desktop explanation.' } },
      { formFactors: ['mobile'], block: { kind: 'text', value: 'Mobile explanation.' } },
    ]);
  });

  it('renders a checklist as an Item/Result table and merges its items', () => {
    const checklist = (observed: string) => ({
      kind: 'checklist' as const,
      items: [
        { label: 'Avoids redirects', value: 'yes' },
        { label: `Server responded slowly (observed ${observed} ms)`, value: 'no' },
        { label: 'No compression applied', value: 'no' },
      ],
    });
    const entry = dualReport([checklist('657')], [checklist('816')]).sections[0]?.entries[0];
    const block = entry?.evidence[0]?.block;

    expect(block?.kind).toBe('table');
    if (block?.kind !== 'table') return;
    expect(block.columns).toEqual([
      { key: 'item', label: 'Item' },
      { key: 'result', label: 'Result' },
    ]);
    expect(block.rows).toEqual([
      [
        { kind: 'text', value: 'Avoids redirects' },
        { kind: 'text', value: 'yes' },
      ],
      [
        { kind: 'text', value: 'Server responded slowly (observed 657 ms)' },
        { kind: 'text', value: 'no' },
      ],
      [
        { kind: 'text', value: 'No compression applied' },
        { kind: 'text', value: 'no' },
      ],
      [
        { kind: 'text', value: 'Server responded slowly (observed 816 ms)' },
        { kind: 'text', value: 'no' },
      ],
    ]);
    expect(block.rowFormFactors).toEqual([
      ['desktop', 'mobile'],
      ['desktop'],
      ['desktop', 'mobile'],
      ['mobile'],
    ]);
  });

  it('collapses an identical table and marks every row both devices', () => {
    const table = {
      kind: 'table' as const,
      columns: [{ key: 'url', label: 'URL' }],
      rows: [[{ kind: 'text' as const, value: 'https://a.example/a.js' }]],
    };
    const entry = dualReport([table], [{ ...table }]).sections[0]?.entries[0];

    expect(entry?.evidence).toEqual([
      {
        formFactors: ['desktop', 'mobile'],
        block: { ...table, rowFormFactors: [['desktop', 'mobile']] },
      },
    ]);
  });

  it('keeps a device row per device when the row carries sub-items', () => {
    const subItems = {
      kind: 'list' as const,
      items: [{ kind: 'text' as const, value: 'https://a.example/a.js' }],
    };
    const table = {
      kind: 'table' as const,
      columns: [
        { key: 'source', label: 'Source' },
        { key: 'sub', label: 'Sub items' },
      ],
      rows: [[{ kind: 'text' as const, value: 'lodash' }, subItems]],
    };
    const entry = dualReport([table], [{ ...table }]).sections[0]?.entries[0];
    const block = entry?.evidence[0]?.block;

    if (block?.kind !== 'table') throw new Error('expected one table');
    expect(block.rows).toEqual([
      [{ kind: 'text', value: 'lodash' }, subItems],
      [{ kind: 'text', value: 'lodash' }, subItems],
    ]);
    expect(block.rowFormFactors).toEqual([['desktop'], ['mobile']]);
  });

  it('merges a table’s rows, keeping a same-key row twice when its values differ', () => {
    const columns = [
      { key: 'url', label: 'URL' },
      { key: 'size', label: 'Size' },
    ];
    const row = (url: string, size: string) => [
      { kind: 'text' as const, value: url },
      { kind: 'text' as const, value: size },
    ];
    const entry = dualReport(
      [
        {
          kind: 'table',
          columns,
          rows: [row('https://a.example/a.js', '120 KB'), row('https://a.example/b.js', '10 KB')],
        },
      ],
      [
        {
          kind: 'table',
          columns,
          rows: [row('https://a.example/a.js', '80 KB'), row('https://a.example/c.js', '5 KB')],
        },
      ],
    ).sections[0]?.entries[0];

    expect(entry?.evidence[0]).toEqual({
      formFactors: ['desktop', 'mobile'],
      block: {
        kind: 'table',
        columns,
        rows: [
          row('https://a.example/a.js', '120 KB'),
          row('https://a.example/a.js', '80 KB'),
          row('https://a.example/b.js', '10 KB'),
          row('https://a.example/c.js', '5 KB'),
        ],
        rowFormFactors: [['desktop'], ['mobile'], ['desktop'], ['mobile']],
      },
    });
  });

  it('keeps one table per device when the columns differ', () => {
    const desktopTable = {
      kind: 'table' as const,
      columns: [{ key: 'url', label: 'URL' }],
      rows: [[{ kind: 'text' as const, value: 'https://a.example/a.js' }]],
    };
    const mobileTable = {
      kind: 'table' as const,
      columns: [{ key: 'source', label: 'Source' }],
      rows: [[{ kind: 'text' as const, value: 'a.js' }]],
    };
    const entry = dualReport([desktopTable], [mobileTable]).sections[0]?.entries[0];

    expect(entry?.evidence).toEqual([
      { formFactors: ['desktop'], block: desktopTable },
      { formFactors: ['mobile'], block: mobileTable },
    ]);
  });

  it('marks a block only one device reported with that device', () => {
    const entry = dualReport([{ kind: 'text', value: 'Only desktop.' }], []).sections[0]
      ?.entries[0];

    expect(entry?.evidence).toEqual([
      { formFactors: ['desktop'], block: { kind: 'text', value: 'Only desktop.' } },
    ]);
  });

  it('notes a run that failed while the other succeeded', () => {
    const report = buildPageAuditReport({
      ...success,
      formFactorLabel: 'desktop, mobile',
      runs: [
        {
          formFactor: 'desktop',
          scores: [{ category: 'seo', score: 80 }],
          failures: [],
        },
        {
          formFactor: 'mobile',
          scores: [],
          failures: [],
          error: 'The audit did not finish before the deadline',
        },
      ],
    });

    expect(report.note).toContain('mobile');
    expect(report.note).toContain('deadline');
  });
});

describe('renderPageAuditSuccess', () => {
  const success: PageAuditSuccess = {
    ok: true,
    operation: 'page_audit',
    requestId: requestIdSchema.parse('req-1'),
    url: 'https://author.example/page.html',
    runs: [
      {
        formFactor: 'mobile',
        scores: [{ category: 'seo', score: 75 }],
        failures: [
          {
            category: 'seo',
            id: 'meta-description',
            title: 'No meta',
            score: 0,
            evidence: [{ kind: 'text', value: 'No meta description.' }],
          },
        ],
      },
    ],
    formFactorLabel: 'mobile',
    auditedAt: 1,
  };

  it('names the page, the scores, the failures and their evidence', () => {
    const text = renderPageAuditSuccess(success);

    expect(text).toContain(success.url);
    expect(text).toContain('meta-description');
    // The evidence itself is in the model-facing text, so the model can discuss
    // or fix what the report found (a tool's text is all the model sees).
    expect(text).toContain('No meta description.');
  });

  it('renders a failing element and a table row as text the model can reason about', () => {
    const text = renderPageAuditSuccess({
      ...success,
      runs: [
        {
          formFactor: 'mobile',
          scores: [{ category: 'performance', score: 0 }],
          failures: [
            {
              category: 'performance',
              id: 'target-size',
              title: 'Touch targets',
              score: 0,
              evidence: [
                {
                  kind: 'table',
                  columns: [{ key: 'node', label: 'Failing Elements' }],
                  rows: [
                    [
                      {
                        kind: 'selector',
                        selector: 'h6.txto-title',
                        snippet: '<h6 class="txto-title">Hi</h6>',
                        explanation: 'Heading order invalid',
                      },
                    ],
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(text).toContain('Failing Elements: ');
    expect(text).toContain('h6.txto-title');
    expect(text).toContain('<h6 class="txto-title">Hi</h6>');
    expect(text).toContain('Heading order invalid');
  });

  it('is only the head when nothing failed', () => {
    const text = renderPageAuditSuccess({
      ...success,
      runs: [{ formFactor: 'mobile', scores: [{ category: 'seo', score: 75 }], failures: [] }],
    });

    expect(text.split('\n')).toHaveLength(1);
  });

  it('names each device and notes a run that failed', () => {
    const text = renderPageAuditSuccess({
      ...success,
      formFactorLabel: 'desktop, mobile',
      runs: [
        {
          formFactor: 'desktop',
          scores: [{ category: 'seo', score: 90 }],
          failures: [],
        },
        {
          formFactor: 'mobile',
          scores: [],
          failures: [],
          error: 'The audit was cancelled',
        },
      ],
    });

    expect(text).toContain('desktop');
    expect(text).toContain('mobile run failed: The audit was cancelled');
  });
});
