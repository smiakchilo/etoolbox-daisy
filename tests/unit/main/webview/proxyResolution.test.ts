import { describe, expect, it } from 'vitest';
import { findProxyEntry, resolveEffectiveProxy } from '../../../../src/main/webview';
import {
  appSettingsSchema,
  defaultAppSettings,
  HOST_PROXY_NONE,
  newProxyId,
  newServerId,
  proxyConfigSchema,
  serverConfigSchema,
  type AppSettings,
} from '../../../../src/shared';
import { TEST_AGENT_ID } from '../../../support/agentDefinitions';

const corporate = proxyConfigSchema.parse({
  id: newProxyId(() => 'proxy-corp'),
  label: 'Corporate',
  url: 'https://proxy.example:8080',
});
const fallback = proxyConfigSchema.parse({
  id: newProxyId(() => 'proxy-default'),
  label: 'Default',
  url: 'https://default-proxy.example:3128',
});

function server(id: string, origin: string, proxyId?: string) {
  return serverConfigSchema.parse({
    id: newServerId(() => id),
    label: id,
    origin,
    color: { kind: 'swatch', swatch: 'blue' },
    revision: 0,
    ...(proxyId !== undefined ? { proxyId } : {}),
  });
}

function settings(options: {
  hosts?: ReturnType<typeof server>[];
  browserProxy?: string;
}): AppSettings {
  return appSettingsSchema.parse({
    hosts: options.hosts ?? [],
    proxies: [corporate, fallback],
    agents: { [TEST_AGENT_ID]: { active: true } },
    browser: {
      disableNativeWebAuthn: true,
      ...(options.browserProxy !== undefined ? { proxy: options.browserProxy } : {}),
    },
  });
}

describe('findProxyEntry', () => {
  it('resolves a configured id to its entry', () => {
    expect(findProxyEntry(settings({}), corporate.id)).toEqual(corporate);
  });

  it('returns undefined for absent, "none", and dangling references', () => {
    const doc = settings({});
    expect(findProxyEntry(doc, undefined)).toBeUndefined();
    expect(findProxyEntry(doc, HOST_PROXY_NONE)).toBeUndefined();
    expect(findProxyEntry(doc, 'proxy-ghost')).toBeUndefined();
  });
});

describe('resolveEffectiveProxy', () => {
  it("uses a host's explicit entry, overriding the browser default", () => {
    const doc = settings({
      hosts: [server('server-a', 'https://a.example', corporate.id)],
      browserProxy: fallback.id,
    });

    expect(resolveEffectiveProxy(doc, 'https://a.example')).toEqual(corporate);
  });

  it('honours a host\'s explicit "No proxy" even when a default exists', () => {
    const doc = settings({
      hosts: [server('server-a', 'https://a.example', HOST_PROXY_NONE)],
      browserProxy: fallback.id,
    });

    expect(resolveEffectiveProxy(doc, 'https://a.example')).toBeUndefined();
  });

  it('inherits the browser default for a host with no explicit selection', () => {
    const doc = settings({
      hosts: [server('server-a', 'https://a.example')],
      browserProxy: fallback.id,
    });

    expect(resolveEffectiveProxy(doc, 'https://a.example')).toEqual(fallback);
  });

  it('uses the browser default for an origin that is not a configured host', () => {
    const doc = settings({
      hosts: [server('server-a', 'https://a.example', corporate.id)],
      browserProxy: fallback.id,
    });

    expect(resolveEffectiveProxy(doc, 'https://ims.example')).toEqual(fallback);
  });

  it('returns undefined (direct) when neither the origin nor the default resolves to an entry', () => {
    const doc = settings({ hosts: [server('server-a', 'https://a.example')] });

    expect(resolveEffectiveProxy(doc, 'https://a.example')).toBeUndefined();
    expect(resolveEffectiveProxy(doc, 'https://ims.example')).toBeUndefined();
    expect(resolveEffectiveProxy(defaultAppSettings(), 'https://anything.example')).toBeUndefined();
  });

  it('matches the host origin exactly (scheme/port), not merely the hostname', () => {
    const doc = settings({
      hosts: [server('server-a', 'https://a.example', corporate.id)],
      browserProxy: fallback.id,
    });

    // A different port is a different origin, so it falls to the default.
    expect(resolveEffectiveProxy(doc, 'https://a.example:8443')).toEqual(fallback);
  });
});
