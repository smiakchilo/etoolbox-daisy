import { describe, expect, it } from 'vitest';
import { newServerId } from '../../../src/shared';
import {
  addServerRequestSchema,
  clearProxyPasswordRequestSchema,
  getSettingsSnapshotResultSchema,
  parseGetSettingsSnapshotResult,
  parseSettingsIpcVoidResult,
  proxyPasswordTargetSchema,
  removeServerRequestSchema,
  setCopilotProxyRequestSchema,
  setProxyPasswordRequestSchema,
  settingsIpcVoidResultSchema,
  updateServerPresentationRequestSchema,
  updateServerTargetingRequestSchema,
} from '../../../src/shared';

const serverId = newServerId(() => 'server-a');

describe('proxyPasswordTargetSchema', () => {
  it('accepts a server target', () => {
    expect(() => proxyPasswordTargetSchema.parse({ kind: 'server', serverId })).not.toThrow();
  });

  it('accepts the copilotProxy target', () => {
    expect(() => proxyPasswordTargetSchema.parse({ kind: 'copilotProxy' })).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => proxyPasswordTargetSchema.parse({ kind: 'somethingElse' })).toThrow();
  });

  it('rejects a server target missing serverId', () => {
    expect(() => proxyPasswordTargetSchema.parse({ kind: 'server' })).toThrow();
  });

  it('rejects a copilotProxy target carrying an extra key', () => {
    expect(() => proxyPasswordTargetSchema.parse({ kind: 'copilotProxy', serverId })).toThrow();
  });
});

describe('setProxyPasswordRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(() =>
      setProxyPasswordRequestSchema.parse({
        target: { kind: 'server', serverId },
        password: 'hunter2',
      }),
    ).not.toThrow();
  });

  it('rejects an empty password', () => {
    const result = setProxyPasswordRequestSchema.safeParse({
      target: { kind: 'server', serverId },
      password: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a password over the length limit', () => {
    const result = setProxyPasswordRequestSchema.safeParse({
      target: { kind: 'copilotProxy' },
      password: 'x'.repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload missing target', () => {
    const result = setProxyPasswordRequestSchema.safeParse({ password: 'hunter2' });
    expect(result.success).toBe(false);
  });

  it('rejects a payload with an unknown top-level key', () => {
    const result = setProxyPasswordRequestSchema.safeParse({
      target: { kind: 'copilotProxy' },
      password: 'hunter2',
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a completely malformed payload', () => {
    expect(setProxyPasswordRequestSchema.safeParse('not an object').success).toBe(false);
    expect(setProxyPasswordRequestSchema.safeParse(null).success).toBe(false);
    expect(setProxyPasswordRequestSchema.safeParse(undefined).success).toBe(false);
    expect(setProxyPasswordRequestSchema.safeParse(42).success).toBe(false);
  });
});

describe('clearProxyPasswordRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(() =>
      clearProxyPasswordRequestSchema.parse({ target: { kind: 'copilotProxy' } }),
    ).not.toThrow();
  });

  it('rejects a payload missing target', () => {
    expect(clearProxyPasswordRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('getSettingsSnapshotResultSchema', () => {
  it('accepts a success result carrying a valid snapshot', () => {
    const result = getSettingsSnapshotResultSchema.safeParse({
      ok: true,
      snapshot: {
        schemaVersion: 1,
        servers: [],
        activeServerId: null,
        defaultModel: null,
        defaultReasoningEffort: null,
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
        schemaVersion: 1,
        servers: [],
        activeServerId: null,
        defaultModel: null,
        defaultReasoningEffort: null,
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

  it("rejects a payload still carrying the removed allowInsecureHttp field", () => {
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

  it('rejects an invalid origin', () => {
    const result = updateServerTargetingRequestSchema.safeParse({
      serverId,
      changes: { origin: 'not a url' },
    });
    expect(result.success).toBe(false);
  });
});

describe('setCopilotProxyRequestSchema', () => {
  it('accepts a url with a username', () => {
    const result = setCopilotProxyRequestSchema.safeParse({
      url: 'https://proxy.example:8080',
      username: 'alice',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a url with no username - a full replace that drops any existing credentials', () => {
    const result = setCopilotProxyRequestSchema.safeParse({ url: 'https://proxy.example:8080' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid address', () => {
    const result = setCopilotProxyRequestSchema.safeParse({ url: 'not a url' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty username', () => {
    const result = setCopilotProxyRequestSchema.safeParse({
      url: 'https://proxy.example:8080',
      username: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a completely malformed payload', () => {
    expect(setCopilotProxyRequestSchema.safeParse('not an object').success).toBe(false);
    expect(setCopilotProxyRequestSchema.safeParse(null).success).toBe(false);
    expect(setCopilotProxyRequestSchema.safeParse(undefined).success).toBe(false);
  });
});
