import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ID, newProxyId, newServerId } from '../../../src/shared';
import {
  addProxyRequestSchema,
  addServerRequestSchema,
  clearPasswordRequestSchema,
  getSettingsSnapshotResultSchema,
  parseAddProxyResult,
  parseGetSettingsSnapshotResult,
  parseSettingsIpcVoidResult,
  passwordTargetSchema,
  removeProxyRequestSchema,
  removeServerRequestSchema,
  reorderProxiesRequestSchema,
  reorderServersRequestSchema,
  setPasswordRequestSchema,
  settingsIpcVoidResultSchema,
  updateProxyRequestSchema,
  updateServerPresentationRequestSchema,
  updateServerTargetingRequestSchema,
} from '../../../src/shared';

const serverId = newServerId(() => 'server-a');
const proxyId = newProxyId(() => 'proxy-a');

describe('passwordTargetSchema', () => {
  it('accepts a server target', () => {
    expect(() => passwordTargetSchema.parse({ kind: 'server', serverId })).not.toThrow();
  });

  it('accepts a proxy-library target', () => {
    expect(() => passwordTargetSchema.parse({ kind: 'proxy', proxyId })).not.toThrow();
  });

  it('accepts an agent target', () => {
    expect(() => passwordTargetSchema.parse({ kind: 'agent', agentId: 'copilot' })).not.toThrow();
  });

  it('rejects an agent target missing agentId', () => {
    expect(() => passwordTargetSchema.parse({ kind: 'agent' })).toThrow();
  });

  it('rejects an agent target carrying an extra key', () => {
    expect(() =>
      passwordTargetSchema.parse({ kind: 'agent', agentId: 'copilot', proxyId }),
    ).toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => passwordTargetSchema.parse({ kind: 'somethingElse' })).toThrow();
  });

  it('rejects a server target missing serverId', () => {
    expect(() => passwordTargetSchema.parse({ kind: 'server' })).toThrow();
  });

  it('rejects a proxy target missing proxyId', () => {
    expect(() => passwordTargetSchema.parse({ kind: 'proxy' })).toThrow();
  });

  it('rejects a proxy target carrying an extra key', () => {
    expect(() => passwordTargetSchema.parse({ kind: 'proxy', proxyId, serverId })).toThrow();
  });
});

describe('setPasswordRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(() =>
      setPasswordRequestSchema.parse({
        target: { kind: 'server', serverId },
        password: 'hunter2',
      }),
    ).not.toThrow();
  });

  it('rejects an empty password', () => {
    const result = setPasswordRequestSchema.safeParse({
      target: { kind: 'server', serverId },
      password: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a password over the length limit', () => {
    const result = setPasswordRequestSchema.safeParse({
      target: { kind: 'proxy', proxyId },
      password: 'x'.repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload missing target', () => {
    const result = setPasswordRequestSchema.safeParse({ password: 'hunter2' });
    expect(result.success).toBe(false);
  });

  it('rejects a payload with an unknown top-level key', () => {
    const result = setPasswordRequestSchema.safeParse({
      target: { kind: 'proxy', proxyId },
      password: 'hunter2',
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a completely malformed payload', () => {
    expect(setPasswordRequestSchema.safeParse('not an object').success).toBe(false);
    expect(setPasswordRequestSchema.safeParse(null).success).toBe(false);
    expect(setPasswordRequestSchema.safeParse(undefined).success).toBe(false);
    expect(setPasswordRequestSchema.safeParse(42).success).toBe(false);
  });
});

describe('clearPasswordRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(() =>
      clearPasswordRequestSchema.parse({ target: { kind: 'proxy', proxyId } }),
    ).not.toThrow();
  });

  it('rejects a payload missing target', () => {
    expect(clearPasswordRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('getSettingsSnapshotResultSchema', () => {
  it('accepts a success result carrying a valid snapshot', () => {
    const result = getSettingsSnapshotResultSchema.safeParse({
      ok: true,
      snapshot: {
        hosts: [],
        proxies: [],
        agents: { [DEFAULT_AGENT_ID]: { active: true } },
        browser: { disableNativeWebAuthn: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an error result', () => {
    const result = getSettingsSnapshotResultSchema.safeParse({
      ok: false,
      error: { code: 'storage_error', message: 'settings file is corrupt' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a success result that also carries an error field', () => {
    const result = getSettingsSnapshotResultSchema.safeParse({
      ok: true,
      snapshot: {
        hosts: [],
        proxies: [],
        agents: { [DEFAULT_AGENT_ID]: { active: true } },
        browser: { disableNativeWebAuthn: true },
      },
      error: { code: 'storage_error', message: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown error code', () => {
    const result = getSettingsSnapshotResultSchema.safeParse({
      ok: false,
      error: { code: 'totally_made_up', message: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('parseGetSettingsSnapshotResult throws on a malformed candidate', () => {
    expect(() => parseGetSettingsSnapshotResult({ ok: 'yes' })).toThrow();
  });
});

describe('settingsIpcVoidResultSchema', () => {
  it('accepts { ok: true } with no other fields', () => {
    expect(settingsIpcVoidResultSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it('rejects { ok: true } carrying an unexpected password-shaped field', () => {
    const result = settingsIpcVoidResultSchema.safeParse({ ok: true, password: 'hunter2' });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed error result', () => {
    const result = settingsIpcVoidResultSchema.safeParse({
      ok: false,
      error: { code: 'secret_storage_unavailable', message: 'x' },
    });
    expect(result.success).toBe(true);
  });

  it('parseSettingsIpcVoidResult throws on a malformed candidate', () => {
    expect(() => parseSettingsIpcVoidResult({ ok: false })).toThrow();
  });
});

describe('addServerRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const result = addServerRequestSchema.safeParse({
      label: 'Staging',
      origin: 'https://staging.example',
      color: { kind: 'swatch', swatch: 'blue' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a plain-HTTP origin with no confirmation field', () => {
    const result = addServerRequestSchema.safeParse({
      label: 'Insecure',
      origin: 'http://insecure.example',
      color: { kind: 'swatch', swatch: 'blue' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a payload still carrying the removed allowInsecureHttp field', () => {
    const result = addServerRequestSchema.safeParse({
      label: 'Staging',
      origin: 'https://staging.example',
      color: { kind: 'swatch', swatch: 'blue' },
      allowInsecureHttp: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid address', () => {
    const result = addServerRequestSchema.safeParse({
      label: 'Staging',
      origin: 'not a url',
      color: { kind: 'swatch', swatch: 'blue' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty label', () => {
    const result = addServerRequestSchema.safeParse({
      label: '',
      origin: 'https://staging.example',
      color: { kind: 'swatch', swatch: 'blue' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload carrying an extra top-level key', () => {
    const result = addServerRequestSchema.safeParse({
      label: 'Staging',
      origin: 'https://staging.example',
      color: { kind: 'swatch', swatch: 'blue' },
      proxy: { url: 'https://proxy.example' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a completely malformed payload', () => {
    expect(addServerRequestSchema.safeParse('not an object').success).toBe(false);
    expect(addServerRequestSchema.safeParse(null).success).toBe(false);
    expect(addServerRequestSchema.safeParse(undefined).success).toBe(false);
    expect(addServerRequestSchema.safeParse(42).success).toBe(false);
  });
});

describe('removeServerRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const result = removeServerRequestSchema.safeParse({
      serverId: newServerId(() => 'server-a'),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a payload missing serverId', () => {
    expect(removeServerRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a completely malformed payload', () => {
    expect(removeServerRequestSchema.safeParse('not an object').success).toBe(false);
    expect(removeServerRequestSchema.safeParse(null).success).toBe(false);
  });
});

describe('updateServerPresentationRequestSchema', () => {
  const serverId = newServerId(() => 'server-a');

  it('accepts a label-only change', () => {
    const result = updateServerPresentationRequestSchema.safeParse({
      serverId,
      changes: { label: 'Renamed' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty changes object (no-op update)', () => {
    const result = updateServerPresentationRequestSchema.safeParse({ serverId, changes: {} });
    expect(result.success).toBe(true);
  });

  it('rejects a changes object carrying an origin field - that belongs to update-server-targeting', () => {
    const result = updateServerPresentationRequestSchema.safeParse({
      serverId,
      changes: { origin: 'https://a.example' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string serverId', () => {
    const result = updateServerPresentationRequestSchema.safeParse({
      serverId: 42,
      changes: { label: 'Renamed' },
    });
    expect(result.success).toBe(false);
  });
});

describe('updateServerTargetingRequestSchema', () => {
  const serverId = newServerId(() => 'server-a');

  it('accepts an origin change with originChangeConfirmed', () => {
    const result = updateServerTargetingRequestSchema.safeParse({
      serverId,
      changes: { origin: 'https://b.example' },
      originChangeConfirmed: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an origin change with originChangeConfirmed omitted (main side treats it as not confirmed)', () => {
    const result = updateServerTargetingRequestSchema.safeParse({
      serverId,
      changes: { origin: 'https://b.example' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts clearing the TLS exception with null', () => {
    const result = updateServerTargetingRequestSchema.safeParse({
      serverId,
      changes: { tlsException: null },
    });
    expect(result.success).toBe(true);
  });

  it('accepts setting and clearing a proxy-library reference', () => {
    const set = updateServerTargetingRequestSchema.safeParse({
      serverId,
      changes: { proxyId: newProxyId(() => 'proxy-1') },
    });
    expect(set.success).toBe(true);

    const cleared = updateServerTargetingRequestSchema.safeParse({
      serverId,
      changes: { proxyId: null },
    });
    expect(cleared.success).toBe(true);
  });

  it('rejects an invalid origin', () => {
    const result = updateServerTargetingRequestSchema.safeParse({
      serverId,
      changes: { origin: 'not a url' },
    });
    expect(result.success).toBe(false);
  });
});

describe('reorderServersRequestSchema', () => {
  const serverIdA = newServerId(() => 'server-a');
  const serverIdB = newServerId(() => 'server-b');

  it('accepts a full permutation of server ids', () => {
    const result = reorderServersRequestSchema.safeParse({ serverIds: [serverIdB, serverIdA] });
    expect(result.success).toBe(true);
  });

  it('accepts an empty order', () => {
    expect(reorderServersRequestSchema.safeParse({ serverIds: [] }).success).toBe(true);
  });

  it('rejects an unknown key', () => {
    expect(
      reorderServersRequestSchema.safeParse({ serverIds: [serverIdA], extra: true }).success,
    ).toBe(false);
  });

  it('rejects a non-array of ids', () => {
    expect(reorderServersRequestSchema.safeParse({ serverIds: 'server-a' }).success).toBe(false);
    expect(reorderServersRequestSchema.safeParse({ serverIds: [42] }).success).toBe(false);
  });
});

describe('addProxyRequestSchema', () => {
  it('accepts a label, url and username', () => {
    const result = addProxyRequestSchema.safeParse({
      label: 'Corporate',
      url: 'https://proxy.example:8080',
      username: 'alice',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a url with no username', () => {
    const result = addProxyRequestSchema.safeParse({
      label: 'Corporate',
      url: 'https://proxy.example:8080',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid address', () => {
    const result = addProxyRequestSchema.safeParse({
      label: 'Corporate',
      url: 'not a url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty label', () => {
    const result = addProxyRequestSchema.safeParse({
      label: '',
      url: 'https://proxy.example:8080',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty username', () => {
    const result = addProxyRequestSchema.safeParse({
      label: 'Corporate',
      url: 'https://proxy.example:8080',
      username: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a completely malformed payload', () => {
    expect(addProxyRequestSchema.safeParse('not an object').success).toBe(false);
    expect(addProxyRequestSchema.safeParse(null).success).toBe(false);
    expect(addProxyRequestSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('parseAddProxyResult', () => {
  it('accepts a success result carrying a valid proxy snapshot', () => {
    const result = parseAddProxyResult({
      ok: true,
      proxy: {
        id: proxyId,
        label: 'Corporate',
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', hasPassword: false },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('throws on a malformed candidate', () => {
    expect(() => parseAddProxyResult({ ok: true })).toThrow();
  });
});

describe('updateProxyRequestSchema', () => {
  it('accepts a well-formed full replace', () => {
    const result = updateProxyRequestSchema.safeParse({
      proxyId,
      label: 'Corporate',
      url: 'https://proxy.example:8080',
      username: 'alice',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an omitted username (drops any existing credentials)', () => {
    const result = updateProxyRequestSchema.safeParse({
      proxyId,
      label: 'Corporate',
      url: 'https://proxy.example:8080',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a payload missing proxyId', () => {
    expect(
      updateProxyRequestSchema.safeParse({
        label: 'Corporate',
        url: 'https://proxy.example:8080',
      }).success,
    ).toBe(false);
  });
});

describe('removeProxyRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(removeProxyRequestSchema.safeParse({ proxyId }).success).toBe(true);
  });

  it('rejects a payload missing proxyId', () => {
    expect(removeProxyRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('reorderProxiesRequestSchema', () => {
  const proxyIdB = newProxyId(() => 'proxy-b');

  it('accepts a full permutation of proxy ids', () => {
    expect(reorderProxiesRequestSchema.safeParse({ proxyIds: [proxyIdB, proxyId] }).success).toBe(
      true,
    );
  });

  it('rejects an unknown key', () => {
    expect(
      reorderProxiesRequestSchema.safeParse({ proxyIds: [proxyId], extra: true }).success,
    ).toBe(false);
  });

  it('rejects a non-array of ids', () => {
    expect(reorderProxiesRequestSchema.safeParse({ proxyIds: 'proxy-a' }).success).toBe(false);
    expect(reorderProxiesRequestSchema.safeParse({ proxyIds: [42] }).success).toBe(false);
  });
});
