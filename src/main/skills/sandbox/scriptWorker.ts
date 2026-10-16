import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import { parentPort, workerData } from 'node:worker_threads';
import { resolveModuleSpecifier } from './moduleResolution';
import {
  BOOT_MODULE_NAME,
  MAX_FAILURE_MESSAGE_CHARS,
  type WorkerJob,
  type WorkerOutcome,
} from './scriptProtocol';
import type { ScriptFailureKind } from './scriptRunner';

type Failure = Extract<WorkerOutcome, { ok: false }>;
type FailureDetail = Pick<Failure, 'kind' | 'message'>;

interface GuestError {
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

/**
 * Runs as the global script of a fresh context. It captures the builtins it
 * needs before any skill code runs, loads the entry through the confined
 * module loader, and reports every outcome as one tagged JSON string, so a
 * failure's phase (load, throw, bad result) is decided here and not guessed
 * from an error's name.
 */
function bootSource(entry: string, maxOutputChars: number, maxLogChars: number): string {
  // Every value that crosses to the host is sized here, in the guest: the host only ever
  // copies strings that are already within their caps.
  return `(async () => {
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const text = String;
  const hostLog = globalThis.__daisyLog;
  delete globalThis.__daisyLog;
  let logBudget = ${maxLogChars};
  const formatLogValue = (value) => {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return text(value.stack || value.name + ': ' + value.message);
      const json = stringify(value);
      return json === undefined ? text(value) : json;
    } catch (_) {
      return '[unprintable]';
    }
  };
  const logger = (prefix) => (...args) => {
    if (logBudget < 0) return;
    let line = prefix;
    for (let i = 0; i < args.length && line.length <= ${maxLogChars}; i += 1) {
      line += (i === 0 ? '' : ' ') + formatLogValue(args[i]);
    }
    line = line.slice(0, ${maxLogChars} + 1);
    logBudget -= line.length + 1;
    hostLog(line);
  };
  globalThis.console = {
    log: logger(''),
    info: logger(''),
    warn: logger('warn: '),
    error: logger('error: '),
  };
  const describe = (e) => {
    try {
      return {
        name: text(e && e.name).slice(0, 200),
        message: text(e && e.message !== undefined ? e.message : e).slice(0, ${MAX_FAILURE_MESSAGE_CHARS}),
        stack: text((e && e.stack) || '').slice(0, ${MAX_FAILURE_MESSAGE_CHARS}),
      };
    } catch (_) {
      return { name: 'Error', message: 'unprintable error', stack: '' };
    }
  };
  const input = parse(globalThis.__daisyInput);
  delete globalThis.__daisyInput;
  let mod;
  try {
    mod = await import(${JSON.stringify(`./${entry}`)});
  } catch (e) {
    return stringify({ k: 'load', e: describe(e) });
  }
  let value;
  try {
    const fn = mod.default;
    if (typeof fn !== 'function') return stringify({ k: 'nofn' });
    value = await fn(input);
  } catch (e) {
    return stringify({ k: 'throw', e: describe(e) });
  }
  let json;
  try {
    json = stringify(value);
  } catch (e) {
    return stringify({ k: 'invalid', m: describe(e).message });
  }
  if (typeof json !== 'string') {
    return stringify({ k: 'invalid', m: 'the script returned ' + (value === undefined ? 'undefined' : typeof value) });
  }
  if (json.length > ${maxOutputChars}) return stringify({ k: 'big' });
  return stringify({ k: 'ok', s: json });
})()`;
}

function capped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (truncated)`;
}

function describeGuestError(error: GuestError): string {
  const head = `${error.name}: ${error.message}`;
  return capped(error.stack ? `${head}\n${error.stack}` : head, MAX_FAILURE_MESSAGE_CHARS);
}

function readGuestError(ctx: QuickJSContext, handle: QuickJSHandle): GuestError {
  try {
    const dumped: unknown = ctx.dump(handle);
    if (typeof dumped === 'object' && dumped !== null) {
      const record = dumped as Record<string, unknown>;
      return {
        name: typeof record.name === 'string' ? record.name : 'Error',
        message: typeof record.message === 'string' ? record.message : JSON.stringify(dumped),
        stack: typeof record.stack === 'string' ? record.stack : '',
      };
    }
    return { name: 'Error', message: String(dumped), stack: '' };
  } catch {
    return { name: 'Error', message: 'unprintable error', stack: '' };
  }
}

function isOutOfMemory(error: GuestError): boolean {
  return /out of memory/i.test(error.message);
}

class LogBuffer {
  private text = '';
  private bytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  get value(): string {
    return this.text;
  }

  append(line: string): void {
    if (this.truncated) return;
    const chunk = `${line}\n`;
    const chunkBytes = Buffer.byteLength(chunk);
    if (this.bytes + chunkBytes <= this.maxBytes) {
      this.text += chunk;
      this.bytes += chunkBytes;
      return;
    }
    const fitting = Buffer.from(chunk)
      .subarray(0, this.maxBytes - this.bytes)
      .toString('utf8');
    this.text += fitting.endsWith('\uFFFD') ? fitting.slice(0, -1) : fitting;
    this.bytes = this.maxBytes;
    this.truncated = true;
  }
}

/** The one host function the guest console reaches; the guest has already bounded its line. */
function installLogSink(ctx: QuickJSContext, logs: LogBuffer): void {
  const sink = ctx.newFunction('__daisyLog', (line) => {
    if (!logs.truncated) logs.append(ctx.getString(line));
  });
  ctx.setProp(ctx.global, '__daisyLog', sink);
  sink.dispose();
}

async function runJob(job: WorkerJob): Promise<WorkerOutcome> {
  const logs = new LogBuffer(job.maxLogBytes);
  // After an out-of-memory the runtime cannot be freed cleanly; the worker is discarded instead.
  let discardRuntime = false;
  const fail = (detail: FailureDetail): WorkerOutcome => {
    if (detail.kind === 'memory') discardRuntime = true;
    return { ok: false, ...detail, logs: logs.value, logsTruncated: logs.truncated };
  };

  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = quickjs.newRuntime();
  const ctx = runtime.newContext();
  let promise: QuickJSHandle | undefined;
  try {
    runtime.setMemoryLimit(job.memoryBytes);
    runtime.setMaxStackSize(job.stackBytes);

    const deadline = Date.now() + job.deadlineMs;
    let timedOut = false;
    runtime.setInterruptHandler(() => {
      if (Date.now() <= deadline) return false;
      timedOut = true;
      return true;
    });
    const timeout = (): WorkerOutcome =>
      fail({
        kind: 'timeout',
        message: `The script ran past its ${job.deadlineMs} ms deadline and was stopped`,
      });

    let violation: string | undefined;
    const hasModule = (key: string): boolean => Object.hasOwn(job.modules, key);
    const refuse = (message: string): Error => {
      violation ??= message;
      return new Error(message);
    };
    runtime.setModuleLoader(
      (name) => {
        const source = hasModule(name) ? job.modules[name] : undefined;
        return source === undefined ? { error: refuse(`Cannot load "${name}"`) } : source;
      },
      (base, requested) => {
        const resolved = resolveModuleSpecifier(base, requested, hasModule);
        return resolved.ok ? resolved.key : { error: refuse(resolved.message) };
      },
    );

    installLogSink(ctx, logs);
    const inputHandle = ctx.newString(job.inputJson);
    ctx.setProp(ctx.global, '__daisyInput', inputHandle);
    inputHandle.dispose();

    const evaluated = ctx.evalCode(
      bootSource(job.entry, job.maxOutputBytes, job.maxLogBytes),
      BOOT_MODULE_NAME,
    );
    if (evaluated.error) {
      const error = readGuestError(ctx, evaluated.error);
      evaluated.error.dispose();
      if (timedOut) return timeout();
      return fail(
        isOutOfMemory(error)
          ? { kind: 'memory', message: 'The script exceeded its memory limit' }
          : {
              kind: 'internal',
              message: `The script runner failed to start: ${describeGuestError(error)}`,
            },
      );
    }
    promise = evaluated.value;

    for (;;) {
      const state = ctx.getPromiseState(promise);
      if (state.type !== 'pending') break;
      if (!runtime.hasPendingJob()) {
        return fail({
          kind: 'timeout',
          message:
            'The script returned a promise that can never settle (the sandbox has no timers or I/O to wait on)',
        });
      }
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const error = readGuestError(ctx, jobs.error);
        jobs.error.dispose();
        if (timedOut) return timeout();
        return fail(
          isOutOfMemory(error)
            ? { kind: 'memory', message: 'The script exceeded its memory limit' }
            : { kind: 'runtime', message: describeGuestError(error) },
        );
      }
      if (timedOut) return timeout();
    }
    if (timedOut) return timeout();

    const settled = ctx.getPromiseState(promise);
    if (settled.type === 'rejected') {
      const error = readGuestError(ctx, settled.error);
      settled.error.dispose();
      return fail(
        isOutOfMemory(error)
          ? { kind: 'memory', message: 'The script exceeded its memory limit' }
          : { kind: 'runtime', message: describeGuestError(error) },
      );
    }
    if (settled.type !== 'fulfilled') {
      return fail({
        kind: 'internal',
        message: 'The script runner lost track of the script result',
      });
    }
    const envelopeText = ctx.getString(settled.value);
    settled.value.dispose();

    if (violation !== undefined) return fail({ kind: 'runtime', message: violation });

    const envelope = JSON.parse(envelopeText) as {
      k: string;
      e?: GuestError;
      m?: string;
      s?: string;
    };
    switch (envelope.k) {
      case 'ok': {
        const outputJson = envelope.s ?? '';
        if (Buffer.byteLength(outputJson) > job.maxOutputBytes) {
          return fail({
            kind: 'output_too_large',
            message: `The script's result is larger than ${job.maxOutputBytes} bytes once serialised`,
          });
        }
        return { ok: true, outputJson, logs: logs.value, logsTruncated: logs.truncated };
      }
      case 'big':
        return fail({
          kind: 'output_too_large',
          message: `The script's result is larger than ${job.maxOutputBytes} bytes once serialised`,
        });
      case 'invalid':
        return fail({
          kind: 'invalid_result',
          message: `The script's result is not JSON-serialisable: ${capped(envelope.m ?? '', 500)}`,
        });
      case 'nofn':
        return fail({
          kind: 'runtime',
          message: 'The script must `export default` a function that takes the input',
        });
      case 'load':
      case 'throw': {
        const error = envelope.e ?? { name: 'Error', message: 'unknown error', stack: '' };
        let kind: ScriptFailureKind = 'runtime';
        if (isOutOfMemory(error)) kind = 'memory';
        else if (envelope.k === 'load' && error.name === 'SyntaxError') kind = 'syntax';
        return fail({
          kind,
          message:
            kind === 'memory' ? 'The script exceeded its memory limit' : describeGuestError(error),
        });
      }
      default:
        return fail({
          kind: 'internal',
          message: 'The script runner produced an unreadable result',
        });
    }
  } finally {
    if (!discardRuntime) {
      try {
        promise?.dispose();
        ctx.dispose();
        runtime.dispose();
      } catch {
        // The outcome is already decided and the worker is discarded after it is posted.
      }
    }
  }
}

function post(outcome: WorkerOutcome): void {
  parentPort?.postMessage(outcome);
}

runJob(workerData as WorkerJob).then(post, (error: unknown) => {
  post({
    ok: false,
    kind: 'internal',
    message: capped(
      error instanceof Error ? error.message : String(error),
      MAX_FAILURE_MESSAGE_CHARS,
    ),
    logs: '',
    logsTruncated: false,
  });
});
