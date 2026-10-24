import { describe, expect, it, vi } from 'vitest';
import {
  type BrokerOutcome,
  type DomReadSpec,
  chatIdSchema,
  requestIdSchema,
  serverIdSchema,
  turnIdSchema,
} from '../../../src/shared';
import {
  PAGE_READ_DEFAULT_LIMIT,
  createPageReadExecutor,
  executePageRead,
  pageReadArgsSchema,
  type PageReadRequest,
} from '../../../src/tools/page-read/pageRead';
import { createCountingIdGenerator } from '../../support/testIds';

function envelope(args: Record<string, unknown>): PageReadRequest {
  return {
    operation: 'page_read',
    requestId: requestIdSchema.parse('req-1'),
    chatId: chatIdSchema.parse('chat-1'),
    turnId: turnIdSchema.parse('turn-1'),
    serverId: serverIdSchema.parse('server-1'),
    serverRevision: 1,
    navigationEpoch: 0,
    deadlineMs: 1_000_000,
    args: pageReadArgsSchema.parse(args),
  };
}

function domResponse(result: unknown): BrokerOutcome {
  return {
    kind: 'response',
    status: 200,
    contentType: 'application/json',
    bodyText: JSON.stringify(result),
  };
}

const OK_RESULT = {
  status: 'ok',
  url: 'https://author.example/page.html',
  title: 'Page',
  matched: 3,
  items: [{ tag: 'a', text: 'Home', attributes: { href: '/' } }],
  truncated: false,
};

function readReturning(outcome: BrokerOutcome) {
  return vi.fn<(spec: DomReadSpec) => Promise<BrokerOutcome>>(() => Promise.resolve(outcome));
}

describe('pageReadArgsSchema', () => {
  it.each([
    ['a missing selector', {}],
    ['an unknown key', { selector: 'a', url: 'https://x' }],
    ['a limit of zero', { selector: 'a', limit: 0 }],
    ['an attribute name that is not a name', { selector: 'a', attributes: ['x y'] }],
    ['an unknown include', { selector: 'a', include: 'script' }],
  ])('refuses %s', (_label, args) => {
    expect(pageReadArgsSchema.safeParse(args).success).toBe(false);
  });
});

describe('executePageRead', () => {
  it('reads with the default limit and returns the items', async () => {
    const read = readReturning(domResponse(OK_RESULT));

    const result = await executePageRead(envelope({ selector: 'a' }), {
      now: () => 42,
      read,
    });

    expect(read).toHaveBeenCalledWith({ selector: 'a', limit: PAGE_READ_DEFAULT_LIMIT });
    expect(result).toMatchObject({
      ok: true,
      matched: 3,
      title: 'Page',
      readAt: 42,
      items: OK_RESULT.items,
    });
  });

  it('passes only the options the model named', async () => {
    const read = readReturning(domResponse(OK_RESULT));

    await executePageRead(
      envelope({
        selector: 'img',
        include: 'html',
        attributes: ['src'],
        limit: 5,
        frame: 'iframe',
      }),
      { now: () => 0, read },
    );

    expect(read).toHaveBeenCalledWith({
      selector: 'img',
      limit: 5,
      include: 'html',
      attributes: ['src'],
      frame: 'iframe',
    });
  });

  it.each([
    ['invalid_selector', 'INVALID_ARGUMENT'],
    ['frame_unavailable', 'NOT_FOUND'],
  ])('maps a %s result to %s', async (status, code) => {
    const result = await executePageRead(envelope({ selector: 'a' }), {
      now: () => 0,
      read: readReturning(domResponse({ status })),
    });

    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it.each([
    [{ kind: 'no_view' }, 'ACCESS_DENIED'],
    [{ kind: 'bridge_unavailable' }, 'ACCESS_DENIED'],
    [{ kind: 'network_error' }, 'NETWORK_ERROR'],
    [{ kind: 'cancelled' }, 'CANCELLED'],
    [{ kind: 'timeout' }, 'TIMEOUT'],
    [{ kind: 'stale', status: 'stale_navigation_epoch' }, 'STALE_CONTEXT'],
    [{ kind: 'blocked', reason: 'redirect_blocked' }, 'ACCESS_DENIED'],
  ] as [BrokerOutcome, string][])('maps the broker outcome %j to %s', async (outcome, code) => {
    const result = await executePageRead(envelope({ selector: 'a' }), {
      now: () => 0,
      read: readReturning(outcome),
    });

    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it('refuses a body that is not the agreed shape', async () => {
    const notJson = await executePageRead(envelope({ selector: 'a' }), {
      now: () => 0,
      read: readReturning({ kind: 'response', status: 200, contentType: null, bodyText: '<' }),
    });
    const wrongShape = await executePageRead(envelope({ selector: 'a' }), {
      now: () => 0,
      read: readReturning(domResponse({ status: 'ok' })),
    });

    expect(notJson).toMatchObject({ ok: false, error: { code: 'UNEXPECTED_RESPONSE' } });
    expect(wrongShape).toMatchObject({ ok: false, error: { code: 'UNEXPECTED_RESPONSE' } });
  });

  it('says so when the bridge cannot read the DOM at all', async () => {
    const result = await executePageRead(envelope({ selector: 'a' }), {
      now: () => 0,
      read: undefined,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
  });
});

describe('createPageReadExecutor', () => {
  function executor(read: ReturnType<typeof readReturning> | undefined) {
    return createPageReadExecutor({
      read: read === undefined ? undefined : (_envelope, spec) => read(spec),
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

  it('returns a payload whose text carries the match count and the items', async () => {
    const result = await executor(readReturning(domResponse(OK_RESULT)))(
      { selector: 'a', attributes: ['href'] },
      { toolCallId: 'call-1' as never, signal: undefined },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultType: 'success',
        textResultForLlm: expect.stringContaining('3 match(es)') as unknown,
      },
    });
  });

  it('rejects arguments that are not valid before reading anything', async () => {
    const read = readReturning(domResponse(OK_RESULT));

    const result = await executor(read)(
      { selector: 'a', unexpected: true },
      { toolCallId: 'call-1' as never, signal: undefined },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(read).not.toHaveBeenCalled();
  });
});
