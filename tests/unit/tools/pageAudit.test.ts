import { describe, expect, it, vi } from 'vitest';
import {
  type PageAuditFailureKind,
  type PageAuditOutcome,
  type PageAuditRequest,
  type PageAuditRunner,
  PAGE_AUDIT_CATEGORIES,
  chatIdSchema,
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

const REPORT: PageAuditOutcome = {
  kind: 'report',
  url: 'https://author.example/page.html',
  formFactor: 'mobile',
  scores: [
    { category: 'performance', score: 0.456 },
    { category: 'seo', score: null },
  ],
  failures: [
    { category: 'seo', id: 'meta-description', title: 'No meta description', score: 0 },
    {
      category: 'performance',
      id: 'lcp',
      title: 'Slow LCP',
      score: 0.5,
      displayValue: '4.2 s',
    },
  ],
  failureCount: 5,
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
      failureCount: 5,
      scores: [
        { category: 'performance', score: 46 },
        { category: 'seo', score: null },
      ],
    });
    if (result.ok) {
      expect(result.failures[1]).toMatchObject({ score: 50, displayValue: '4.2 s' });
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
    failures: [{ category: 'seo' as const, id: 'meta-description', title: 'No meta', score: 0 }],
    failureCount: 3,
    auditedAt: 1,
  };

  it('names the page, the scores and how many failures were left out', () => {
    const text = renderPageAuditSuccess(success);

    expect(text).toContain(success.url);
    expect(text).toContain('meta-description');
    expect(text).toContain('2 more not listed');
  });

  it('is only the head when nothing failed', () => {
    const text = renderPageAuditSuccess({ ...success, failures: [], failureCount: 0 });

    expect(text.split('\n')).toHaveLength(1);
  });
});

describe('createPageAuditExecutor', () => {
  function executor(
    audit: PageAuditRunner | undefined,
    report?: (toolCallId: never, text: string) => void,
  ) {
    return createPageAuditExecutor({
      audit,
      report: report as never,
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

  it('returns a payload whose text lists the failing audits, and reports progress', async () => {
    const report = vi.fn();

    const result = await executor(runnerReturning(REPORT), report)(
      {},
      { toolCallId: 'call-1' as never, signal: undefined },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultType: 'success',
        textResultForLlm: expect.stringContaining('meta-description') as unknown,
      },
    });
    expect(report).toHaveBeenCalledWith('call-1', expect.any(String));
  });

  it('forwards the stages the runner reports as live progress', async () => {
    const report = vi.fn();
    const audit = vi.fn<PageAuditRunner>((_request, _signal, progress) => {
      progress?.('Stage one');
      return Promise.resolve(REPORT);
    });

    await executor(audit, report)({}, { toolCallId: 'call-1' as never, signal: undefined });

    expect(report).toHaveBeenLastCalledWith('call-1', 'Stage one');
  });

  it('rejects arguments that are not valid before auditing anything', async () => {
    const audit = runnerReturning(REPORT);

    const result = await executor(audit)(
      { formFactor: 'tablet' },
      { toolCallId: 'call-1' as never, signal: undefined },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(audit).not.toHaveBeenCalled();
  });
});
