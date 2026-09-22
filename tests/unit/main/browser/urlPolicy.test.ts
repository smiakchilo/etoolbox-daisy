import { describe, expect, it } from 'vitest';
import { decideAllowedUrl } from '../../../../src/main/browser/urlPolicy';

describe('decideAllowedUrl', () => {
  it('allows an https URL (typical page or SSO/login redirect)', () => {
    expect(decideAllowedUrl('https://idp.example.com/login')).toEqual({ kind: 'allow' });
  });

  it('allows an http URL', () => {
    expect(decideAllowedUrl('http://internal-idp.example.com/login')).toEqual({
      kind: 'allow',
    });
  });

  it('denies a file: URL', () => {
    expect(decideAllowedUrl('file:///etc/passwd')).toEqual({
      kind: 'deny',
      reason: 'unsupported_scheme',
    });
  });

  it("denies a custom-scheme URL, including the app's own app: scheme", () => {
    expect(decideAllowedUrl('app://daisy/index.html')).toEqual({
      kind: 'deny',
      reason: 'unsupported_scheme',
    });
  });

  it('denies other non-http(s) schemes (e.g. javascript:, data:, chrome:)', () => {
    expect(decideAllowedUrl('javascript:alert(1)')).toEqual({
      kind: 'deny',
      reason: 'unsupported_scheme',
    });
    expect(decideAllowedUrl('data:text/html,<h1>hi</h1>')).toEqual({
      kind: 'deny',
      reason: 'unsupported_scheme',
    });
  });

  it('denies a malformed URL', () => {
    expect(decideAllowedUrl('not a url')).toEqual({ kind: 'deny', reason: 'malformed' });
  });
});
