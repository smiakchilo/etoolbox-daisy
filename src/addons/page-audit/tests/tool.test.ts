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
  PAGE_AUDIT_DEFAULT_FORM_FACTOR,
  buildPageAuditReport,
  createPageAuditExecutorFactory,
  pageAuditArgsSchema,
  renderPageAuditSuccess,
  type PageAuditSuccess,
} from '../tool';
import {
  PAGE_AUDIT_CATEGORIES,
  type PageAuditFailureKind,
  type PageAuditFormFactor,
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
  return vi.fn<PageAuditRunner>(() => Promise.resolve(outcome));
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
});

describe('the audit executor', () => {
  it('audits every category in the default form factor when nothing is named', async () => {
    const audit = runnerReturning(REPORT);

    await execute(audit, {});

    expect(audit).toHaveBeenCalledWith(
      {
        url: undefined,
        categories: PAGE_AUDIT_CATEGORIES,
        formFactor: PAGE_AUDIT_DEFAULT_FORM_FACTOR,
      } satisfies PageAuditRequest,
      undefined,
      expect.any(Function),
    );
  });

  it('passes the named options and the abort signal through', async () => {
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
      scores: [
        { category: 'performance', score: 46 },
        { category: 'seo', score: null },
      ],
    });
    expect(result.value?.failures[1]).toMatchObject({ score: 50, displayValue: '4.2 s' });
    expect(result.value?.failures[1]?.evidence).toHaveLength(1);
    expect('displayValue' in (result.value?.failures[0] ?? {})).toBe(false);
    expect('runtimeError' in (result.value ?? {})).toBe(false);
  });

  it('carries the run’s own runtime error when there is one', async () => {
    const result = await execute(
      runnerReturning({ ...REPORT, runtimeError: 'The page timed out' }),
      {},
    );

    expect(result.value).toMatchObject({ runtimeError: 'The page timed out' });
  });

  it.each([
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

    expect(result.value?.failures).toMatchObject([
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
    auditedAt: 1,
  };

  it('leads with the score table and statuses each score', () => {
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
    expect(report.sections[0]?.entries[0]?.blocks).toEqual([{ kind: 'text', value: 'x' }]);
  });
});

describe('renderPageAuditSuccess', () => {
  const success = {
    ok: true as const,
    operation: 'page_audit' as const,
    requestId: requestIdSchema.parse('req-1'),
    url: 'https://author.example/page.html',
    formFactor: 'mobile' as PageAuditFormFactor,
    scores: [{ category: 'seo' as const, score: 75 }],
    failures: [
      {
        category: 'seo' as const,
        id: 'meta-description',
        title: 'No meta',
        score: 0,
        evidence: [{ kind: 'text', value: 'No meta description.' }],
      },
    ],
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
    });

    expect(text).toContain('Failing Elements: ');
    expect(text).toContain('h6.txto-title');
    expect(text).toContain('<h6 class="txto-title">Hi</h6>');
    expect(text).toContain('Heading order invalid');
  });

  it('is only the head when nothing failed', () => {
    const text = renderPageAuditSuccess({ ...success, failures: [] });

    expect(text.split('\n')).toHaveLength(1);
  });
});
