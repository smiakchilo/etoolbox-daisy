import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  type ChatId,
  type MessageId,
  type RequestId,
  type SdkSessionId,
  type ServerId,
  type ToolCallId,
  type ToolErrorCode,
  type TurnId,
  chatIdSchema,
  messageIdSchema,
  parseOrigin,
  requestIdSchema,
  sdkSessionIdSchema,
  serverIdSchema,
  TOOL_ERROR_CODES,
  toolCallIdSchema,
  turnIdSchema,
} from '../shared';

/**
 * Diagnostics-only logger (implementation-plan.md step 04;
 * requirements-decisions.md §5, §8): "Logs contain diagnostic codes, timings,
 * and IDs, not prompts/payloads/cookies/passwords/full OAuth URLs. Separate
 * chat history intentionally stores user data."
 *
 * The design choice this module makes: a logger that accepts an arbitrary
 * string and then scrubs it is a losing game - one interpolated template
 * literal defeats it forever. Instead there is no free-text field at all.
 * Every call site supplies a `code` drawn from a closed, compile-time set
 * (this module's own {@link DiagnosticCode}s, or the app's existing
 * {@link ToolErrorCode}s - reused rather than duplicated), plus optional
 * fields whose *types* cannot carry free-form content: durations, counts,
 * HTTP status codes, an enumerated outcome, the app's branded correlation
 * IDs, and a URL reduced to origin+path. See the bottom of this file for the
 * residual risks this still leaves open; they are real and are not hidden.
 */

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/**
 * The application's own diagnostic event codes. Deliberately small and
 * generic for this step; extend the list as new call sites need a code -
 * that is the intended way to add a new kind of log line, never a free-text
 * message parameter.
 */
export const DIAGNOSTIC_CODES = [
  'PROCESS_STARTED',
  'PROCESS_EXITING',
  'SECOND_INSTANCE_FOCUSED',
  'WINDOW_CREATED',
  'SETTINGS_LOADED',
  'SETTINGS_SAVED',
  'SETTINGS_FILE_CORRUPT',
  'SECRET_STORAGE_UNAVAILABLE',
  'SETTINGS_IPC_SENDER_REJECTED',
  'AEM_REQUEST_STARTED',
  'AEM_REQUEST_COMPLETED',
  'AEM_PRELOAD_MISSING',
  'AEM_PRELOAD_ERROR',
  'AEM_SESSION_COOKIE_PERSIST_FAILED',
  'AEM_DOWNLOAD_BLOCKED',
  'COPILOT_AUTH_STARTED',
  'COPILOT_AUTH_COMPLETED',
  'OAUTH_CALLBACK_RECEIVED',
  'LOGGER_ROTATED',
  'BROWSER_VIEW_CREATED',
  'BROWSER_NAVIGATION',
  'BROWSER_UNKNOWN_ORIGIN',
  'BROWSER_SWITCH_STARTED',
  'BROWSER_SWITCH_COMPLETED',
  'BROWSER_SWITCH_FAILED',
  'BROWSER_SWITCH_SUPERSEDED',
  'BROWSER_RENDER_PROCESS_GONE',
  'BROWSER_VIEW_DESTROYED',
  'BROWSER_AUX_WINDOW_OPENED',
  'BROWSER_AUX_WINDOW_DENIED',
  'BROWSER_CERTIFICATE_BLOCKED',
  'BROWSER_CERTIFICATE_APPROVED',
  'BROWSER_CERTIFICATE_RETRY_FAILED',
  'BROWSER_OPEN_EXTERNAL_FAILED',
  'BROWSER_IPC_SENDER_REJECTED',
  'SETTINGS_WINDOW_CREATED',
  'AGENT_CHAT_IPC_SENDER_REJECTED',
  'AGENT_CHAT_ILLEGAL_TRANSITION',
  'AGENT_CHAT_ABORT_ON_CONTEXT_CHANGE',
  'AGENT_CHAT_ABORT_ON_CONTEXT_CHANGE_FAILED',
  'AGENT_SERVICE_FAKE_SELECTED',
  'TOOL_REGISTRATION_FAILED',
  'AGENT_REGISTRATION_FAILED',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** Every code this logger will accept: its own codes plus the shared error taxonomy. */
const KNOWN_LOG_CODES: ReadonlySet<string> = new Set<string>([
  ...DIAGNOSTIC_CODES,
  ...TOOL_ERROR_CODES,
]);

/**
 * Runtime backstop behind the compile-time `code` type. Ordinary callers can
 * never construct a `DiagnosticCode | ToolErrorCode` from an arbitrary
 * string without an explicit `as` assertion (assigning a bare `string` is a
 * compile error). A caller who *does* force such an assertion still cannot
 * get the value written: this check runs before anything touches disk, so
 * even a deliberately-cast bogus code is rejected rather than logged.
 */
function isKnownLogCode(code: string): code is DiagnosticCode | ToolErrorCode {
  return KNOWN_LOG_CODES.has(code);
}

export const LOG_OUTCOMES = ['success', 'failure', 'timeout', 'cancelled'] as const;
export type LogOutcome = (typeof LOG_OUTCOMES)[number];

export type LogLevel = 'info' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// Safe URL logging
// ---------------------------------------------------------------------------

/**
 * A real, module-local runtime symbol (not `declare const ...: unique
 * symbol`, which erases to nothing at runtime and would make an object
 * literal keyed by it throw). Because it is a genuine value that is never
 * exported, no other module can write a property with this exact key, so a
 * plain `{ origin, path }` object literal assigned directly to a
 * `LoggableUrl`-typed field fails to compile with a real "missing property"
 * error - not merely a style convention.
 */
const loggableUrlBrand: unique symbol = Symbol('loggableUrl');

/**
 * A URL reduced to just its origin and path - the only shape a URL is ever
 * allowed to reach a log line in. `path` can never legitimately contain `?`
 * or `#`: those are exactly the delimiters `URL.pathname` never includes,
 * because they mark the start of the query/fragment it was already split
 * from. `toLoggableUrl` is the only place this type is constructed.
 */
export interface LoggableUrl {
  readonly origin: string;
  readonly path: string;
  readonly [loggableUrlBrand]: true;
}

/**
 * Reduces a URL (which may carry `code=`/`state=`/session query parameters,
 * per the OAuth callback flow) to origin + path, dropping the query string
 * and fragment entirely. Reuses `../shared/contracts/origin`'s `parseOrigin`
 * for the origin component - the same WHATWG `URL` based canonicalization
 * already trusted for server origins - rather than a second, ad hoc URL
 * parser. A malformed URL, or one whose scheme `parseOrigin` does not
 * recognize as http(s), degrades to the literal origin `"invalid"` and an
 * empty path instead of leaking the unparsed input.
 */
export function toLoggableUrl(rawUrl: string): LoggableUrl {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { origin: 'invalid', path: '', [loggableUrlBrand]: true };
  }
  const canonicalOrigin = parseOrigin(parsed.origin);
  const origin = canonicalOrigin.ok ? canonicalOrigin.origin : 'invalid';
  return { origin, path: parsed.pathname, [loggableUrlBrand]: true };
}

// ---------------------------------------------------------------------------
// Structured fields
// ---------------------------------------------------------------------------

/** Correlation identifiers a diagnostic line may carry - already opaque and branded. */
export interface LogIds {
  readonly requestId?: RequestId;
  readonly chatId?: ChatId;
  readonly serverId?: ServerId;
  readonly sdkSessionId?: SdkSessionId;
  readonly turnId?: TurnId;
  readonly messageId?: MessageId;
  readonly toolCallId?: ToolCallId;
}

/**
 * Everything a diagnostic line may carry beyond its code. There is
 * intentionally no free-text field: see the module comment for why.
 */
export interface LogFields {
  readonly durationMs?: number;
  readonly count?: number;
  readonly statusCode?: number;
  readonly outcome?: LogOutcome;
  readonly ids?: LogIds;
  readonly url?: LoggableUrl;
}

/**
 * Runtime validation for {@link LogFields}, independent of and in addition
 * to the compile-time type. This is the defense-in-depth layer for values
 * that type-check but are semantically wrong (`NaN`, negative durations) or
 * that reach here only because a caller forced an `as` assertion past the
 * type checker. Reuses the branded ID schemas from `../shared/contracts/ids`
 * rather than re-validating ID shape here. `.strict()` throughout rejects
 * unknown keys, so a forged object cannot smuggle an extra field in either.
 */
const logIdsSchema = z
  .object({
    requestId: requestIdSchema.optional(),
    chatId: chatIdSchema.optional(),
    serverId: serverIdSchema.optional(),
    sdkSessionId: sdkSessionIdSchema.optional(),
    turnId: turnIdSchema.optional(),
    messageId: messageIdSchema.optional(),
    toolCallId: toolCallIdSchema.optional(),
  })
  .strict();

// A forged LoggableUrl-shaped object (constructed via an `as` assertion
// rather than `toLoggableUrl`) can still carry a raw query string in `path`
// or `origin`. This is not content/secret sniffing - `?` and `#` are URL
// *syntax* delimiters that a genuine `origin`/`pathname` pair can never
// contain - so rejecting them closes the direct forgery case without
// becoming the regex secret-scrubber this design otherwise avoids.
const loggableUrlValidationSchema = z
  .object({
    origin: z.string().refine((value) => !value.includes('?') && !value.includes('#')),
    path: z.string().refine((value) => !value.includes('?') && !value.includes('#')),
  })
  .strict();

const logFieldsValidationSchema = z
  .object({
    durationMs: z.number().nonnegative().optional(),
    count: z.number().nonnegative().int().optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    outcome: z.enum(LOG_OUTCOMES).optional(),
    ids: logIdsSchema.optional(),
    url: loggableUrlValidationSchema.optional(),
  })
  .strict();

type ValidatedLogFields = z.infer<typeof logFieldsValidationSchema>;

/** Builds the JSON record for one line, in a fixed key order, omitting absent fields. */
function buildRecord(
  level: LogLevel,
  code: DiagnosticCode | ToolErrorCode,
  fields: ValidatedLogFields,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ts: new Date().toISOString(), level, code };
  if (fields.durationMs !== undefined) record['durationMs'] = fields.durationMs;
  if (fields.count !== undefined) record['count'] = fields.count;
  if (fields.statusCode !== undefined) record['statusCode'] = fields.statusCode;
  if (fields.outcome !== undefined) record['outcome'] = fields.outcome;
  if (fields.ids !== undefined) {
    const ids: Record<string, string> = {};
    if (fields.ids.requestId !== undefined) ids['requestId'] = fields.ids.requestId;
    if (fields.ids.chatId !== undefined) ids['chatId'] = fields.ids.chatId;
    if (fields.ids.serverId !== undefined) ids['serverId'] = fields.ids.serverId;
    if (fields.ids.sdkSessionId !== undefined) ids['sdkSessionId'] = fields.ids.sdkSessionId;
    if (fields.ids.turnId !== undefined) ids['turnId'] = fields.ids.turnId;
    if (fields.ids.messageId !== undefined) ids['messageId'] = fields.ids.messageId;
    if (fields.ids.toolCallId !== undefined) ids['toolCallId'] = fields.ids.toolCallId;
    record['ids'] = ids;
  }
  if (fields.url !== undefined) {
    record['url'] = { origin: fields.url.origin, path: fields.url.path };
  }
  return record;
}

// ---------------------------------------------------------------------------
// File writer: sync appends, bounded size, never throws to the caller
// ---------------------------------------------------------------------------

/** Extracts a Node `fs` error's `.code` (e.g. `ENOSPC`, `EACCES`) without ever touching `.message`. */
function extractErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = error.code;
    if (typeof value === 'string') return value;
  }
  return 'UNKNOWN';
}

export interface LoggerHealth {
  /** Diagnostic calls that did not make it into the log file, for any reason. */
  readonly writeFailureCount: number;
  /** The `fs` error code, or `"UNKNOWN_CODE"`/`"INVALID_FIELDS"`, of the most recent failure. */
  readonly lastFailureCode: string | null;
  /** How many times the log file has been rotated out to the backup file. */
  readonly rotationCount: number;
}

const DEFAULT_LOG_FILE_NAME = 'app.log';
/** 5 MiB current file + up to 5 MiB backup keeps total on-disk log data bounded. */
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Owns the on-disk file: synchronous appends (so a line is durably written,
 * or its failure is already recorded, before the call returns - nothing
 * sits buffered in process memory waiting to be flushed later, which is
 * what "last words on a crash" requires), simple single-backup rotation
 * bounding total size to roughly `2 * maxBytes` (no generational rotation
 * framework - one backup is enough to satisfy "does not grow without
 * bound"), and a failure path that always degrades instead of throwing.
 *
 * Exported for reuse by purpose-built JSON Lines sinks that need the same
 * durability and bounded-growth behaviour but not this module's closed
 * field vocabulary - currently `aem/toolHttpLog.ts`. Keeping the writer here
 * rather than duplicating it is deliberate: two independent rotation
 * implementations would eventually disagree about the bound.
 */
export class LogWriter {
  private readonly filePath: string;
  private readonly backupPath: string;
  private readonly maxBytes: number;
  private currentSizeBytes: number;
  private writeFailureCount = 0;
  private lastFailureCode: string | null = null;
  private rotationCount = 0;

  constructor(logsDir: string, fileName: string, maxBytes: number) {
    this.filePath = path.join(logsDir, fileName);
    this.backupPath = `${this.filePath}.1`;
    this.maxBytes = maxBytes;
    try {
      mkdirSync(logsDir, { recursive: true });
    } catch (error) {
      this.recordFailure(error);
    }
    this.currentSizeBytes = this.readInitialSize();
  }

  private readInitialSize(): number {
    try {
      return statSync(this.filePath).size;
    } catch (error) {
      // ENOENT (no file yet) is the expected, non-failure case on first run.
      if (extractErrorCode(error) !== 'ENOENT') this.recordFailure(error);
      return 0;
    }
  }

  private recordFailure(error: unknown): void {
    this.writeFailureCount += 1;
    this.lastFailureCode = extractErrorCode(error);
    // A logging failure must be observable, not silent, without becoming a
    // second thing that can itself throw or block: stderr is a best-effort,
    // fire-and-forget sink the Electron main process already surfaces.
    console.error(`[etoolbox-daisy] logger degraded: ${this.lastFailureCode}`);
  }

  /** Records a rejection that happened before any file I/O was attempted (bad code/fields). */
  reject(reasonCode: string): void {
    this.writeFailureCount += 1;
    this.lastFailureCode = reasonCode;
    console.error(`[etoolbox-daisy] logger rejected a call: ${reasonCode}`);
  }

  private rotate(): void {
    try {
      renameSync(this.filePath, this.backupPath);
      this.currentSizeBytes = 0;
      this.rotationCount += 1;
    } catch (error) {
      // Rotation failing (e.g. permissions) must not stop the append below
      // from being attempted; the file will just keep growing this cycle.
      this.recordFailure(error);
    }
  }

  writeLine(line: string): void {
    const payload = line + '\n';
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    if (this.currentSizeBytes > 0 && this.currentSizeBytes + payloadBytes > this.maxBytes) {
      this.rotate();
      if (this.rotationCount > 0 && this.currentSizeBytes === 0) {
        this.writeRotationMarker();
      }
    }
    try {
      appendFileSync(this.filePath, payload, 'utf8');
      this.currentSizeBytes += payloadBytes;
    } catch (error) {
      this.recordFailure(error);
    }
  }

  private writeRotationMarker(): void {
    const marker = JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      code: 'LOGGER_ROTATED',
    });
    try {
      const payload = marker + '\n';
      appendFileSync(this.filePath, payload, 'utf8');
      this.currentSizeBytes += Buffer.byteLength(payload, 'utf8');
    } catch (error) {
      this.recordFailure(error);
    }
  }

  getHealth(): LoggerHealth {
    return {
      writeFailureCount: this.writeFailureCount,
      lastFailureCode: this.lastFailureCode,
      rotationCount: this.rotationCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  readonly fileName?: string;
  readonly maxBytes?: number;
}

export interface Logger {
  info(code: DiagnosticCode | ToolErrorCode, fields?: LogFields): void;
  warn(code: DiagnosticCode | ToolErrorCode, fields?: LogFields): void;
  error(code: DiagnosticCode | ToolErrorCode, fields?: LogFields): void;
  getHealth(): LoggerHealth;
}

/**
 * Creates a logger writing to `<logsDir>/<fileName>`. `logsDir` is a plain
 * injected string, not `appPaths.ts`'s resolved value - this module imports
 * neither `appPaths` nor `electron`, so it stays usable under plain vitest.
 */
export function createLogger(logsDir: string, options: LoggerOptions = {}): Logger {
  const fileName = options.fileName ?? DEFAULT_LOG_FILE_NAME;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const writer = new LogWriter(logsDir, fileName, maxBytes);

  function emit(level: LogLevel, code: DiagnosticCode | ToolErrorCode, fields: LogFields): void {
    if (!isKnownLogCode(code)) {
      writer.reject('UNKNOWN_CODE');
      return;
    }
    const parsed = logFieldsValidationSchema.safeParse(fields);
    if (!parsed.success) {
      writer.reject('INVALID_FIELDS');
      return;
    }
    writer.writeLine(JSON.stringify(buildRecord(level, code, parsed.data)));
  }

  return {
    info: (code, fields = {}) => {
      emit('info', code, fields);
    },
    warn: (code, fields = {}) => {
      emit('warn', code, fields);
    },
    error: (code, fields = {}) => {
      emit('error', code, fields);
    },
    getHealth: () => writer.getHealth(),
  };
}

/*
 * Residual risks a determined caller could still exploit (reported here
 * rather than hidden, per implementation-plan.md step 04):
 *
 * 1. Branded IDs are opaque only by convention. `LogIds` accepts real
 *    `RequestId`/`ChatId`/etc. values, which in normal operation come from
 *    `crypto.randomUUID` (see `../shared/contracts/ids.ts`) and so cannot
 *    equal a human secret. Nothing in *this* module stops a caller who
 *    mints an ID from attacker-chosen text (or forces `"secret" as
 *    RequestId`) from having that text logged verbatim - IDs are the one
 *    field type here that is genuinely runtime-content, not structurally
 *    safe. This is a property of using branded strings for correlation IDs
 *    at all, not something a logging module can close without rejecting
 *    real IDs too.
 * 2. `code` and `outcome`/`ids` shape are structurally impossible to set
 *    from arbitrary text under normal (non-`as`) usage, and are additionally
 *    checked against a runtime allow-list/schema, so even a forced `as`
 *    assertion is rejected before anything is written. This is the
 *    strongest guarantee in this module.
 * 3. `LoggableUrl` blocks direct object-literal construction (a required,
 *    un-exported symbol key), but - like any TypeScript brand - a caller
 *    willing to write `{ origin, path } as LoggableUrl` can still force one
 *    through, because a wider object type is always assignable to a
 *    narrower branded one for the purposes of a single `as` assertion. The
 *    `?`/`#` structural check on `origin`/`path` catches the direct case of
 *    stuffing a raw query string into a forged value, but not a caller who
 *    percent-encodes or otherwise disguises it - closing that fully would
 *    require content inspection, which is exactly the losing regex-scrubber
 *    approach this design set out to avoid.
 * 4. There is no `logError(err: unknown)` convenience that accepts a caught
 *    exception. That is deliberate: an `Error`'s `.message`/`.stack` is
 *    free text that can contain a URL, a header value, or reflected
 *    content. Callers must translate a caught error into a `code` (reusing
 *    `classifyNetworkFailure`/`classifyHttpStatus` from
 *    `../shared/contracts/errors.ts` where applicable) themselves; the
 *    absence of that convenience is the safeguard.
 * 5. The stderr fallback in `LogWriter.recordFailure`/`reject` is
 *    unthrottled: a sustained failure (e.g. a full disk) logs one line to
 *    the console per diagnostic call for as long as it persists. That is an
 *    accepted, simple tradeoff - it keeps the failure path itself simple
 *    and side-effect-free - rather than adding rate-limiting machinery to a
 *    module whose job is to be the last thing standing when something else
 *    is already failing.
 */
