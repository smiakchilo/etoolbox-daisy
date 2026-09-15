import { describe, expect, it } from 'vitest';
import { decideAuxiliaryWindowOpen } from '../../../../src/main/browser/auxiliaryWindowPolicy';

describe('decideAuxiliaryWindowOpen', () => {
  it('allows an https popup (typical SSO/login window)', () => {
    expect(decideAuxiliaryWindowOpen('https://idp.example.com/login')).toEqual({ kind: 'allow' });
  });

  it('allows an http popup', () => {
    expect(decideAuxiliaryWindowOpen('http://internal-idp.example.com/login')).toEqual({
      kind: 'allow',
    });
  });

  it('denies a file: URL', () => {
    expect(decideAuxiliaryWindowOpen('file:///etc/passwd')).toEqual({
      kind: 'deny',
      reason: 'unsupported_scheme',
    });
  });

  it("denies a custom-scheme URL, including the app's own app: scheme", () => {
    expect(decideAuxiliaryWindowOpen('app://daisy/settings.html')).toEqual({
      kind: 'deny',
      reason: 'unsupported_scheme',
    });
  });

  it('denies other non-http(s) schemes (e.g. javascript:, data:, chrome:)', () => {
    expect(decideAuxiliaryWindowOpen('javascript:alert(1)')).toEqual({
      kind: 'deny',
      reason: 'unsupported_scheme',
    });
    expect(decideAuxiliaryWindowOpen('data:text/html,<h1>hi</h1>')).toEqual({
      kind: 'deny',
      reason: 'unsupported_scheme',
    });
  });

  it('denies a malformed URL', () => {
    expect(decideAuxiliaryWindowOpen('not a url')).toEqual({ kind: 'deny', reason: 'malformed' });
  });
});
