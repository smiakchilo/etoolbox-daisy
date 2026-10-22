import { describe, expect, it } from 'vitest';
import {
  type BrokerOutcome,
  classifyAuthIncident,
  looksLikeLoginUrl,
} from '../../../../../src/shared';

function response(status: number, contentType: string | null, bodyText: string): BrokerOutcome {
  return { kind: 'response', status, contentType, bodyText };
}

const html = (bodyText: string) => response(200, 'text/html; charset=utf-8', bodyText);

describe('classifyAuthIncident', () => {
  it('treats a 401 as certain whatever it carries', () => {
    expect(classifyAuthIncident(response(401, null, ''))).toBe('certain');
    expect(classifyAuthIncident(response(401, 'application/json', '{}'))).toBe('certain');
  });

  it('treats a blocked redirect as certain, and any other block as no evidence', () => {
    expect(classifyAuthIncident({ kind: 'blocked', reason: 'redirect_blocked' })).toBe('certain');
    expect(classifyAuthIncident({ kind: 'blocked', reason: 'cross_origin' })).toBeUndefined();
    expect(classifyAuthIncident({ kind: 'blocked', reason: 'invalid_url' })).toBeUndefined();
  });

  it('treats a real redirect status as certain but not 300 or 304', () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(classifyAuthIncident(response(status, null, ''))).toBe('certain');
    }
    expect(classifyAuthIncident(response(300, 'application/json', '[]'))).toBeUndefined();
    expect(classifyAuthIncident(response(304, null, ''))).toBeUndefined();
  });

  it('recognises the AEM sign-in form exactly, case-insensitively', () => {
    expect(classifyAuthIncident(html('<form action="/j_security_check">'))).toBe('certain');
    expect(classifyAuthIncident(html('<input name="j_username">'))).toBe('certain');
    expect(classifyAuthIncident(html('<title>AEM Sign In</title>'))).toBe('certain');
  });

  it('suspects other login gates from weak hints', () => {
    const gates = [
      '<input type="password" name="p">',
      '<h1>Sign in to continue</h1>',
      '<a>Log in</a>',
      '<p>Redirecting to SSO</p>',
      '<input name="SAMLRequest">',
      '<div>Okta</div>',
    ];
    for (const gate of gates) expect(classifyAuthIncident(html(gate))).toBe('suspected');
  });

  it('ignores ordinary HTML, empty bodies and non-HTML or non-200 responses', () => {
    // noinspection HtmlRequiredLangAttribute
    expect(classifyAuthIncident(html('<html><body>Hello</body></html>'))).toBeUndefined();
    expect(classifyAuthIncident(html('  \n '))).toBeUndefined();
    expect(
      classifyAuthIncident(response(200, 'application/json', '{"sign in":1}')),
    ).toBeUndefined();
    expect(classifyAuthIncident(response(200, null, 'sign in'))).toBeUndefined();
    expect(classifyAuthIncident(response(500, 'text/html', 'sign in'))).toBeUndefined();
    expect(classifyAuthIncident(response(404, 'text/html', 'login'))).toBeUndefined();
  });

  it('is no evidence for outcomes that are not responses', () => {
    const outcomes: BrokerOutcome[] = [
      { kind: 'timeout' },
      { kind: 'cancelled' },
      { kind: 'no_view' },
      { kind: 'bridge_unavailable' },
      { kind: 'stale', status: 'stale_navigation_epoch' },
    ];
    for (const outcome of outcomes) expect(classifyAuthIncident(outcome)).toBeUndefined();
  });
});

describe('looksLikeLoginUrl', () => {
  it('recognises login paths of different gates', () => {
    const urls = [
      'https://aem.example.com/libs/granite/core/content/login.html?resource=%2Fsites.html',
      'https://acme.okta.com/app/x/sso/saml',
      'https://ims-na1.adobelogin.com/ims/authorize/v1?client_id=a',
      'https://gate.corp.example/signin',
      'https://gate.corp.example/oauth2/authorize',
    ];
    for (const url of urls) expect(looksLikeLoginUrl(url), url).toBe(true);
  });

  it('recognises a return-address query parameter', () => {
    expect(looksLikeLoginUrl('https://h.example/gate?redirect_uri=https%3A%2F%2Fx')).toBe(true);
    expect(looksLikeLoginUrl('https://h.example/gate?RelayState=abc')).toBe(true);
  });

  it('does not take a content page for a login page', () => {
    const urls = [
      'https://aem.example.com/editor.html/content/site/en.html',
      'https://aem.example.com/sites.html/content/site',
      'https://aem.example.com/content/author/page.html',
      'https://aem.example.com/content/dam/ssoftware/logo.png',
    ];
    for (const url of urls) expect(looksLikeLoginUrl(url), url).toBe(false);
  });

  it('is false for an address that is not a URL', () => {
    expect(looksLikeLoginUrl('not a url')).toBe(false);
  });
});
