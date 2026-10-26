import { describe, expect, it, vi } from 'vitest';
import {
  type PageAuditFailureKind,
  type PageAuditOutcome,
  type PageAuditReport,
  type PageAuditRequest,
  type PageAuditRunner,
  type ToolHost,
  PAGE_AUDIT_CATEGORIES,
  chatIdSchema,
  ok,
  requestIdSchema,
  serverIdSchema,
  turnIdSchema,
} from '../../../src/shared';
import {
  type PageAuditRequestEnvelope,
  PAGE_AUDIT_DEFAULT_FORM_FACTOR,
  createPageAuditExecutor,
  executePageAudit,
  pageAuditArgsSchema,
  renderPageAuditSuccess,
} from '../../../src/tools/page-audit/pageAudit';
import { createCountingIdGenerator } from '../../support/testIds';

function envelope(args: Record<string, unknown>): PageAuditRequestEnvelope {
  return {
    operation: 'page_audit',
    requestId: requestIdSchema.parse('req-1'),
    chatId: chatIdSchema.parse('chat-1'),
    turnId: turnIdSchema.parse('turn-1'),
    serverId: serverIdSchema.parse('server-1'),
    serverRevision: 1,
    navigationEpoch: 0,
    deadlineMs: 1_000_000,
    args: pageAuditArgsSchema.parse(args),
  };
}

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
      evidence: {
        columns: [{ key: 'detail', label: 'What to fix' }],
        rows: [{ detail: 'The page has no meta description.' }],
      },
    },
    {
      category: 'performance',
      id: 'lcp',
      title: 'Slow LCP',
      score: 0.5,
      displayValue: '4.2 s',
      evidence: {
        columns: [{ key: 'node', label: 'Failing elements' }],
        rows: [{ node: 'h1 — h1.hero — <h1 class="hero">Welcome</h1>' }],
      },
    },
  ],
};

function runnerReturning(outcome: PageAuditOutcome) {
  return vi.fn<PageAuditRunner>(() => Promise.resolve(outcome));
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

describe('executePageAudit', () => {
  it('audits every category in the default form factor when nothing is named', async () => {
    const audit = runnerReturning(REPORT);

    await executePageAudit(envelope({}), { now: () => 0, audit, signal: undefined });

    expect(audit).toHaveBeenCalledWith(
      {
        url: undefined,
        categories: PAGE_AUDIT_CATEGORIES,
        formFactor: PAGE_AUDIT_DEFAULT_FORM_FACTOR,
      } satisfies PageAuditRequest,
      undefined,
      undefined,
    );
  });

  it('passes the named options and the abort signal through', async () => {
    const audit = runnerReturning(REPORT);
    const controller = new AbortController();

    await executePageAudit(
      envelope({ url: '/content/x.html', categories: ['seo'], formFactor: 'desktop' }),
      { now: () => 0, audit, signal: controller.signal },
    );

    expect(audit).toHaveBeenCalledWith(
      { url: '/content/x.html', categories: ['seo'], formFactor: 'desktop' },
      controller.signal,
      undefined,
    );
  });

  it('reports scores as whole percentages and keeps a missing score missing', async () => {
    const result = await executePageAudit(envelope({}), {
      now: () => 42,
      audit: runnerReturning(REPORT),
      signal: undefined,
    });

    expect(result).toMatchObject({
      ok: true,
      auditedAt: 42,
      scores: [
        { category: 'performance', score: 46 },
        { category: 'seo', score: null },
      ],
    });
    if (result.ok) {
      expect(result.failures[1]).toMatchObject({ score: 50, displayValue: '4.2 s' });
      expect(result.failures[1]?.evidence.rows).toHaveLength(1);
      expect('displayValue' in (result.failures[0] ?? {})).toBe(false);
      expect('runtimeError' in result).toBe(false);
    }
  });

  it('carries Lighthouse’s own runtime error when there is one', async () => {
    const result = await executePageAudit(envelope({}), {
      now: () => 0,
      audit: runnerReturning({ ...REPORT, runtimeError: 'The page timed out' }),
      signal: undefined,
    });

    expect(result).toMatchObject({ ok: true, runtimeError: 'The page timed out' });
  });

  it.each([
    ['blocked', 'ACCESS_DENIED'],
    ['cancelled', 'CANCELLED'],
    ['failed', 'NETWORK_ERROR'],
    ['invalid_url', 'INVALID_ARGUMENT'],
    ['no_page', 'ACCESS_DENIED'],
    ['timeout', 'TIMEOUT'],
  ] as [PageAuditFailureKind, string][])('maps a %s outcome to %s', async (kind, code) => {
    const result = await executePageAudit(envelope({}), {
      now: () => 0,
      audit: runnerReturning({ kind }),
      signal: undefined,
    });

    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it('asks the user to pick a host when there is no page to audit', async () => {
    const result = await executePageAudit(envelope({}), {
      now: () => 0,
      audit: runnerReturning({ kind: 'no_page' }),
      signal: undefined,
    });

    expect(result).toMatchObject({ ok: false, error: { requiredAction: 'select_server' } });
  });

  it('says so when the build cannot audit at all', async () => {
    const result = await executePageAudit(envelope({}), {
      now: () => 0,
      audit: undefined,
      signal: undefined,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
  });
});

describe('renderPageAuditSuccess', () => {
  const success = {
    ok: true as const,
    operation: 'page_audit' as const,
    requestId: requestIdSchema.parse('req-1'),
    url: 'https://author.example/page.html',
    formFactor: 'mobile' as const,
    scores: [{ category: 'seo' as const, score: 75 }],
    failures: [
      {
        category: 'seo' as const,
        id: 'meta-description',
        title: 'No meta',
        score: 0,
        evidence: {
          columns: [{ key: 'detail', label: 'What to fix' }],
          rows: [{ detail: 'No meta description.' }],
        },
      },
    ],
    auditedAt: 1,
  };

  it('names the page, the scores, the failures and their evidence', () => {
    const text = renderPageAuditSuccess(success);

    expect(text).toContain(success.url);
    expect(text).toContain('meta-description');
    expect(text).toContain('1 item(s) in `evidence`');
  });

  it('is only the head when nothing failed', () => {
    const text = renderPageAuditSuccess({ ...success, failures: [] });

    expect(text.split('\n')).toHaveLength(1);
  });
});

describe('createPageAuditExecutor', () => {
  type InvokeTool = ToolHost['invokeTool'];

  function executor(
    audit: PageAuditRunner | undefined,
    options: {
      report?: (toolCallId: never, text: string) => void;
      invokeTool?: InvokeTool;
    } = {},
  ) {
    return createPageAuditExecutor({
      audit,
      report: options.report as never,
      invokeTool:
        options.invokeTool ?? (() => Promise.resolve(ok({ resultType: 'success' } as never))),
      currentContext: () => ({
        origin: 'https://author.example',
        serverId: serverIdSchema.parse('server-1'),
        serverRevision: 1,
        navigationEpoch: 0,
        chatId: chatIdSchema.parse('chat-1'),
        turnId: turnIdSchema.parse('turn-1'),
      }),
      clock: () => 1_700_000_000_000,
      idGenerator: createCountingIdGenerator('id'),
    });
  }

  function invokeSpy() {
    return vi.fn<InvokeTool>(() => Promise.resolve(ok({ resultType: 'success' })));
  }

  function context() {
    return { toolCallId: 'call-1' as never, signal: undefined };
  }

  it('returns a payload whose text lists the failing audits, and reports progress', async () => {
    const report = vi.fn();

    const result = await executor(runnerReturning(REPORT), { report })({}, context());

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultType: 'success',
        textResultForLlm: expect.stringContaining('meta-description') as unknown,
      },
    });
    expect(report).toHaveBeenCalledWith('call-1', expect.any(String));
  });

  it('keeps the evidence in the result, so the model can discuss it', async () => {
    const result = await executor(runnerReturning(REPORT))({}, context());

    expect(result).toMatchObject({
      ok: true,
      value: {
        failures: [
          { evidence: { columns: [{ key: 'detail', label: 'What to fix' }] } },
          { evidence: { rows: [{ node: expect.any(String) as unknown }] } },
        ],
      },
    });
  });

  it('paints the score table, then one table per failed audit', async () => {
    const invokeTool = invokeSpy();

    await executor(runnerReturning(REPORT), { invokeTool })({}, context());

    expect(invokeTool.mock.calls).toHaveLength(3);
    const titles = invokeTool.mock.calls.map(([name, args]) => [
      name,
      (args as Record<string, unknown>)['title'],
    ]);
    expect(titles).toEqual([
      ['format_table', 'Lighthouse - https://author.example/page.html (mobile)'],
      ['format_table', 'SEO · No meta description'],
      ['format_table', 'Performance · Slow LCP — 4.2 s'],
    ]);
  });

  it("hands each audit's own evidence to the table verbatim", async () => {
    const invokeTool = invokeSpy();

    await executor(runnerReturning(REPORT), { invokeTool })({}, context());

    const failureCall = invokeTool.mock.calls[2];
    expect(failureCall?.[1]).toMatchObject({
      mode: 'new',
      title: 'Performance · Slow LCP — 4.2 s',
      columns: REPORT.failures[1]?.evidence.columns,
      data: REPORT.failures[1]?.evidence.rows,
    });
  });

  it('paints a pass/warn/fail status per score, and n/a for a missing one', async () => {
    const invokeTool = invokeSpy();

    await executor(runnerReturning(REPORT), { invokeTool })({}, context());

    expect(invokeTool.mock.calls[0]?.[1]).toMatchObject({
      data: [
        { category: 'Performance', score: 46, status: 'fail' },
        { category: 'SEO', score: 'n/a', status: 'warn' },
      ],
    });
  });

  it('paints nothing when the audit itself failed', async () => {
    const invokeTool = invokeSpy();

    const result = await executor(runnerReturning({ kind: 'no_page' }), { invokeTool })(
      {},
      context(),
    );

    expect(result).toMatchObject({ ok: false });
    expect(invokeTool.mock.calls).toHaveLength(0);
  });

  it('forwards the stages the runner reports as live progress', async () => {
    const report = vi.fn();
    const audit = vi.fn<PageAuditRunner>((_request, _signal, progress) => {
      progress?.('Stage one');
      return Promise.resolve(REPORT);
    });

    await executor(audit, { report })({}, context());

    expect(report).toHaveBeenLastCalledWith('call-1', 'Stage one');
  });

  it('rejects arguments that are not valid before auditing anything', async () => {
    const audit = runnerReturning(REPORT);

    const result = await executor(audit)({ formFactor: 'tablet' }, context());

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(audit).not.toHaveBeenCalled();
  });
});
