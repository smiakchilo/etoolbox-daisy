import { describe, expect, it } from 'vitest';
import { decideAddressNavigation } from '../../../../src/main/browser/unknownOrigin';
import { newServerId } from '../../../../src/shared/contracts/ids';
import {
  serverConfigSchema,
  type ServerConfig,
} from '../../../../src/shared/contracts/serverConfig';

function makeServer(id: string, origin: string): ServerConfig {
  return serverConfigSchema.parse({
    id: newServerId(() => id),
    label: `Server ${id}`,
    origin,
    color: { kind: 'swatch', swatch: 'blue' },
    revision: 0,
  });
}

describe('decideAddressNavigation', () => {
  it("navigates when the typed address matches a configured server's origin exactly", () => {
    const server = makeServer('s1', 'https://author.example');
    const decision = decideAddressNavigation('https://author.example', [server]);
    expect(decision).toEqual({ kind: 'navigate', server, url: 'https://author.example/' });
  });

  it('navigates when the typed address differs only by trailing slash/default port (same canonical origin)', () => {
    const server = makeServer('s1', 'https://author.example');
    const decision = decideAddressNavigation('https://author.example:443/', [server]);
    expect(decision).toEqual({ kind: 'navigate', server, url: 'https://author.example/' });
  });

  it('keeps the full path of a deep link, so a pasted AEM page URL lands on that page rather than the site root', () => {
    const server = makeServer('s1', 'https://author.example');
    const decision = decideAddressNavigation(
      'https://author.example/editor.html/content/site/en.html',
      [server],
    );
    expect(decision).toEqual({
      kind: 'navigate',
      server,
      url: 'https://author.example/editor.html/content/site/en.html',
    });
  });

  it('keeps query and fragment, which AEM uses to address a specific editor state', () => {
    const server = makeServer('s1', 'https://author.example');
    const decision = decideAddressNavigation(
      'https://author.example/sites.html?wcmmode=disabled#a',
      [server],
    );
    expect(decision).toEqual({
      kind: 'navigate',
      server,
      url: 'https://author.example/sites.html?wcmmode=disabled#a',
    });
  });

  it('still prompts for an unknown origin when the address carries a path - a path cannot authorize a server', () => {
    const server = makeServer('s1', 'https://author.example');
    const decision = decideAddressNavigation('https://unknown.example/content/site.html', [server]);
    expect(decision).toEqual({ kind: 'unknown_origin', origin: 'https://unknown.example' });
  });

  it('prompts to add a server for an origin that is not configured, never silently navigating', () => {
    const server = makeServer('s1', 'https://author.example');
    const decision = decideAddressNavigation('https://unknown.example', [server]);
    expect(decision).toEqual({ kind: 'unknown_origin', origin: 'https://unknown.example' });
  });

  it("prompts to add a server for a plain-HTTP address that is not configured - typing http:// once is not 'explicitly configured'", () => {
    const decision = decideAddressNavigation('http://random-internal-host', []);
    expect(decision).toEqual({ kind: 'unknown_origin', origin: 'http://random-internal-host' });
  });

  it('navigates over plain HTTP when that exact origin is explicitly configured', () => {
    const server = makeServer('s1', 'http://legacy-author.internal');
    const decision = decideAddressNavigation('http://legacy-author.internal', [server]);
    expect(decision).toEqual({ kind: 'navigate', server, url: 'http://legacy-author.internal/' });
  });

  it('reports invalid_address for a value that is not a parseable http(s) address', () => {
    expect(decideAddressNavigation('not a url', []).kind).toBe('invalid_address');
    expect(decideAddressNavigation('ftp://example.com', []).kind).toBe('invalid_address');
    expect(decideAddressNavigation('', []).kind).toBe('invalid_address');
  });

  it('refuses an address carrying userinfo even when the origin is configured, rather than stripping the credential', () => {
    const server = makeServer('s1', 'https://author.example');
    expect(decideAddressNavigation('https://user:pass@author.example/x', [server]).kind).toBe(
      'invalid_address',
    );
  });

  it("does not match a different server's origin even when the host is a substring of a configured one", () => {
    const server = makeServer('s1', 'https://author.example');
    const decision = decideAddressNavigation('https://evil-author.example', [server]);
    expect(decision).toEqual({ kind: 'unknown_origin', origin: 'https://evil-author.example' });
  });

  it('does not let a path segment that looks like a configured host authorize navigation', () => {
    const server = makeServer('s1', 'https://author.example');
    const decision = decideAddressNavigation('https://evil.example/https://author.example', [
      server,
    ]);
    expect(decision).toEqual({ kind: 'unknown_origin', origin: 'https://evil.example' });
  });
});
