import { describe, expect, it } from 'vitest';
import {
  executeAemGetJson,
  type AemGetJsonRequest,
} from '../../../../src/tools/aem-get-json/aemGetJson';
import type { BrokerOutcome } from '../../../../src/shared';
import type { ProjectedResourceData } from '../../../../src/tools/aem-get-json/aemGetJson';
import {
  aemGetJsonArgsSchema,
  type AemGetJsonArgs,
} from '../../../../src/tools/aem-get-json/aemGetJson';
import {
  chatIdSchema,
  requestIdSchema,
  serverIdSchema,
  turnIdSchema,
} from '../../../../src/shared';
import { toolResultSchema, type ToolResult } from '../../../support/toolUnions';
import { TOOL_ERROR_CODES } from '../../../../src/shared';

const ORIGIN = 'https://author.example';

function envelope(argsOverrides: Partial<AemGetJsonArgs> = {}): AemGetJsonRequest {
  return {
    operation: 'aem_get_json',
    // Parsed through the real branded schemas rather than cast, so the test
    // cannot drift from what production actually accepts as an identifier.
    requestId: requestIdSchema.parse('req-1'),
    chatId: chatIdSchema.parse('chat-1'),
    turnId: turnIdSchema.parse('turn-1'),
    serverId: serverIdSchema.parse('server-1'),
    serverRevision: 3,
    navigationEpoch: 2,
    deadlineMs: 1_000_000,
    args: aemGetJsonArgsSchema.parse({ path: '/content/site', ...argsOverrides }),
  };
}

function run(
  outcome: BrokerOutcome,
  argsOverrides: Partial<AemGetJsonArgs> = {},
  origin = ORIGIN,
): Promise<ToolResult> {
  return executeAemGetJson(envelope(argsOverrides), {
    origin,
    fetchThroughBridge: () => Promise.resolve(outcome),
    now: () => 1_700_000_000_000,
  });
}

function jsonResponse(body: string, status = 200): BrokerOutcome {
  return { kind: 'response', status, contentType: 'application/json', bodyText: body };
}

function expectError(result: ToolResult): ToolResult & { ok: false } {
  if (result.ok) throw new Error('expected a tool error');
  return result;
}

describe('executeAemGetJson - the successful path', () => {
  it('returns a projected resource that satisfies the shared tool result contract', async () => {
    const result = await run(
      jsonResponse('{"jcr:primaryType":"cq:Page","jcr:content":{"jcr:title":"Home"}}'),
      { includeChildren: true },
    );

    expect(toolResultSchema.safeParse(result).success).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.operation).toBe('aem_get_json');
    expect(result.sourceOrigin).toBe(ORIGIN);
    expect(result.serverRevision).toBe(3);
    if (result.operation !== 'aem_get_json') throw new Error('wrong operation');
    const data = result.data as ProjectedResourceData;
    expect(data.properties).toEqual({ 'jcr:primaryType': 'cq:Page' });
    expect(data.childNodes).toEqual([{ name: 'jcr:content' }]);
  });

  it("stamps the success with the request's own id and the injected clock", async () => {
    const result = await run(jsonResponse('{}'));
    if (!result.ok) throw new Error('expected success');
    expect(result.requestId).toBe('req-1');
    expect(result.fetchedAt).toBe(1_700_000_000_000);
  });
});

describe('executeAemGetJson - what each AEM status means to the agent', () => {
  it('treats 403 as not permitted, never as a request to sign in again', async () => {
    // The plan calls this out by name. A session that is correctly signed in
    // can still be refused one node by AEM's ACLs, so telling the user to sign
    // in would be wrong rather than merely unhelpful.
    const error = expectError(await run(jsonResponse('denied', 403))).error;

    expect(error.code).toBe('NOT_AUTHORIZED');
    expect(error.requiredAction).toBe('none');
    expect(error.retryable).toBe(false);
  });

  it('treats 401 as a missing session that the user must restore in the browser pane', async () => {
    const error = expectError(await run(jsonResponse('nope', 401))).error;

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.requiredAction).toBe('sign_in_to_host');
  });

  it('treats a 200 HTML login page as a missing session, not as a successful response', async () => {
    // The most dangerous shape in the whole feature: HTTP says success, and an
    // agent that trusted the status alone would hand a login page to the model
    // as though it were the resource.
    const error = expectError(
      await run({
        kind: 'response',
        status: 200,
        contentType: 'text/html; charset=utf-8',
        bodyText:
          '<html lang="en"><head><title>AEM Sign In</title></head>' +
          '<body><form action="/j_security_check"></form></body></html>',
      }),
    ).error;

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.requiredAction).toBe('sign_in_to_host');
  });

  it('does not treat a non-login HTML page as a request to sign in again', async () => {
    // AEM answers an error page with 200 + text/html too, so HTML alone is not
    // evidence that the session ended.
    const error = expectError(
      await run({
        kind: 'response',
        status: 200,
        contentType: 'text/html; charset=utf-8',
        bodyText: '<html lang="en"><body><h1>Error</h1></body></html>',
      }),
    ).error;

    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.requiredAction).toBe('none');
  });

  it('reports an empty 200 body as an unexpected response, never as a sign-in', async () => {
    const error = expectError(
      await run({
        kind: 'response',
        status: 200,
        contentType: 'text/html;charset=utf-8',
        bodyText: '\n',
      }),
    ).error;

    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.requiredAction).toBe('none');
    expect(error.message).toMatch(/empty/i);
  });

  it('treats 404 as a missing resource the agent must correct, not a transient failure', async () => {
    const error = expectError(await run(jsonResponse('missing', 404))).error;

    expect(error.code).toBe('NOT_FOUND');
    expect(error.retryable).toBe(false);
  });

  it("treats Sling's 300 as a result too large to traverse, with actionable advice", async () => {
    // Sling answers 300 with a valid JSON ARRAY of alternative URLs once
    // traversal exceeds its own guard. It parses as JSON and is not the
    // resource, so the agent needs to be told to ask for less.
    const error = expectError(
      await run(jsonResponse('["/content/site.1.json","/content/site.2.json"]', 300)),
    ).error;

    expect(error.code).toBe('RESULT_TOO_LARGE_FOR_MODEL');
    expect(error.requiredAction).toBe('reduce_result_size');
  });

  it('treats a 5xx as worth retrying unchanged, unlike every 4xx', async () => {
    const error = expectError(await run(jsonResponse('boom', 503))).error;

    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.retryable).toBe(true);
  });

  it('rejects JSON that parses but is not a resource object', async () => {
    const error = expectError(await run(jsonResponse('[1,2,3]'))).error;

    expect(error.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('rejects a body that does not parse as JSON at all', async () => {
    const error = expectError(await run(jsonResponse('{ not json'))).error;

    expect(error.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('rejects a non-JSON content type even when the body would have parsed', async () => {
    const error = expectError(
      await run({ kind: 'response', status: 200, contentType: 'text/plain', bodyText: '{"a":1}' }),
    ).error;

    expect(error.code).toBe('UNEXPECTED_RESPONSE');
  });
});

describe('executeAemGetJson - what each transport verdict means to the agent', () => {
  it('reports a blocked redirect as a session problem the user must resolve', async () => {
    const error = expectError(await run({ kind: 'blocked', reason: 'redirect_blocked' })).error;

    expect(error.code).toBe('REDIRECT_BLOCKED');
    expect(error.requiredAction).toBe('sign_in_to_host');
    expect(error.retryable).toBe(false);
  });

  it("reports a cross-origin refusal as this application's own policy, not an AEM failure", async () => {
    const error = expectError(await run({ kind: 'blocked', reason: 'cross_origin' })).error;

    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.retryable).toBe(false);
  });

  it('reports a timeout as retryable, because the identical request may still succeed', async () => {
    const error = expectError(await run({ kind: 'timeout' })).error;

    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
  });

  it('reports staleness as retryable and names which kind of staleness it was', async () => {
    const navigation = expectError(
      await run({ kind: 'stale', status: 'stale_navigation_epoch' }),
    ).error;
    const revision = expectError(
      await run({ kind: 'stale', status: 'stale_server_revision' }),
    ).error;

    expect(navigation.code).toBe('STALE_CONTEXT');
    expect(navigation.retryable).toBe(true);
    // Distinct messages: "the browser left the page" and "the server config
    // changed" are different facts, and a shared message would hide which.
    expect(navigation.message).not.toBe(revision.message);
  });

  it('reports a cancellation as cancelled rather than as a failure', async () => {
    const error = expectError(await run({ kind: 'cancelled' })).error;

    expect(error.code).toBe('CANCELLED');
  });

  it('reports a missing browser pane as something the user must address', async () => {
    const error = expectError(await run({ kind: 'no_view' })).error;

    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.requiredAction).toBe('select_server');
  });

  it('reports an unavailable bridge as a non-retryable application problem, distinct from no_view', async () => {
    const bridge = expectError(await run({ kind: 'bridge_unavailable' })).error;
    const noView = expectError(await run({ kind: 'no_view' })).error;

    expect(bridge.code).toBe('ACCESS_DENIED');
    expect(bridge.retryable).toBe(false);
    // The pane is present, so this is not "pick a server" - and the two facts
    // must not share a message, or the log could not tell them apart.
    expect(bridge.requiredAction).toBe('none');
    expect(bridge.message).not.toBe(noView.message);
  });

  it('reports a transport failure as retryable', async () => {
    const error = expectError(
      await run({ kind: 'network_error', message: 'ERR_CONNECTION_REFUSED' }),
    ).error;

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.retryable).toBe(true);
  });
});

describe('executeAemGetJson - refusing before anything is sent', () => {
  it('defends against an invalid JCR path itself, without performing any request', async () => {
    // The args schema already rejects this, so the path is constructed
    // directly here rather than through `parse`. That is the point of the
    // test: the handler must not be relying on an earlier layer having
    // validated for it, because `buildResourceUrl` is the last thing standing
    // between an agent-supplied string and a real HTTP request.
    let sent = 0;
    const base = envelope();
    const result = await executeAemGetJson(
      { ...base, args: { ...base.args, path: '/content/../etc' } },
      {
        origin: ORIGIN,
        fetchThroughBridge: () => {
          sent += 1;
          return Promise.resolve(jsonResponse('{}'));
        },
        now: () => 0,
      },
    );

    expect(expectError(result).error.code).toBe('INVALID_ARGUMENT');
    expect(sent).toBe(0);
  });

  it('rejects an unusable server origin without performing any request', async () => {
    let sent = 0;
    const result = await executeAemGetJson(envelope(), {
      origin: 'not-an-origin',
      fetchThroughBridge: () => {
        sent += 1;
        return Promise.resolve(jsonResponse('{}'));
      },
      now: () => 0,
    });

    expect(expectError(result).error.code).toBe('ACCESS_DENIED');
    expect(sent).toBe(0);
  });
});

describe('executeAemGetJson - errors never carry remote content', () => {
  /**
   * The single property that matters most here: an error message is
   * application-authored text, never anything the server said. A parser
   * message can quote the body, and a redirect target is fully
   * attacker-controllable, so either leaking into the model's context or the
   * logs would be exactly the passthrough requirements-decisions.md section 2
   * forbids.
   */
  const secret = 'SUPER-SECRET-MARKER-9f3a';

  it('does not echo the response body in the error for unparseable JSON', async () => {
    const error = expectError(await run(jsonResponse(`{ broken ${secret}`))).error;

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('does not echo an HTML error page in the error', async () => {
    const error = expectError(
      await run({
        kind: 'response',
        status: 500,
        contentType: 'text/html',
        bodyText: `<html lang='en'>${secret}</html>`,
      }),
    ).error;

    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("does not echo a transport failure's own message, which can name internal hosts", async () => {
    const error = expectError(
      await run({ kind: 'network_error', message: `connect failed to ${secret}` }),
    ).error;

    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("produces a message within the contract's length limit for every failure it can report", async () => {
    const outcomes: BrokerOutcome[] = [
      { kind: 'blocked', reason: 'redirect_blocked' },
      { kind: 'blocked', reason: 'cross_origin' },
      { kind: 'blocked', reason: 'invalid_url' },
      { kind: 'network_error', message: 'x' },
      { kind: 'cancelled' },
      { kind: 'timeout' },
      { kind: 'stale', status: 'stale_server_revision' },
      { kind: 'stale', status: 'stale_navigation_epoch' },
      { kind: 'no_view' },
      { kind: 'bridge_unavailable' },
      jsonResponse('x', 401),
      jsonResponse('x', 403),
      jsonResponse('x', 404),
      jsonResponse('x', 400),
      jsonResponse('[]', 300),
      jsonResponse('x', 302),
      jsonResponse('x', 500),
      jsonResponse('x', 418),
      jsonResponse('[1]'),
      jsonResponse('{ bad'),
    ];

    for (const outcome of outcomes) {
      const result = await run(outcome);
      const error = expectError(result).error;
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message.length).toBeLessThanOrEqual(500);
      expect(TOOL_ERROR_CODES).toContain(error.code);
      // Round-tripping through the real schema is what proves the whole error
      // object is contract-valid, not just its message.
      expect(toolResultSchema.safeParse(result).success).toBe(true);
    }
  });
});
