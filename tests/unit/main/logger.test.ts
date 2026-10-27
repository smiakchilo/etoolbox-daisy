import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { newChatId, newRequestId } from '../../../src/shared';
import {
  createLogger,
  toLoggableUrl,
  type DiagnosticCode,
  type LoggableUrl,
  type Logger,
  type LogReason,
} from '../../../src/main/logger';
import { createScratchDirs } from '../../support/scratchDirs';

/**
 * Scratch directories live under the project's own `test-results/` (already
 * gitignored), never an OS temp directory - matching
 * tests/unit/main/appPaths.test.ts and tests/unit/main/secretStore.test.ts.
 */
const scratch = createScratchDirs('main-unit-scratch', 'logger-');
const createScratchRoot = scratch.create;

afterEach(() => {
  scratch.cleanup();
});

/** The logger names its own files; the current one is the shortest name, a rotated backup longer. */
function logFileName(dir: string, which: 'current' | 'backup'): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).sort((a, b) => a.length - b.length || a.localeCompare(b));
  } catch {
    return undefined;
  }
  return which === 'current' ? names[0] : names[1];
}

function readLogLines(dir: string): string[] {
  const fileName = logFileName(dir, 'current');
  if (fileName === undefined) return [];
  try {
    return readFileSync(path.join(dir, fileName), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function readLogBytes(dir: string, which: 'current' | 'backup' = 'current'): Buffer {
  const fileName = logFileName(dir, which);
  if (fileName === undefined) return Buffer.alloc(0);
  try {
    return readFileSync(path.join(dir, fileName));
  } catch {
    return Buffer.alloc(0);
  }
}

describe('createLogger: normal diagnostic lines', () => {
  it('writes a line containing the expected code, id, and duration', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);
    const requestId = newRequestId(() => '11111111-1111-4111-8111-111111111111');

    logger.info('WEBVIEW_REQUEST_COMPLETED', {
      durationMs: 42,
      statusCode: 200,
      outcome: 'success',
      ids: { requestId },
    });

    const lines = readLogLines(dir);
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] ?? '');
    expect(parsed).toMatchObject({
      level: 'info',
      code: 'WEBVIEW_REQUEST_COMPLETED',
      durationMs: 42,
      statusCode: 200,
      outcome: 'success',
      ids: { requestId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(logger.getHealth()).toEqual({
      writeFailureCount: 0,
      lastFailureCode: null,
      rotationCount: 0,
    });
  });

  it('omits fields the caller did not supply rather than writing them as null/undefined', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);

    logger.warn('SETTINGS_FILE_CORRUPT');

    const lines = readLogLines(dir);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['code', 'level', 'ts']);
  });

  it('reuses the shared ToolErrorCode taxonomy directly as a log code', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);

    logger.error('TIMEOUT', { durationMs: 30_000 });

    const lines = readLogLines(dir);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed['code']).toBe('TIMEOUT');
    expect(parsed['level']).toBe('error');
  });

  it('writes a failure reason and whether a proxy carried the request', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);

    logger.warn('UPDATE_CHECK_FAILED', {
      outcome: 'failure',
      reason: 'network',
      proxied: true,
      durationMs: 10_044,
    });

    const parsed = JSON.parse(readLogLines(dir)[0] ?? '') as Record<string, unknown>;
    expect(parsed).toMatchObject({
      code: 'UPDATE_CHECK_FAILED',
      outcome: 'failure',
      reason: 'network',
      proxied: true,
      durationMs: 10_044,
    });
  });
});

describe('createLogger: line format is stable and parseable', () => {
  it('produces one JSON object per line with a fixed, machine-greppable shape', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);

    logger.info('PROCESS_STARTED');
    logger.info('WINDOW_CREATED', { count: 1 });

    const lines = readLogLines(dir);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed['ts']).toBe('string');
      expect(new Date(parsed['ts'] as string).toString()).not.toBe('Invalid Date');
      expect(typeof parsed['level']).toBe('string');
      expect(typeof parsed['code']).toBe('string');
    }
    // The exact code is grep-able as a plain substring, unambiguously.
    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).toContain('"code":"WINDOW_CREATED"');
  });
});

describe('createLogger: URL logging drops the query string and fragment', () => {
  it('logs only origin and path for a realistic OAuth callback URL', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);
    const oauthUrl =
      'https://github.com/login/oauth/authorize/callback?code=abc123SECRET&state=xyz789SECRET#ignored';

    logger.info('OAUTH_CALLBACK_RECEIVED', { url: toLoggableUrl(oauthUrl) });

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).not.toContain('abc123SECRET');
    expect(raw).not.toContain('xyz789SECRET');
    expect(raw).not.toContain('code=');
    expect(raw).not.toContain('state=');
    expect(raw).not.toContain('#ignored');
    expect(raw).toContain('"origin":"https://github.com"');
    expect(raw).toContain('"path":"/login/oauth/authorize/callback"');
  });

  it('degrades a malformed URL to an explicit invalid marker instead of leaking the raw input', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);

    logger.warn('OAUTH_CALLBACK_RECEIVED', { url: toLoggableUrl('not a url at all') });

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).not.toContain('not a url at all');
    expect(raw.length).toBeGreaterThan(0);
  });
});

describe('createLogger: write failure does not throw and is observable', () => {
  it('does not throw when the logs directory cannot be created, and records the failure', () => {
    const dir = createScratchRoot();
    const blockerFilePath = path.join(dir, 'blocked');
    // Create a plain file where the logger will try to create a directory,
    // so mkdirSync (and every later append) fails deterministically.
    mkdirSync(dir, { recursive: true });
    writeFileSync(blockerFilePath, 'not a directory');

    let logger: Logger | undefined;
    expect(() => {
      logger = createLogger(blockerFilePath);
    }).not.toThrow();
    expect(logger).toBeDefined();

    expect(() => {
      logger?.info('PROCESS_STARTED');
    }).not.toThrow();

    const health = logger?.getHealth();
    expect(health?.writeFailureCount).toBeGreaterThan(0);
    expect(health?.lastFailureCode).not.toBeNull();
  });
});

describe('createLogger: bounded growth', () => {
  it('rotates to a single backup file instead of growing without bound', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir, { maxBytes: 300 });

    for (let i = 0; i < 50; i += 1) {
      logger.info('WINDOW_CREATED', { count: i });
    }

    const health = logger.getHealth();
    expect(health.rotationCount).toBeGreaterThan(0);
    expect(health.writeFailureCount).toBe(0);

    const currentBytes = readLogBytes(dir).length;
    const backupBytes = readLogBytes(dir, 'backup').length;
    expect(backupBytes).toBeGreaterThan(0);
    // Bounded: neither file is allowed to run away, and the total stays
    // within a small, fixed multiple of maxBytes rather than growing with
    // every call ever made.
    expect(currentBytes).toBeLessThan(1000);
    expect(backupBytes).toBeLessThan(1000);
  });
});

describe('createLogger: canaries', () => {
  const PASSWORD_CANARY = 'CANARY-SECRET-d41d8cd98f00b204';
  const TOKEN_CANARY = 'ghp_CANARYTOKENabcdef0123456789ABCDEF';
  const COOKIE_CANARY = 'session=CANARY-COOKIE-VALUE; Path=/; HttpOnly';

  it('structurally impossible: a runtime string cannot be passed as the diagnostic code', () => {
    // This is a compile-time expectation, not a runtime one: `expectTypeOf`
    // makes the surrounding file fail to type-check if a bare `string` were
    // ever assignable to the closed `code` parameter type. There is no
    // field on Logger#info/#warn/#error that accepts free text at all, so
    // there is no runtime call that could carry the canary through
    // `code` under ordinary (non-`as`) usage.
    //
    // Direction matters here. `DiagnosticCode` is a union of string literals,
    // so `DiagnosticCode extends string` is *true* - asserting the negation of
    // that would be asserting something false. The property worth proving is
    // the opposite one: an arbitrary `string` must NOT be assignable to the
    // code parameter, which is what actually stops free text being logged.
    expectTypeOf<string>().not.toExtend<DiagnosticCode>();
    type LoggerInfoCodeParam = Parameters<Logger['info']>[0];
    expectTypeOf<string>().not.toExtend<LoggerInfoCodeParam>();
  });

  it('structurally impossible: canary text does not fit any field type on LogFields', () => {
    // LogFields has no field whose type is a bare string: durationMs/count/
    // statusCode are numbers, outcome/reason are closed enums, proxied is a
    // boolean, ids are branded opaque identifiers, url is the branded
    // LoggableUrl. A password/token/cookie string is not assignable to any of
    // them without `as`.
    type Fields = NonNullable<Parameters<Logger['info']>[1]>;
    expectTypeOf<string>().not.toExtend<NonNullable<Fields['outcome']>>();
    expectTypeOf<string>().not.toExtend<NonNullable<Fields['reason']>>();
    expectTypeOf<string>().not.toExtend<NonNullable<Fields['durationMs']>>();
  });

  it('runtime backstop: a forced-cast bogus code is rejected and never reaches the file', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);
    // A caller determined enough to bypass the type system with a single
    // `as` assertion (not `as unknown as`, which this project bans) can
    // still make this call - the runtime allow-list is what stops it.
    const forgedCode = PASSWORD_CANARY as DiagnosticCode;

    logger.info(forgedCode);

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).not.toContain(PASSWORD_CANARY);
    expect(logger.getHealth().writeFailureCount).toBe(1);
    expect(logger.getHealth().lastFailureCode).toBe('UNKNOWN_CODE');
  });

  it('canary: password-like value never appears in the log file', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);

    logger.info(PASSWORD_CANARY as DiagnosticCode);
    logger.info('PROCESS_STARTED');

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).not.toContain(PASSWORD_CANARY);
  });

  it('canary: token-like value never appears in the log file', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);

    logger.info(TOKEN_CANARY as DiagnosticCode);
    logger.info('PROCESS_STARTED');

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).not.toContain(TOKEN_CANARY);
  });

  it('canary: cookie string never appears in the log file', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);

    logger.info(COOKIE_CANARY as DiagnosticCode);
    logger.info('PROCESS_STARTED');

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).not.toContain(COOKIE_CANARY);
  });

  it("canary: an OAuth URL's code and state values never appear in the log file", () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);
    const oauthUrl = 'https://github.com/callback?code=CANARY-OAUTH-CODE&state=CANARY-OAUTH-STATE';

    logger.info('OAUTH_CALLBACK_RECEIVED', { url: toLoggableUrl(oauthUrl) });

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).not.toContain('CANARY-OAUTH-CODE');
    expect(raw).not.toContain('CANARY-OAUTH-STATE');
  });

  it('known residual risk: an ID minted from secret-shaped text is logged verbatim', () => {
    // Documents, rather than hides, the one field type that is genuinely
    // runtime content: branded IDs are only opaque by convention (real
    // usage mints them from crypto.randomUUID). This is not a canary this
    // module can pass - it demonstrates the boundary of what it protects.
    const dir = createScratchRoot();
    const logger = createLogger(dir);
    const chatId = newChatId(() => PASSWORD_CANARY);

    logger.info('PROCESS_STARTED', { ids: { chatId } });

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).toContain(PASSWORD_CANARY);
  });

  it('forged LoggableUrl-shaped object cannot smuggle a raw query string past the ? / # check', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);
    const forged = {
      origin: 'https://evil.example',
      path: '/callback?code=CANARY-FORGED-CODE',
    } as LoggableUrl;

    logger.info('OAUTH_CALLBACK_RECEIVED', { url: forged });

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).not.toContain('CANARY-FORGED-CODE');
    expect(logger.getHealth().lastFailureCode).toBe('INVALID_FIELDS');
  });

  it('forged reason cannot smuggle free text into a log line', () => {
    const dir = createScratchRoot();
    const logger = createLogger(dir);
    const forgedReason = PASSWORD_CANARY as LogReason;

    logger.warn('UPDATE_CHECK_FAILED', { reason: forgedReason });

    const raw = readLogBytes(dir).toString('utf8');
    expect(raw).not.toContain(PASSWORD_CANARY);
    expect(logger.getHealth().lastFailureCode).toBe('INVALID_FIELDS');
  });
});
