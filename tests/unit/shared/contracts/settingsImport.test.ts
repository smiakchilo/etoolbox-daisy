import { describe, expect, it } from 'vitest';
import {
  IMPORT_MERGE_KEYS,
  agentIdSchema,
  appSettingsSchema,
  newProjectId,
  newProxyId,
  newServerId,
  parsePortableSettingsDocument,
  toSettingsExportDocument,
  type AppSettings,
} from '../../../../src/shared';

const HOST_ID = newServerId(() => 'host-1');
const PROXY_ID = newProxyId(() => 'proxy-1');
const PROJECT_ID = newProjectId(() => 'project-1');
const COPILOT = agentIdSchema.parse('copilot');

/** A settings document exercising every portable concern: ids, references, secrets, revision. */
function fullSettings(): AppSettings {
  return appSettingsSchema.parse({
    hosts: [
      {
        id: HOST_ID,
        label: 'Acme',
        origin: 'https://acme.com',
        color: { kind: 'swatch', swatch: 'blue' },
        type: 'author',
        proxyId: PROXY_ID,
        projectId: PROJECT_ID,
        tlsException: {
          origin: 'https://acme.com',
          certificateSha256Fingerprint: 'a'.repeat(64),
          errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
        },
        revision: 3,
      },
    ],
    projects: [{ id: PROJECT_ID, label: 'Acme project', contentRoots: '/content/acme' }],
    proxies: [
      {
        id: PROXY_ID,
        label: 'Corp',
        url: 'https://proxy.example',
        credentials: { username: 'alice', secretRef: 'proxy:proxy-1' },
      },
    ],
    agents: {
      copilot: {
        active: true,
        proxy: PROXY_ID,
        model: 'gpt',
        token: { secretRef: 'agent-token:copilot' },
      },
    },
    browser: { disableNativeWebAuthn: false, proxy: PROXY_ID },
    memos: { enabled: true },
    updates: { source: 'master', checkOnStartup: true },
  });
}

describe('IMPORT_MERGE_KEYS', () => {
  it("names the address/name field as each entry kind's merge key", () => {
    expect(IMPORT_MERGE_KEYS).toEqual({ host: 'origin', proxy: 'url', project: 'label' });
  });
});

describe('toSettingsExportDocument', () => {
  it('keeps ids and references, and drops revision, credentials and token', () => {
    const document = toSettingsExportDocument(fullSettings());

    const host = document.hosts?.[0];
    expect(host?.id).toBe(HOST_ID);
    expect(host?.proxyId).toBe(PROXY_ID);
    expect(host?.projectId).toBe(PROJECT_ID);
    expect(host?.type).toBe('author');
    expect(host?.tlsException?.errorClass).toBe('net::ERR_CERT_AUTHORITY_INVALID');
    expect(host).not.toHaveProperty('revision');

    expect(document.proxies?.[0]?.id).toBe(PROXY_ID);
    expect(document.proxies?.[0]).not.toHaveProperty('credentials');

    expect(document.agents?.[COPILOT]).toEqual({
      active: true,
      proxy: PROXY_ID,
      model: 'gpt',
    });
    expect(document.agents?.[COPILOT]).not.toHaveProperty('token');

    expect(document.browser).toEqual({ disableNativeWebAuthn: false, proxy: PROXY_ID });
  });
});

describe('parsePortableSettingsDocument', () => {
  it('accepts a partial document (sections may be absent)', () => {
    const parsed = parsePortableSettingsDocument({
      hosts: [{ id: HOST_ID, origin: 'https://acme.com' }],
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects an unknown top-level key (strict)', () => {
    const parsed = parsePortableSettingsDocument({ hosts: [], surprise: true });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a host carrying the stripped revision field', () => {
    const parsed = parsePortableSettingsDocument({
      hosts: [{ id: HOST_ID, origin: 'https://acme.com', revision: 0 }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a proxy carrying a credentials object', () => {
    const parsed = parsePortableSettingsDocument({
      proxies: [{ id: PROXY_ID, url: 'https://proxy.example', credentials: { username: 'a' } }],
    });
    expect(parsed.ok).toBe(false);
  });
});
