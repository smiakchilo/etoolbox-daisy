import { describe, expect, it } from 'vitest';
import {
  AEM_REQUEST_TIMEOUT_MS,
  classifyStaleness,
  computeDeadline,
  isDeadlineExpired,
  jcrPathSchema,
  parseJcrPath,
  type JcrPathRejectionReason,
} from '../../../../src/shared';
import { aemGetJsonArgsSchema } from '../../../../src/tools/aem-get-json/aemGetJson';
import { aemQueryArgsSchema } from '../../../../src/tools/aem-query/aemQuery';
import { toolRequestEnvelopeSchema, type ToolRequestEnvelope } from '../../../support/toolUnions';

function issueMessages(result: {
  success: false;
  error: { issues: { message: string }[] };
}): string[] {
  return result.error.issues.map((issue) => issue.message);
}

function issuePaths(result: {
  success: false;
  error: { issues: { path: PropertyKey[] }[] };
}): PropertyKey[][] {
  return result.error.issues.map((issue) => issue.path);
}

describe('jcrPathSchema / parseJcrPath', () => {
  const invalidPaths = [
    '../etc',
    '/content/../..',
    'http://evil/x',
    '//host/x',
    'content/no-leading-slash',
    '/content/foo.infinity.json',
    '/content/foo?x=1',
    '',
    '/' + 'a'.repeat(1001),
  ];

  it.each(invalidPaths)('rejects %j', (candidate) => {
    expect(parseJcrPath(candidate).ok).toBe(false);
    expect(jcrPathSchema.safeParse(candidate).success).toBe(false);
  });

  // A depth selector (numeric, signed-numeric, or 'infinity') followed by the
  // '.json' extension is caught by the selector check before the extension
  // check ever runs - both are rejections, but the selector is the more
  // specific (and more dangerous) reason, so it should win.
  const selectorPlusJsonExtensionPaths = [
    '/content/site.-1.json',
    '/content/site.99.json',
    '/content/site.INFINITY.json',
  ];

  it.each(selectorPlusJsonExtensionPaths)(
    'rejects the selector+extension form %j as a selector, not merely an extension',
    (candidate) => {
      expect(parseJcrPath(candidate)).toEqual({ ok: false, error: 'contains_sling_selector' });
      expect(jcrPathSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it("rejects a bare '.json' extension with no selector as contains_json_extension", () => {
    // 'json' is not a selector keyword, so this only trips the extension
    // check - proving the two rejection reasons are genuinely independent.
    expect(parseJcrPath('/content/site.json')).toEqual({
      ok: false,
      error: 'contains_json_extension',
    });
  });

  // The application appends its own extension and depth selector when it
  // builds the real request (implementation-plan.md line 315-316), so a path
  // that never mentions '.json' at all can still smuggle a selector the
  // agent is not trusted to choose - this is "servlet-selector substitution"
  // (implementation-plan.md line 319), the half of the attack the extension
  // check alone cannot see.
  const bareSlingSelectorPaths = [
    '/content/site.-1',
    '/content/site.99',
    '/content/site.infinity',
    '/content/site.INFINITY',
    '/content/site.tidy.-1',
    '/content/site.-1.html',
  ];

  it.each(bareSlingSelectorPaths)(
    'rejects the extension-free selector-substitution form %j',
    (candidate) => {
      expect(parseJcrPath(candidate)).toEqual({ ok: false, error: 'contains_sling_selector' });
      expect(jcrPathSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it('still accepts a DAM path whose real node name happens to contain a dot', () => {
    // A regression that blanket-banned dots would also break this - the
    // selector check must target selector-shaped tokens specifically, not
    // any dot in the final segment.
    expect(parseJcrPath('/content/dam/my.file.pdf').ok).toBe(true);
    expect(jcrPathSchema.safeParse('/content/dam/my.file.pdf').success).toBe(true);
  });

  // Sling reads `;key=value` after the resource path as a request path
  // parameter (url-decomposition.html, SLING-848). The documented `;v=`
  // parameter selects a different VERSION of the resource, so this is
  // servlet/resource substitution that never touches a selector keyword.
  const requestPathParameterPaths = [
    '/content/site;v=1.0',
    "/content/site;v='1.0'",
    '/content/site;v=1',
    '/content/site.html;v=1.0',
    "/content/site%3Bv='1.0'", // %3B -> ';'
  ];

  it.each(requestPathParameterPaths)('rejects the request-path-parameter form %j', (candidate) => {
    expect(parseJcrPath(candidate)).toEqual({
      ok: false,
      error: 'contains_request_path_parameter',
    });
    expect(jcrPathSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects the quoted ;v='1.0' form specifically, which the selector check cannot see", () => {
    // Regression guard with teeth: the UNQUOTED ';v=1.0' was already rejected
    // by accident, because its trailing '0' after a dot looks like a numeric
    // selector token. The quoted spelling is the one the Sling docs REQUIRE
    // when the value contains a dot, and it has no such trailing token - so
    // before the dedicated ';' rule it was accepted. Removing that rule must
    // fail this test, not merely shuffle which reason is reported.
    expect(parseJcrPath("/content/site;v='1.0'").ok).toBe(false);
  });

  // A trailing '/' or '//' run leaves an empty segment. The application
  // appends '.<depth>.json'; Sling requires the character after the resource
  // path to be a dot, so this would degrade to an opaque 404.
  const emptySegmentPaths = ['/content/site/', '/content//site', '/content/site//'];

  it.each(emptySegmentPaths)('rejects the empty-segment form %j', (candidate) => {
    expect(parseJcrPath(candidate)).toEqual({ ok: false, error: 'contains_empty_segment' });
    expect(jcrPathSchema.safeParse(candidate).success).toBe(false);
  });

  // For '/a/b./c/d' Sling resolves resource '/a/b' with suffix '/c/d' and NO
  // extension, routing to the stream rendering instead of the JSON servlet.
  const dotTerminatedSegmentPaths = [
    '/content/site./child',
    '/content/./site',
    '/content/site.',
    '/content/site%2E/child', // %2E -> '.'
  ];

  it.each(dotTerminatedSegmentPaths)('rejects the dot-terminated-segment form %j', (candidate) => {
    expect(parseJcrPath(candidate)).toEqual({
      ok: false,
      error: 'contains_dot_terminated_segment',
    });
    expect(jcrPathSchema.safeParse(candidate).success).toBe(false);
  });

  // Anti-over-rejection: the three new rules must not break legitimate JCR
  // names. Namespaced names use a colon, which is NOT a Sling metacharacter.
  const stillValidPaths = [
    '/content/site/jcr:content',
    '/content/site/jcr:content/cq:responsive',
    '/conf/site/settings/wcm/policies/rep:policy',
    '/content/dam/my.file.pdf',
    '/content/사이트/페이지',
    '/content/site/Ünïcödé-node',
  ];

  it.each(stillValidPaths)('still accepts the legitimate JCR path %j', (candidate) => {
    expect(parseJcrPath(candidate).ok).toBe(true);
    expect(jcrPathSchema.safeParse(candidate).success).toBe(true);
  });

  it('rejects a genuinely-named node that looks like a numeric depth selector (documented false positive)', () => {
    // At validation time, a node literally named "report.2024" is
    // indistinguishable from "report" plus a ".2024" depth selector - only
    // the repository could resolve that, and this validator never asks it.
    // requirements-decisions.md section 6 requires rejecting explicitly
    // rather than silently changing the requested operation; a false
    // rejection is recoverable (the user sees why and can retry a different
    // path), whereas a silently-accepted unbounded-depth fetch is not. This
    // is accepted, deliberate behaviour - see the comment on
    // containsSlingSelectorToken - do not "fix" it without re-reading that
    // rationale.
    expect(parseJcrPath('/content/dam/report.2024')).toEqual({
      ok: false,
      error: 'contains_sling_selector',
    });
  });

  // The servlet container percent-decodes the path before Sling resolves it,
  // so a raw string check alone is a filter sitting in front of an encoder -
  // every structural rule above must be re-provable against the decoded
  // form, not just the literal one.
  const percentEncodedSelectorBypassPaths: readonly [string, JcrPathRejectionReason][] = [
    ['/content/site%2E-1', 'contains_sling_selector'], // %2E -> '.'
    ['/content/site.%2D1', 'contains_sling_selector'], // %2D -> '-'
    ['/content/site%2E%2D1', 'contains_sling_selector'], // both decode to '.-1'
    ['/content/site.%69nfinity', 'contains_sling_selector'], // %69 -> 'i'
    ['/content/site%2Ejson', 'contains_json_extension'], // decodes to a bare '.json'
    ['/content/site.-1%2Ejson', 'contains_sling_selector'], // decodes to '.-1.json'
  ];

  it.each(percentEncodedSelectorBypassPaths)(
    'rejects the percent-encoded bypass %j as %s, exactly as its decoded form would be',
    (candidate, expectedReason) => {
      expect(parseJcrPath(candidate)).toEqual({ ok: false, error: expectedReason });
      expect(jcrPathSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it('rejects a double percent-encoded sequence, which exists only to survive one decode and be decoded again', () => {
    // '%252E' decodes once to the literal text '%2E' - it is not a '.' at
    // this validator's decode depth, but downstream code that decodes a
    // second time would see one. There is no legitimate reason for an agent
    // to send an already-percent-encoded percent sign.
    expect(parseJcrPath('/content/site%252E-1')).toEqual({
      ok: false,
      error: 'contains_double_percent_encoding',
    });
  });

  it('rejects a malformed percent-encoded sequence rather than passing it through unresolved', () => {
    expect(parseJcrPath('/content/site%ZZ')).toEqual({
      ok: false,
      error: 'malformed_percent_encoding',
    });
    expect(parseJcrPath('/content/site%2')).toEqual({
      ok: false,
      error: 'malformed_percent_encoding',
    });
  });

  it("still accepts a jcr:content path, whose ':' is an ordinary JCR namespace separator", () => {
    expect(parseJcrPath('/content/site/jcr:content').ok).toBe(true);
    expect(jcrPathSchema.safeParse('/content/site/jcr:content').success).toBe(true);
  });

  it('treats a raw Unicode path and its percent-encoded equivalent as the same accepted path', () => {
    expect(parseJcrPath('/content/caf\u00e9').ok).toBe(true);
    expect(parseJcrPath('/content/caf%C3%A9').ok).toBe(true);
  });

  const validPaths = [
    '/content/dam/my-asset.jpg',
    '/content/we-retail/us/en',
    '/apps/my-app/components/text',
    '/etc/tags/myTag',
    '/content/dam/\u65e5\u672c\u8a9e', // JCR/Sling paths may contain Unicode node names.
    '/',
  ];

  it.each(validPaths)('accepts %j', (candidate) => {
    expect(parseJcrPath(candidate).ok).toBe(true);
    expect(jcrPathSchema.safeParse(candidate).success).toBe(true);
  });

  it('rejects a path containing a fragment', () => {
    expect(parseJcrPath('/content/foo#bar').ok).toBe(false);
  });

  it('rejects a path containing a backslash', () => {
    expect(parseJcrPath('/content\\foo').ok).toBe(false);
  });

  it('distinguishes a protocol-relative path from a merely non-absolute one', () => {
    expect(parseJcrPath('//host/x')).toEqual({ ok: false, error: 'protocol_relative' });
    expect(parseJcrPath('content/x')).toEqual({ ok: false, error: 'not_absolute' });
  });
});

describe('aemGetJsonArgsSchema', () => {
  it('accepts a minimal valid payload', () => {
    const result = aemGetJsonArgsSchema.safeParse({ path: '/content/foo' });
    expect(result.success).toBe(true);
  });

  it('accepts optional properties and includeChildren', () => {
    const result = aemGetJsonArgsSchema.safeParse({
      path: '/content/foo',
      properties: ['jcr:title', 'jcr:primaryType'],
      includeChildren: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid path with an issue naming the path field', () => {
    const result = aemGetJsonArgsSchema.safeParse({ path: '../etc' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(issuePaths(result)).toContainEqual(['path']);
    }
  });

  it('rejects an unknown field the model is not allowed to set', () => {
    expect(aemGetJsonArgsSchema.safeParse({ path: '/content/foo', extra: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects an attempt to smuggle serverId from the model side', () => {
    expect(
      aemGetJsonArgsSchema.safeParse({ path: '/content/foo', serverId: 'server-1' }).success,
    ).toBe(false);
  });

  it('rejects an attempt to smuggle an origin/url from the model side', () => {
    expect(
      aemGetJsonArgsSchema.safeParse({ path: '/content/foo', origin: 'https://evil.example' })
        .success,
    ).toBe(false);
    expect(
      aemGetJsonArgsSchema.safeParse({ path: '/content/foo', url: 'https://evil.example/x' })
        .success,
    ).toBe(false);
  });

  it('rejects a missing path', () => {
    expect(aemGetJsonArgsSchema.safeParse({}).success).toBe(false);
  });
});

describe('aemQueryArgsSchema pagination', () => {
  const basePayload = { predicates: { path: '/content' } };

  it('applies the default limit (50) and default offset (0) when absent', () => {
    const result = aemQueryArgsSchema.parse(basePayload);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it.each([1, 50, 200])('accepts the boundary limit value %d', (limit) => {
    const result = aemQueryArgsSchema.safeParse({ ...basePayload, limit });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(limit);
  });

  it.each([-1, 0, 201, 1.5] as const)(
    'rejects limit %j as an explicit validation error naming the field',
    (limit) => {
      const result = aemQueryArgsSchema.safeParse({ ...basePayload, limit });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(issuePaths(result)).toContainEqual(['limit']);
        expect(issueMessages(result).some((message) => message.includes('limit'))).toBe(true);
      }
    },
  );

  it.each([-1, 2.5] as const)(
    'rejects offset %j as an explicit validation error naming the field',
    (offset) => {
      const result = aemQueryArgsSchema.safeParse({ ...basePayload, offset });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(issuePaths(result)).toContainEqual(['offset']);
        expect(issueMessages(result).some((message) => message.includes('offset'))).toBe(true);
      }
    },
  );

  it('does not clamp an out-of-range limit into range', () => {
    // A regression here would look like `limit: 200` (clamped) instead of a
    // rejection - assert failure, not merely "some value came back".
    const result = aemQueryArgsSchema.safeParse({ ...basePayload, limit: 5000 });
    expect(result.success).toBe(false);
  });

  it('makes p.limit=-1 (unbounded) impossible to express', () => {
    expect(aemQueryArgsSchema.safeParse({ ...basePayload, limit: -1 }).success).toBe(false);
  });

  it('accepts an arbitrary customer predicate without an allowlist', () => {
    const result = aemQueryArgsSchema.safeParse({
      predicates: { path: '/content', '1_group.p.or': 'true', customPredicate: 'abc' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown top-level field (strict args)', () => {
    expect(aemQueryArgsSchema.safeParse({ ...basePayload, serverId: 'server-1' }).success).toBe(
      false,
    );
  });
});

describe('aemQueryArgsSchema predicates - reserved QueryBuilder output keys', () => {
  const reservedKeys = [
    'p.limit',
    'p.offset',
    'p.guessTotal',
    'p.hits',
    'p.nodedepth',
    'p.excerpt',
    'p.facets',
  ];

  it.each(reservedKeys)(
    'rejects the reserved top-level output-control key %j inside predicates',
    (key) => {
      // The same forbidden request that `{ limit: -1 }` already rejects must
      // not be reachable through the other door, i.e. `{ predicates: { "p.limit": "-1" } }`.
      const result = aemQueryArgsSchema.safeParse({
        predicates: { path: '/content', [key]: '-1' },
      });
      expect(result.success).toBe(false);
    },
  );

  const groupScopedKeys = ['group.p.or', '1_group.p.or', 'group.1_property'];

  it.each(groupScopedKeys)(
    'still accepts the group-scoped predicate %j (not an attempt to change global pagination)',
    (key) => {
      const result = aemQueryArgsSchema.safeParse({
        predicates: { path: '/content', [key]: 'true' },
      });
      expect(result.success).toBe(true);
    },
  );

  it.each(['constructor', 'prototype'])('rejects the unsafe predicate key %j', (key) => {
    const result = aemQueryArgsSchema.safeParse({
      predicates: { path: '/content', [key]: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a predicates map carrying an own-enumerable '__proto__' key", () => {
    // Built via JSON.parse, not an object literal: an object-literal `{"__proto__": x}`
    // sets the prototype instead of creating an own property, which would make
    // this test pass for the wrong reason (there would be no key to reject).
    const predicates = JSON.parse('{"path":"/content","__proto__":"polluted"}') as Record<
      string,
      unknown
    >;
    const result = aemQueryArgsSchema.safeParse({ predicates });
    expect(result.success).toBe(false);
  });

  it("does not let a rejected '__proto__' key silently vanish into an accepted result", () => {
    // The defect this guards against: zod's own record parsing drops an
    // own-enumerable '__proto__' key during output construction rather than
    // rejecting it, so a naive implementation could report `success: true`
    // with a predicates map that simply no longer mentions the attack at all.
    const predicates = JSON.parse('{"path":"/content","__proto__":"polluted"}') as Record<
      string,
      unknown
    >;
    const result = aemQueryArgsSchema.safeParse({ predicates });
    expect(result.success).toBe(false);
    expect(aemQueryArgsSchema.safeParse({ predicates: { path: '/content' } }).success).toBe(true);
  });
});

describe('toolRequestEnvelopeSchema', () => {
  const baseEnvelope = {
    requestId: 'req-1',
    chatId: 'chat-1',
    turnId: 'turn-1',
    serverId: 'server-1',
    serverRevision: 1,
    navigationEpoch: 1,
    deadlineMs: 1_000,
  };

  it('accepts a well-formed aem_get_json envelope', () => {
    const result = toolRequestEnvelopeSchema.safeParse({
      operation: 'aem_get_json',
      ...baseEnvelope,
      args: { path: '/content/foo' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a well-formed aem_query envelope', () => {
    const result = toolRequestEnvelopeSchema.safeParse({
      operation: 'aem_query',
      ...baseEnvelope,
      args: { predicates: { path: '/content' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown operation', () => {
    const result = toolRequestEnvelopeSchema.safeParse({
      operation: 'aem_delete',
      ...baseEnvelope,
      args: { path: '/content/foo' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects args from the wrong operation attached to a given operation literal', () => {
    const result = toolRequestEnvelopeSchema.safeParse({
      operation: 'aem_get_json',
      ...baseEnvelope,
      args: { predicates: { path: '/content' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('deadline handling', () => {
  it('computes an absolute deadline from an injected clock, not a duration', () => {
    const clock = () => 1_000;
    expect(computeDeadline(clock)).toBe(1_000 + AEM_REQUEST_TIMEOUT_MS);
  });

  it('reports a deadline as not yet expired before it elapses', () => {
    const deadline = computeDeadline(() => 0);
    expect(isDeadlineExpired(deadline, () => deadline - 1)).toBe(false);
  });

  it('reports a deadline as expired once the clock reaches it', () => {
    const deadline = computeDeadline(() => 0);
    expect(isDeadlineExpired(deadline, () => deadline)).toBe(true);
    expect(isDeadlineExpired(deadline, () => deadline + 1)).toBe(true);
  });
});

describe('classifyStaleness', () => {
  function envelopeWith(serverRevision: number, navigationEpoch: number): ToolRequestEnvelope {
    return toolRequestEnvelopeSchema.parse({
      operation: 'aem_get_json',
      requestId: 'req-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      serverId: 'server-1',
      serverRevision,
      navigationEpoch,
      deadlineMs: 1_000,
      args: { path: '/content/foo' },
    });
  }

  it('reports fresh when both revision and epoch match the current context', () => {
    const envelope = envelopeWith(3, 7);
    expect(classifyStaleness(envelope, { serverRevision: 3, navigationEpoch: 7 })).toBe('fresh');
  });

  it('detects a stale server revision distinctly from a stale navigation epoch', () => {
    const envelope = envelopeWith(3, 7);
    expect(classifyStaleness(envelope, { serverRevision: 4, navigationEpoch: 7 })).toBe(
      'stale_server_revision',
    );
    expect(classifyStaleness(envelope, { serverRevision: 3, navigationEpoch: 8 })).toBe(
      'stale_navigation_epoch',
    );
  });

  it("also treats an envelope revision ahead of the current one as stale, unlike isStaleRevision's one-directional check", () => {
    // Deliberately symmetric: see the comment on classifyStaleness. A
    // directional-only check (as serverConfig.ts's isStaleRevision uses for
    // a chat's cached revision) would misclassify this as "fresh" if the
    // "revision only increases" invariant were ever violated - exactly the
    // situation in which delivering the result would be most dangerous.
    const envelope = envelopeWith(5, 7);
    expect(classifyStaleness(envelope, { serverRevision: 2, navigationEpoch: 7 })).toBe(
      'stale_server_revision',
    );
  });
});
