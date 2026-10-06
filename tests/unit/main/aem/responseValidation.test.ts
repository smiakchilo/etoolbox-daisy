import { describe, expect, it } from 'vitest';
import { classifyAemResponse } from '../../../../src/shared';

const VALID_OBJECT_BODY = JSON.stringify({ 'jcr:primaryType': 'cq:Page', 'jcr:title': 'Home' });

describe('classifyAemResponse - 200 + JSON object (the actual success case)', () => {
  it('accepts a plain JSON object with application/json', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'application/json',
      bodyText: VALID_OBJECT_BODY,
    });
    expect(result).toEqual({
      kind: 'ok',
      value: { 'jcr:primaryType': 'cq:Page', 'jcr:title': 'Home' },
    });
  });

  it('ignores Content-Type parameters such as charset', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'application/json; charset=UTF-8',
      bodyText: VALID_OBJECT_BODY,
    });
    expect(result.kind).toBe('ok');
  });

  it('accepts a case-varied media type', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'Application/JSON;Charset=utf-8',
      bodyText: VALID_OBJECT_BODY,
    });
    expect(result.kind).toBe('ok');
  });

  it('accepts a +json structured syntax suffix (RFC 6839)', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'application/problem+json',
      bodyText: VALID_OBJECT_BODY,
    });
    expect(result.kind).toBe('ok');
  });
});

describe('classifyAemResponse - 200 but the wrong JSON shape (the Sling 300 trap, generalised)', () => {
  it("rejects a JSON array - the exact shape of Sling's 300 alternatives body - even at 200", () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'application/json',
      bodyText: JSON.stringify(['/content/site.tidy.1.json', '/content/site.tidy.0.json']),
    });
    expect(result).toEqual({ kind: 'unexpected_json_shape', actualType: 'array' });
  });

  it('rejects a bare JSON null', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'application/json',
      bodyText: 'null',
    });
    expect(result).toEqual({ kind: 'unexpected_json_shape', actualType: 'null' });
  });

  it('rejects a bare JSON number', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'application/json',
      bodyText: '42',
    });
    expect(result).toEqual({ kind: 'unexpected_json_shape', actualType: 'number' });
  });

  it('rejects a bare JSON string', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'application/json',
      bodyText: '"just a string"',
    });
    expect(result).toEqual({ kind: 'unexpected_json_shape', actualType: 'string' });
  });

  it('rejects a bare JSON boolean', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'application/json',
      bodyText: 'true',
    });
    expect(result).toEqual({ kind: 'unexpected_json_shape', actualType: 'boolean' });
  });
});

describe('classifyAemResponse - 200 but not JSON at all', () => {
  it('classifies an HTML sign-in form as html_login_page', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'text/html; charset=UTF-8',
      bodyText:
        '<html lang="en"><head><title>AEM Sign In</title></head>' +
        '<body><form action="/j_security_check"><input name="j_username"></form></body></html>',
    });
    expect(result).toEqual({ kind: 'html_login_page' });
  });

  it('classifies HTML without sign-in markers as html_error_page, not a signed-out session', () => {
    // The exact regression this pair exists for: AEM answers an aborted query
    // (and a 404, and a gateway interstitial) with 200 + text/html too, so the
    // mere presence of HTML is not evidence that the session ended.
    const result = classifyAemResponse({
      status: 200,
      contentType: 'text/html; charset=UTF-8',
      bodyText: '<html lang="en"><body><h1>Error</h1>Something went wrong</body></html>',
    });
    expect(result).toEqual({ kind: 'html_error_page' });
  });

  it('classifies an empty 200 body as empty_response, whatever the content type claims', () => {
    for (const contentType of ['text/html;charset=utf-8', 'application/json', null]) {
      expect(classifyAemResponse({ status: 200, contentType, bodyText: '' })).toEqual({
        kind: 'empty_response',
      });
      // Oak's aborted-traversal reply is a single newline, not a zero-length body.
      expect(classifyAemResponse({ status: 200, contentType, bodyText: '\n' })).toEqual({
        kind: 'empty_response',
      });
    }
  });

  it('classifies invalid JSON text as invalid_json, with a message, rather than throwing', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'application/json',
      bodyText: '{not valid json',
    });
    expect(result.kind).toBe('invalid_json');
    if (result.kind === 'invalid_json') {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('classifies a missing Content-Type as not_json_content_type with contentType: null', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: null,
      bodyText: VALID_OBJECT_BODY,
    });
    expect(result).toEqual({ kind: 'not_json_content_type', contentType: null });
  });

  it('classifies an unrelated content type (e.g. text/plain) as not_json_content_type, carrying the raw header', () => {
    const result = classifyAemResponse({
      status: 200,
      contentType: 'text/plain',
      bodyText: 'internal server misconfiguration',
    });
    expect(result).toEqual({ kind: 'not_json_content_type', contentType: 'text/plain' });
  });
});

describe('classifyAemResponse - status codes are classified before any body inspection', () => {
  it('401 is unauthorized', () => {
    expect(classifyAemResponse({ status: 401, contentType: null, bodyText: '' })).toEqual({
      kind: 'unauthorized',
    });
  });

  it('403 is forbidden, and is explicitly NOT unauthorized/sign-in', () => {
    const result = classifyAemResponse({ status: 403, contentType: null, bodyText: '' });
    expect(result).toEqual({ kind: 'forbidden' });
    expect(result.kind).not.toBe('unauthorized');
  });

  it('404 is not_found', () => {
    expect(classifyAemResponse({ status: 404, contentType: null, bodyText: '' })).toEqual({
      kind: 'not_found',
    });
  });

  it('400 is bad_request', () => {
    expect(classifyAemResponse({ status: 400, contentType: null, bodyText: '' })).toEqual({
      kind: 'bad_request',
    });
  });

  it('300 is multiple_choices, even though its body is a valid JSON array with a JSON content type', () => {
    const slingAlternativesBody = JSON.stringify([
      '/content/site.tidy.1.json',
      '/content/site.tidy.0.json',
    ]);
    const result = classifyAemResponse({
      status: 300,
      contentType: 'application/json',
      bodyText: slingAlternativesBody,
    });
    expect(result).toEqual({ kind: 'multiple_choices' });
  });

  it('302 with a Location pointing at a different origin (an IdP) is redirected, carrying the location', () => {
    const result = classifyAemResponse({
      status: 302,
      contentType: null,
      bodyText: '',
      location: 'https://idp.example/login?returnTo=%2Fcontent%2Fsite',
    });
    expect(result).toEqual({
      kind: 'redirected',
      location: 'https://idp.example/login?returnTo=%2Fcontent%2Fsite',
    });
  });

  it('a redirect status with no Location header omits the field entirely (exactOptionalPropertyTypes)', () => {
    const result = classifyAemResponse({ status: 307, contentType: null, bodyText: '' });
    expect(result).toEqual({ kind: 'redirected' });
    if (result.kind === 'redirected') {
      expect(Object.prototype.hasOwnProperty.call(result, 'location')).toBe(false);
    }
  });

  it('500 is server_error, carrying the status', () => {
    expect(classifyAemResponse({ status: 500, contentType: null, bodyText: '' })).toEqual({
      kind: 'server_error',
      status: 500,
    });
  });

  it('503 is also server_error, carrying its own status', () => {
    expect(classifyAemResponse({ status: 503, contentType: null, bodyText: '' })).toEqual({
      kind: 'server_error',
      status: 503,
    });
  });

  it('an unmapped status (e.g. 201) is unexpected_status, carrying the status', () => {
    expect(classifyAemResponse({ status: 201, contentType: null, bodyText: '' })).toEqual({
      kind: 'unexpected_status',
      status: 201,
    });
  });
});
