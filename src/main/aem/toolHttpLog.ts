import type { AemBridgeHeader } from '../../shared/contracts/aemBridge';
import { LogWriter, type LoggerHealth, type LogOutcome } from '../logger';

/**
 * A dedicated, diagnostics-only log of the HTTP traffic the AEM bridge
 * actually generates: one line for the request main asked the AEM view to
 * issue, one for the response it got back. Written to `<logsDir>/tools.log`
 * as JSON Lines, separate from `logger.ts`'s `app.log`.
 *
 * **Why a second sink, and why it may hold free text.** `logger.ts` is built
 * on the rule that no field can carry free-form content - that is what makes
 * "a prompt/payload/cookie can never reach `app.log`" a structural property
 * rather than a scrubbing promise. Diagnosing an AEM tool call needs exactly
 * the things that rule forbids: the full request URL including its query
 * string (the QueryBuilder predicates *are* the request) and the response's
 * header values (server-controlled text). Rather than weaken `app.log` by
 * adding a free-text field to it, that content goes here, where the
 * guarantee does not apply. `app.log` stays as it was.
 *
 * **What cannot appear here.** The AEM session cookie cannot: the fetch runs
 * in the AEM page with `credentials: "same-origin"`, so Chromium attaches the
 * HttpOnly cookie ambiently, and `Cookie`/`Set-Cookie` are browser-forbidden
 * header names that the fetch implementation never exposes to this code (see
 * `bridgeFetch.ts` and `aemBridge.ts`). `sanitizeHeaders` redacts those names
 * anyway, plus `Authorization`/`Proxy-Authorization`, as defence in depth for
 * a header this code never sets. Values are flattened to a single line so a
 * crafted header cannot forge a log record.
 */

/** Header values are bounded so one response cannot write an unbounded line. */
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_URL_LENGTH = 8192;

/** Written in place of a header value whose name is credential-bearing. */
const REDACTED = '[redacted]';

/**
 * Never logged with a value, even though the browser already refuses to hand
 * any of these to JavaScript. Belt-and-braces: a future change that starts
 * setting one of these headers explicitly must not silently start logging it.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'cookie',
  'set-cookie',
  'set-cookie2',
  'authorization',
  'proxy-authorization',
]);

const DEFAULT_TOOL_LOG_FILE_NAME = 'tools.log';
const DEFAULT_TOOL_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface ToolHttpRequestRecord {
  readonly requestId: string;
  readonly method: string;
  /** The full URL, query string included - that is the point of this log. */
  readonly url: string;
  readonly headers: readonly AemBridgeHeader[];
}

export interface ToolHttpResponseRecord {
  readonly requestId: string;
  /** The HTTP status, or `null` when no response was ever produced (timeout, cancel, block). */
  readonly status: number | null;
  readonly outcome: LogOutcome;
  readonly durationMs: number;
  readonly headers: readonly AemBridgeHeader[];
}

export interface ToolHttpLogger {
  /** Records that a request reached the AEM view. */
  request(record: ToolHttpRequestRecord): void;
  /** Records how that request settled, with the response headers when there were any. */
  response(record: ToolHttpResponseRecord): void;
  getHealth(): LoggerHealth;
}

export interface ToolHttpLoggerOptions {
  readonly fileName?: string;
  readonly maxBytes?: number;
  /** Injectable clock so tests get deterministic `ts` values. */
  readonly now?: () => number;
}

/** Flattens CR/LF to spaces and caps length, so a value can never forge a second log line. */
function toSingleLine(value: string, maxLength: number): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, maxLength);
}

/** Redacts credential-bearing header values and makes every value single-line and bounded. */
function sanitizeHeaders(headers: readonly AemBridgeHeader[]): readonly AemBridgeHeader[] {
  return headers.map((header) => {
    const name = toSingleLine(header.name, MAX_HEADER_NAME_LENGTH);
    const value = SENSITIVE_HEADER_NAMES.has(name.toLowerCase())
      ? REDACTED
      : toSingleLine(header.value, MAX_HEADER_VALUE_LENGTH);
    return { name, value };
  });
}

/**
 * Creates the tool HTTP logger. `logsDir` is a plain injected string (as in
 * `logger.ts`), so this module imports no Electron API and is unit-testable
 * under plain vitest.
 */
export function createToolHttpLogger(
  logsDir: string,
  options: ToolHttpLoggerOptions = {},
): ToolHttpLogger {
  const now = options.now ?? Date.now;
  const writer = new LogWriter(
    logsDir,
    options.fileName ?? DEFAULT_TOOL_LOG_FILE_NAME,
    options.maxBytes ?? DEFAULT_TOOL_LOG_MAX_BYTES,
  );

  function writeRecord(record: Record<string, unknown>): void {
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      writer.reject('SERIALIZE_FAILED');
      return;
    }
    writer.writeLine(line);
  }

  return {
    request(record) {
      writeRecord({
        ts: new Date(now()).toISOString(),
        recordType: 'tool.http.request',
        requestId: record.requestId,
        method: record.method,
        url: toSingleLine(record.url, MAX_URL_LENGTH),
        headers: sanitizeHeaders(record.headers),
      });
    },
    response(record) {
      writeRecord({
        ts: new Date(now()).toISOString(),
        recordType: 'tool.http.response',
        requestId: record.requestId,
        status: record.status,
        outcome: record.outcome,
        durationMs: Math.max(0, record.durationMs),
        headers: sanitizeHeaders(record.headers),
      });
    },
    getHealth: () => writer.getHealth(),
  };
}
