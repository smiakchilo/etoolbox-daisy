import { describe, expect, it } from 'vitest';
import {
  TOOL_ERROR_CODES,
  classifyHttpStatus,
  classifyNetworkFailure,
  createToolError,
  toolErrorSchema,
  type ToolErrorCode,
} from '../../../../src/shared/contracts/errors';
import { newRequestId, type RequestId } from '../../../../src/shared/contracts/ids';

const requestId = newRequestId(() => 'req-1');

describe('createToolError', () => {
  it('produces a schema-valid error carrying the request id it was given', () => {
    const error = createToolError('NOT_FOUND', 'No node at that path.', requestId);
    expect(toolErrorSchema.safeParse(error).success).toBe(true);
    expect(error.requestId).toBe('req-1');
  });

  it('marks transport-class failures retryable and argument errors not', () => {
    expect(createToolError('TIMEOUT', 'Timed out.', requestId).retryable).toBe(true);
    expect(createToolError('NETWORK_ERROR', 'Failed.', requestId).retryable).toBe(true);
    expect(createToolError('INVALID_ARGUMENT', 'Bad path.', requestId).retryable).toBe(false);
    expect(createToolError('NOT_FOUND', 'Missing.', requestId).retryable).toBe(false);
  });

  it('separates required action from retryability, which are different questions', () => {
    // A timeout is worth retrying but needs nothing from the user; an auth
    // failure needs the user and is pointless to retry until they act.
    const timeout = createToolError('TIMEOUT', 'Timed out.', requestId);
    const auth = createToolError('AUTH_REQUIRED', 'Sign in.', requestId);
    expect([timeout.retryable, timeout.requiredAction]).toEqual([true, 'none']);
    expect([auth.retryable, auth.requiredAction]).toEqual([false, 'sign_in_to_aem']);
  });

  it('routes each code to the action that would actually unblock it', () => {
    expect(createToolError('PROXY_ERROR', 'x', requestId).requiredAction).toBe(
      'check_proxy_settings',
    );
    expect(createToolError('TLS_ERROR', 'x', requestId).requiredAction).toBe('review_certificate');
    expect(createToolError('COPILOT_UNAVAILABLE', 'x', requestId).requiredAction).toBe(
      'sign_in_to_copilot',
    );
    expect(createToolError('RESUME_FAILED', 'x', requestId).requiredAction).toBe('start_new_chat');
    expect(createToolError('RESULT_TOO_LARGE_FOR_MODEL', 'x', requestId).requiredAction).toBe(
      'reduce_result_size',
    );
  });

  it('lets a caller with better information override the defaults', () => {
    const error = createToolError('NOT_FOUND', 'Missing.', requestId, {
      retryable: true,
      requiredAction: 'select_server',
    });
    expect([error.retryable, error.requiredAction]).toEqual([true, 'select_server']);
  });

  it.each(TOOL_ERROR_CODES)('assigns %s a defined action, leaving no code unmapped', (code) => {
    const error = createToolError(code, 'message', requestId);
    expect(typeof error.requiredAction).toBe('string');
    expect(error.requiredAction.length).toBeGreaterThan(0);
  });

  it('refuses an empty message, which would render as a blank error in the UI', () => {
    expect(() => createToolError('NOT_FOUND', '', requestId)).toThrow();
  });

  it('refuses an over-long message, capping what remote-derived text can occupy', () => {
    expect(() => createToolError('NOT_FOUND', 'x'.repeat(501), requestId)).toThrow();
    expect(createToolError('NOT_FOUND', 'x'.repeat(500), requestId).message).toHaveLength(500);
  });

  it('refuses an invalid request id rather than emitting an uncorrelatable error', () => {
    expect(() => createToolError('NOT_FOUND', 'm', '' as RequestId)).toThrow();
  });
});

describe('toolErrorSchema', () => {
  it('rejects unknown keys so a raw SDK or AEM payload cannot ride along', () => {
    const result = toolErrorSchema.safeParse({
      code: 'NOT_FOUND',
      message: 'm',
      requestId: 'req-1',
      retryable: false,
      requiredAction: 'none',
      responseBody: '<html>secret</html>',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a code outside the taxonomy', () => {
    const result = toolErrorSchema.safeParse({
      code: 'SOMETHING_ELSE',
      message: 'm',
      requestId: 'req-1',
      retryable: false,
      requiredAction: 'none',
    });
    expect(result.success).toBe(false);
  });
});

describe('classifyNetworkFailure', () => {
  it('returns NETWORK_ERROR with no evidence instead of guessing a cause', () => {
    // The plan's worked example: a bare `TypeError: Failed to fetch` does not
    // prove a proxy fault, and reporting one sends the user to fix settings
    // that were never wrong.
    expect(classifyNetworkFailure()).toBe('NETWORK_ERROR');
    expect(classifyNetworkFailure({})).toBe('NETWORK_ERROR');
  });

  it('narrows only on positively observed evidence', () => {
    expect(classifyNetworkFailure({ proxyAuthenticationRequired: true })).toBe('PROXY_ERROR');
    expect(classifyNetworkFailure({ proxyTunnelFailed: true })).toBe('PROXY_ERROR');
    expect(classifyNetworkFailure({ certificateRejected: true })).toBe('TLS_ERROR');
    expect(classifyNetworkFailure({ deadlineExceeded: true })).toBe('TIMEOUT');
    expect(classifyNetworkFailure({ aborted: true })).toBe('CANCELLED');
  });

  it('treats an explicit false as no evidence, not as counter-evidence', () => {
    expect(classifyNetworkFailure({ certificateRejected: false })).toBe('NETWORK_ERROR');
  });

  it('prefers deliberate cancellation over any transport symptom it caused', () => {
    // Aborting a request tears down the socket, so a cancelled request often
    // also looks like a tunnel failure. Reporting PROXY_ERROR there would
    // blame the network for something the user did.
    expect(classifyNetworkFailure({ aborted: true, proxyTunnelFailed: true })).toBe('CANCELLED');
    expect(classifyNetworkFailure({ aborted: true, certificateRejected: true })).toBe('CANCELLED');
  });

  it('prefers the deadline over a transport symptom, since the deadline caused it', () => {
    expect(classifyNetworkFailure({ deadlineExceeded: true, proxyTunnelFailed: true })).toBe(
      'TIMEOUT',
    );
  });

  it('returns a code that is part of the taxonomy for every evidence combination', () => {
    const flags = [
      'proxyAuthenticationRequired',
      'proxyTunnelFailed',
      'certificateRejected',
      'deadlineExceeded',
      'aborted',
    ] as const;
    const codes = new Set<ToolErrorCode>(TOOL_ERROR_CODES);
    for (let mask = 0; mask < 1 << flags.length; mask++) {
      const evidence = Object.fromEntries(
        flags.map((flag, index) => [flag, (mask & (1 << index)) !== 0]),
      );
      expect(codes.has(classifyNetworkFailure(evidence))).toBe(true);
    }
  });
});

describe('classifyHttpStatus', () => {
  it('separates 401 from 403, which need opposite advice', () => {
    // 401 means AEM does not know who we are: signing in fixes it. 403 means
    // AEM knows and refused: signing in again changes nothing.
    expect(classifyHttpStatus(401)).toBe('AUTH_REQUIRED');
    expect(classifyHttpStatus(403)).toBe('NOT_AUTHORIZED');
  });

  it('maps the statuses with an unambiguous meaning', () => {
    expect(classifyHttpStatus(404)).toBe('NOT_FOUND');
    expect(classifyHttpStatus(407)).toBe('PROXY_ERROR');
    expect(classifyHttpStatus(408)).toBe('TIMEOUT');
    expect(classifyHttpStatus(504)).toBe('TIMEOUT');
  });

  it('falls back to UNEXPECTED_RESPONSE rather than inventing a cause', () => {
    for (const status of [200, 302, 418, 500, 502, 503]) {
      expect(classifyHttpStatus(status)).toBe('UNEXPECTED_RESPONSE');
    }
  });
});
