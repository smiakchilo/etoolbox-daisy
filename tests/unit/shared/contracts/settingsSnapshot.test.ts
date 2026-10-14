import { describe, expect, it } from 'vitest';
import {
  appSettingsSchema,
  appSettingsSnapshotSchema,
  HOST_PROXY_NONE,
  newProjectId,
  newProxyId,
  newServerId,
  projectConfigSchema,
  proxyConfigSchema,
  serverConfigSchema,
  serverSnapshotSchema,
  toAppSettingsSnapshot,
} from '../../../../src/shared';
import { TEST_AGENT_ID } from '../../../support/agentDefinitions';

const CANARY_SECRET_REF = 'CANARY-SECRETREF-8f14e45fceea167a';

function server(id: string, origin: string, overrides: Record<string, unknown> = {}) {
  return serverConfigSchema.parse({
    id: newServerId(() => id),
    label: `Server ${id}`,
    origin,
    color: { kind: 'swatch' as const, swatch: 'blue' as const },
    revision: 0,
    ...overrides,
  });
}

function settingsWithProxyCredentials(secretRef: string) {
  const proxyEntry = proxyConfigSchema.parse({
    id: newProxyId(() => 'proxy-a'),
    label: 'Corporate',
    url: 'https://proxy.example',
    credentials: { username: 'alice', secretRef },
  });
  const serverA = server('server-a', 'https://a.example', { proxyId: proxyEntry.id });
  return appSettingsSchema.parse({
    hosts: [serverA],
    proxies: [proxyEntry],
    agents: { [TEST_AGENT_ID]: { active: true } },
  });
}

describe('toAppSettingsSnapshot', () => {
  it('never emits the secretRef, even though it is present on the input', () => {
    const settings = settingsWithProxyCredentials(CANARY_SECRET_REF);

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(CANARY_SECRET_REF);
  });

  it('maps proxy credentials to only username and hasPassword', () => {
    const settings = settingsWithProxyCredentials(CANARY_SECRET_REF);

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    const credentials = snapshot.proxies[0]?.credentials;
    expect(credentials).toEqual({ username: 'alice', hasPassword: true });
    // Exactly these two keys - no secretRef, no password, nothing else.
    expect(Object.keys(credentials ?? {}).sort()).toEqual(['hasPassword', 'username']);
  });

  it('reports hasPassword: false when the predicate says there is no stored secret', () => {
    const settings = settingsWithProxyCredentials(CANARY_SECRET_REF);

    const snapshot = toAppSettingsSnapshot(settings, () => false);

    expect(snapshot.proxies[0]?.credentials?.hasPassword).toBe(false);
  });

  it('projects a host proxy-library reference (proxyId) through unchanged', () => {
    const proxyEntry = proxyConfigSchema.parse({
      id: newProxyId(() => 'proxy-1'),
      label: 'Corporate',
      url: 'https://proxy.example:8080',
    });
    const serverA = server('server-a', 'https://a.example', { proxyId: proxyEntry.id });
    const settings = appSettingsSchema.parse({
      hosts: [serverA],
      proxies: [proxyEntry],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    const snapshot = toAppSettingsSnapshot(settings, () => false);

    expect(snapshot.hosts[0]?.proxyId).toBe(proxyEntry.id);
    // The projected host re-parses under the snapshot schema.
    expect(() => serverSnapshotSchema.parse(snapshot.hosts[0])).not.toThrow();
  });

  it('projects a host’s project reference (projectId) through unchanged', () => {
    const project = projectConfigSchema.parse({
      id: newProjectId(() => 'project-1'),
      label: 'HPE',
      contentRoots: '/content/a; /content/b',
      componentRoots: '/apps/a',
      damRoots: '/content/dam/a',
    });
    const serverA = server('server-a', 'https://a.example', { projectId: project.id });
    const settings = appSettingsSchema.parse({
      hosts: [serverA],
      projects: [project],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    const snapshot = toAppSettingsSnapshot(settings, () => false);

    expect(snapshot.hosts[0]?.projectId).toBe(project.id);
    expect(snapshot.projects[0]?.contentRoots).toBe('/content/a; /content/b');
    expect(snapshot.projects[0]?.damRoots).toBe('/content/dam/a');
    expect(() => serverSnapshotSchema.parse(snapshot.hosts[0])).not.toThrow();
  });

  it('omits the projectId key entirely when the host configures no project', () => {
    const serverA = server('server-a', 'https://a.example');
    const settings = appSettingsSchema.parse({
      hosts: [serverA],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    const snapshot = toAppSettingsSnapshot(settings, () => false);

    expect(Object.keys(snapshot.hosts[0] ?? {})).not.toContain('projectId');
    expect(snapshot.projects).toEqual([]);
  });

  it('calls the predicate with the exact secretRef recorded for that proxy', () => {
    const settings = settingsWithProxyCredentials(CANARY_SECRET_REF);
    const seenRefs: string[] = [];

    toAppSettingsSnapshot(settings, (ref) => {
      seenRefs.push(ref);
      return true;
    });

    expect(seenRefs).toEqual([CANARY_SECRET_REF]);
  });

  it('omits proxyId entirely when the host has no explicit proxy selection', () => {
    const serverA = server('server-a', 'https://a.example');
    const settings = appSettingsSchema.parse({
      hosts: [serverA],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    expect(snapshot.hosts[0]?.proxyId).toBeUndefined();
    expect(Object.keys(snapshot.hosts[0] ?? {})).not.toContain('proxy');
  });

  it('maps an agent token to hasToken and never emits its secretRef', () => {
    const settings = appSettingsSchema.parse({
      hosts: [],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true, token: { secretRef: CANARY_SECRET_REF } } },
    });

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    expect(snapshot.agents[TEST_AGENT_ID]?.hasToken).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(CANARY_SECRET_REF);
    // Exactly the non-secret fields plus the resolved flag - no `token` pointer.
    expect(Object.keys(snapshot.agents[TEST_AGENT_ID] ?? {}).sort()).toEqual([
      'active',
      'hasToken',
    ]);
  });

  it('reports hasToken: false when the predicate says no token is stored', () => {
    const settings = appSettingsSchema.parse({
      hosts: [],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true, token: { secretRef: CANARY_SECRET_REF } } },
    });

    const snapshot = toAppSettingsSnapshot(settings, () => false);

    expect(snapshot.agents[TEST_AGENT_ID]?.hasToken).toBe(false);
  });

  it('calls the predicate with the agent token secretRef', () => {
    const settings = appSettingsSchema.parse({
      hosts: [],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true, token: { secretRef: CANARY_SECRET_REF } } },
    });
    const seenRefs: string[] = [];

    toAppSettingsSnapshot(settings, (ref) => {
      seenRefs.push(ref);
      return true;
    });

    expect(seenRefs).toEqual([CANARY_SECRET_REF]);
  });

  it('defaults hasToken to false for an agent with no token', () => {
    const settings = appSettingsSchema.parse({
      hosts: [],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    expect(snapshot.agents[TEST_AGENT_ID]?.hasToken).toBe(false);
  });

  it('maps a proxy-library entry with its id and label, and hashes its password', () => {
    const serverA = server('server-a', 'https://a.example');
    const settings = appSettingsSchema.parse({
      hosts: [serverA],
      proxies: [
        {
          id: newProxyId(() => 'proxy-a'),
          label: 'Corporate',
          url: 'https://copilot-proxy.example',
          credentials: { username: 'bob', secretRef: CANARY_SECRET_REF },
        },
      ],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    expect(snapshot.proxies).toEqual([
      {
        id: 'proxy-a',
        label: 'Corporate',
        url: 'https://copilot-proxy.example',
        credentials: { username: 'bob', hasPassword: true },
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(CANARY_SECRET_REF);
  });

  it('preserves tlsException, which is not a secret', () => {
    const serverA = server('server-a', 'https://a.example', {
      tlsException: {
        origin: 'https://a.example',
        certificateSha256Fingerprint: 'a'.repeat(64),
        errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
      },
    });
    const settings = appSettingsSchema.parse({
      hosts: [serverA],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    const snapshot = toAppSettingsSnapshot(settings, () => false);

    expect(snapshot.hosts[0]?.tlsException).toEqual({
      origin: 'https://a.example',
      certificateSha256Fingerprint: 'a'.repeat(64),
      errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
    });
  });

  it('produces a value that re-validates against appSettingsSnapshotSchema', () => {
    const settings = settingsWithProxyCredentials(CANARY_SECRET_REF);

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    expect(() => appSettingsSnapshotSchema.parse(snapshot)).not.toThrow();
  });
});

describe('serverSnapshotSchema / appSettingsSnapshotSchema (.strict())', () => {
  const validServerSnapshot = {
    id: newServerId(() => 'server-a'),
    label: 'Production',
    origin: 'https://a.example',
    color: { kind: 'swatch' as const, swatch: 'blue' as const },
    revision: 0,
  };

  it('rejects a server snapshot carrying the removed inline `proxy` key', () => {
    expect(() =>
      serverSnapshotSchema.parse({
        ...validServerSnapshot,
        proxy: {
          url: 'https://proxy.example',
          credentials: { username: 'alice', hasPassword: true },
        },
      }),
    ).toThrow();
  });

  it('accepts the "No proxy" sentinel as a server snapshot proxyId', () => {
    expect(
      serverSnapshotSchema.parse({ ...validServerSnapshot, proxyId: HOST_PROXY_NONE }).proxyId,
    ).toBe(HOST_PROXY_NONE);
  });

  it('rejects an app settings snapshot with an unknown top-level key', () => {
    expect(() =>
      appSettingsSnapshotSchema.parse({
        hosts: [],
        proxies: [],
        agents: { [TEST_AGENT_ID]: { active: true } },
        secretsDir: '/should/not/be/here',
      }),
    ).toThrow();
  });

  it('rejects an agent snapshot carrying a token secretRef', () => {
    expect(() =>
      appSettingsSnapshotSchema.parse({
        hosts: [],
        proxies: [],
        agents: {
          [TEST_AGENT_ID]: { active: true, hasToken: true, token: { secretRef: 'x' } },
        },
        browser: { disableNativeWebAuthn: true },
      }),
    ).toThrow();
  });
});
