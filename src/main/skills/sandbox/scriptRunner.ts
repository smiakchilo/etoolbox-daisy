import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { normalizeModuleKey } from './moduleResolution';
import { MAX_FAILURE_MESSAGE_CHARS, type WorkerJob, type WorkerOutcome } from './scriptProtocol';

export type ScriptModules = Readonly<Record<string, string>>;

export interface ScriptLimits {
  deadlineMs: number;
  backstopMs: number;
  memoryBytes: number;
  stackBytes: number;
  maxOutputBytes: number;
  maxLogBytes: number;
  maxInputBytes: number;
  /** V8 old-generation cap of the worker thread itself (the guest heap is capped by memoryBytes). */
  workerHeapMb: number;
}

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  deadlineMs: 5000,
  backstopMs: 7000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  maxOutputBytes: 64 * 1024,
  maxLogBytes: 16 * 1024,
  maxInputBytes: 256 * 1024,
  workerHeapMb: 192,
};

export interface ScriptRunRequest {
  readonly entry: string;
  readonly modules: ScriptModules;
  readonly input: unknown;
  readonly limits?: Partial<ScriptLimits>;
  readonly signal?: AbortSignal;
}

export type ScriptFailureKind =
  | 'syntax'
  | 'runtime'
  | 'timeout'
  | 'memory'
  | 'cancelled'
  | 'output_too_large'
  | 'invalid_result'
  | 'invalid_input'
  | 'internal';

export type ScriptRunResult =
  | {
      readonly ok: true;
      readonly output: unknown;
      readonly logs: string;
      readonly logsTruncated: boolean;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly kind: ScriptFailureKind;
      readonly message: string;
      readonly logs: string;
      readonly logsTruncated: boolean;
      readonly durationMs: number;
    };

export interface ScriptRunOptions {
  /** The built worker file. Production leaves it out; tests inject a freshly built one. */
  readonly workerPath?: string;
}

let liveWorkers = 0;

/** Workers spawned and not yet exited; a leak check for tests. */
export function activeWorkerCount(): number {
  return liveWorkers;
}

async function resolveWorkerPath(options: ScriptRunOptions | undefined): Promise<string> {
  if (options?.workerPath !== undefined) return options.workerPath;
  // Loaded lazily: the `?modulePath` import exists only in the electron-vite build.
  return (await import('./scriptWorkerPath')).default;
}

function failure(
  kind: ScriptFailureKind,
  message: string,
  startedAt: number,
  extra: { logs?: string; logsTruncated?: boolean } = {},
): ScriptRunResult {
  return {
    ok: false,
    kind,
    message: message.slice(0, MAX_FAILURE_MESSAGE_CHARS),
    logs: extra.logs ?? '',
    logsTruncated: extra.logsTruncated ?? false,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function mergeLimits(partial: Partial<ScriptLimits> | undefined): ScriptLimits {
  const merged = { ...DEFAULT_SCRIPT_LIMITS };
  for (const key of Object.keys(merged) as (keyof ScriptLimits)[]) {
    const wanted = partial?.[key];
    if (wanted !== undefined) merged[key] = positiveInteger(wanted, DEFAULT_SCRIPT_LIMITS[key]);
  }
  return merged;
}

function serialiseInput(input: unknown): string | undefined {
  try {
    return JSON.stringify(input === undefined ? null : input);
  } catch {
    return undefined;
  }
}

/** Runs one skill script in a fresh sandbox. Never rejects. */
export async function runSkillScript(
  request: ScriptRunRequest,
  options?: ScriptRunOptions,
): Promise<ScriptRunResult> {
  const startedAt = performance.now();
  try {
    return await run(request, options, startedAt);
  } catch (error) {
    return failure('internal', error instanceof Error ? error.message : String(error), startedAt);
  }
}

async function run(
  request: ScriptRunRequest,
  options: ScriptRunOptions | undefined,
  startedAt: number,
): Promise<ScriptRunResult> {
  const limits = mergeLimits(request.limits);
  const { signal } = request;
  if (signal?.aborted) return failure('cancelled', 'The script run was cancelled', startedAt);

  if (
    !Object.hasOwn(request.modules, request.entry) ||
    normalizeModuleKey(request.entry) !== request.entry
  ) {
    return failure(
      'invalid_input',
      `The entry "${request.entry.slice(0, 200)}" is not a normalised key of the skill's files`,
      startedAt,
    );
  }
  const inputJson = serialiseInput(request.input);
  if (inputJson === undefined) {
    return failure('invalid_input', 'The script input is not JSON-serialisable', startedAt);
  }
  if (Buffer.byteLength(inputJson) > limits.maxInputBytes) {
    return failure(
      'invalid_input',
      `The script input is larger than ${limits.maxInputBytes} bytes once serialised`,
      startedAt,
    );
  }

  const workerPath = await resolveWorkerPath(options);
  if (signal?.aborted) return failure('cancelled', 'The script run was cancelled', startedAt);

  const job: WorkerJob = {
    entry: request.entry,
    modules: { ...request.modules },
    inputJson,
    deadlineMs: limits.deadlineMs,
    memoryBytes: limits.memoryBytes,
    stackBytes: limits.stackBytes,
    maxOutputBytes: limits.maxOutputBytes,
    maxLogBytes: limits.maxLogBytes,
  };

  return new Promise<ScriptRunResult>((resolve) => {
    const worker = new Worker(workerPath, {
      workerData: job,
      resourceLimits: {
        maxOldGenerationSizeMb: limits.workerHeapMb,
        maxYoungGenerationSizeMb: Math.min(32, limits.workerHeapMb),
      },
    });
    liveWorkers += 1;
    let settled = false;
    let exited = false;

    const onAbort = (): void => {
      finish(failure('cancelled', 'The script run was cancelled', startedAt));
    };
    const finish = (result: ScriptRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      signal?.removeEventListener('abort', onAbort);
      worker.removeAllListeners('message');
      worker.removeAllListeners('messageerror');
      // A terminated worker may still report its teardown; keep that from becoming unhandled.
      worker.on('error', () => undefined);
      const done = (): void => {
        resolve(result);
      };
      if (exited) done();
      else void worker.terminate().then(done, done);
    };

    worker.once('exit', () => {
      exited = true;
      liveWorkers -= 1;
      finish(failure('internal', 'The script worker exited before reporting a result', startedAt));
    });
    worker.on('error', (error: Error) => {
      if ((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY') {
        finish(failure('memory', 'The script exceeded its memory limit', startedAt));
        return;
      }
      finish(failure('internal', `The script worker failed: ${error.message}`, startedAt));
    });
    worker.once('message', (outcome: WorkerOutcome) => {
      const durationMs = Math.round(performance.now() - startedAt);
      if (!outcome.ok) {
        finish({ ...outcome, durationMs });
        return;
      }
      try {
        finish({
          ok: true,
          output: JSON.parse(outcome.outputJson) as unknown,
          logs: outcome.logs,
          logsTruncated: outcome.logsTruncated,
          durationMs,
        });
      } catch {
        finish(failure('invalid_result', 'The script result could not be read back', startedAt));
      }
    });
    const backstop = setTimeout(() => {
      finish(
        failure(
          'timeout',
          `The script did not stop within ${limits.backstopMs} ms and its worker was terminated`,
          startedAt,
        ),
      );
    }, limits.backstopMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
