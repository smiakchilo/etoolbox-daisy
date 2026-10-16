import { writeFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activeWorkerCount,
  DEFAULT_SCRIPT_LIMITS,
  runSkillScript,
  type ScriptModules,
  type ScriptRunRequest,
  type ScriptRunResult,
} from '../../../../../src/main/skills/sandbox/scriptRunner';
import { createScratchDirs } from '../../../../support/scratchDirs';
import { buildScriptWorker, type BuiltScriptWorker } from '../../../../support/scriptWorkerBuild';

const ENTRY = 'scripts/main.js';

let built: BuiltScriptWorker;
const scratch = createScratchDirs('script-runner', 'run-');

beforeAll(() => {
  built = buildScriptWorker();
});
afterAll(() => {
  built.cleanup();
});
afterEach(async () => {
  scratch.cleanup();
  // A worker that hit its memory cap is slow to exit while the whole suite runs in parallel.
  await vi.waitFor(
    () => {
      expect(activeWorkerCount()).toBe(0);
    },
    { timeout: 10_000 },
  );
});

function run(
  source: string,
  input: unknown = null,
  extra: Partial<Omit<ScriptRunRequest, 'entry' | 'input'>> = {},
  workerPath = built.workerPath,
): Promise<ScriptRunResult> {
  return runSkillScript(
    { entry: ENTRY, modules: { [ENTRY]: source }, input, ...extra },
    { workerPath },
  );
}

function runModules(modules: ScriptModules, input: unknown = null): Promise<ScriptRunResult> {
  return runSkillScript({ entry: ENTRY, modules, input }, { workerPath: built.workerPath });
}

function expectFailure(result: ScriptRunResult, kind: string): void {
  expect(result.ok ? 'ok' : result.kind, result.ok ? undefined : result.message).toBe(kind);
}

describe('results', () => {
  it('returns a JSON value computed from the input', async () => {
    const result = await run(
      'export default (input) => ({ total: input.a + input.b, tags: ["x"] })',
      {
        a: 2,
        b: 3,
      },
    );
    expect(result).toMatchObject({ ok: true, output: { total: 5, tags: ['x'] } });
  });

  it('awaits an async function', async () => {
    const result = await run(
      'export default async (input) => { await Promise.resolve(); await null; return input.list.map((n) => n * 2) }',
      { list: [1, 2, 3] },
    );
    expect(result).toMatchObject({ ok: true, output: [2, 4, 6] });
  });

  it('returns a string as a string', async () => {
    const result = await run('export default (input) => `hello ${input}`', 'world');
    expect(result).toMatchObject({ ok: true, output: 'hello world' });
  });

  it('treats an undefined input as null', async () => {
    const result = await run('export default (input) => input === null', undefined);
    expect(result).toMatchObject({ ok: true, output: true });
  });

  it('runs a fresh context for every call', async () => {
    const source =
      'globalThis.seen = (globalThis.seen ?? 0) + 1; export default () => globalThis.seen';
    const first = await run(source);
    const second = await run(source);
    expect([first, second]).toMatchObject([
      { ok: true, output: 1 },
      { ok: true, output: 1 },
    ]);
  });

  it('keeps the standard library the scripts rely on', async () => {
    const result = await run(
      `export default () => ({
        sorted: [3, 1, 2].toSorted(),
        grouped: Object.keys(Object.groupBy([1, 2, 3], (n) => (n % 2 ? 'odd' : 'even'))),
        date: new Date(Date.UTC(2020, 0, 2)).toISOString(),
        regex: 'a1b22'.match(/\\d+/g),
      })`,
    );
    expect(result).toMatchObject({
      ok: true,
      output: {
        sorted: [1, 2, 3],
        grouped: ['odd', 'even'],
        date: '2020-01-02T00:00:00.000Z',
        regex: ['1', '22'],
      },
    });
  });
});

describe('modules', () => {
  it('resolves relative imports against the map, including nested and parent paths', async () => {
    const result = await runModules(
      {
        [ENTRY]: "import { double } from '../lib/math.mjs'; export default (n) => double(n)",
        'lib/math.mjs': "import { twice } from './twice.js'; export const double = (n) => twice(n)",
        'lib/twice.js': 'export const twice = (n) => n * 2',
      },
      21,
    );
    expect(result).toMatchObject({ ok: true, output: 42 });
  });

  it('refuses an entry that is not a file of the skill', async () => {
    const result = await runSkillScript(
      { entry: 'scripts/missing.js', modules: { [ENTRY]: 'export default () => 1' }, input: null },
      { workerPath: built.workerPath },
    );
    expectFailure(result, 'invalid_input');
  });

  it('fails a script whose default export is not a function', async () => {
    expectFailure(await run('export default 5'), 'runtime');
    expectFailure(await run('export const named = () => 1'), 'runtime');
  });
});

describe('failures of the script itself', () => {
  it('reports an uncaught throw as a runtime failure with its message and stack', async () => {
    const result = await run('export default (input) => { throw new Error(input.marker) }', {
      marker: 'marker-7f3a',
    });
    expectFailure(result, 'runtime');
    expect(result.ok ? '' : result.message).toContain('marker-7f3a');
  });

  it('reports a rejected async function as a runtime failure', async () => {
    expectFailure(
      await run('export default async () => { await null; throw new TypeError("x") }'),
      'runtime',
    );
  });

  it('reports a syntax error in the entry', async () => {
    expectFailure(await run('export default (( => {'), 'syntax');
  });

  it('reports a syntax error in an imported file', async () => {
    const result = await runModules({
      [ENTRY]: "import './broken.js'; export default () => 1",
      'scripts/broken.js': 'const = ;',
    });
    expectFailure(result, 'syntax');
  });

  it('reports runaway recursion as a runtime failure without crashing the worker', async () => {
    const result = await run('export default () => { const f = () => f() + 1; return f() }');
    expectFailure(result, 'runtime');
  });

  it('caps a very long failure message', async () => {
    const result = await run('export default () => { throw new Error("y".repeat(50000)) }');
    expect(result.ok ? 0 : result.message.length).toBeLessThan(5000);
  });

  it('caps a huge thrown value before it leaves the sandbox', async () => {
    const result = await run(
      'export default () => { const e = new Error("z"); e.stack = "s".repeat(5_000_000); throw e }',
    );
    expect(result.ok ? 0 : result.message.length).toBeLessThan(5000);
  });
});

describe('confinement', () => {
  it.each([
    ['require', 'export default () => require("fs")'],
    ['process', 'export default () => process.env'],
    ['fetch', 'export default () => globalThis.fetch("http://127.0.0.1:1/")'],
    ['a static node: import', "import fs from 'node:fs'; export default () => fs"],
    ['a static bare import', "import x from 'lodash'; export default () => x"],
    ['a dynamic node: import', 'export default async () => import("node:fs")'],
    ['a dynamic escape above the skill', 'export default async () => import("../../outside.js")'],
    [
      'a dynamic import outside the map',
      'export default async () => import("./not-in-the-map.js")',
    ],
    ['an import that leaves the folder', "import '../../../outside.js'; export default () => 1"],
  ])('fails a script using %s', async (_label, source) => {
    expectFailure(await run(source), 'runtime');
  });

  it('fails the run even when the script swallows the refused import', async () => {
    const result = await run(
      'export default async () => { try { await import("node:fs") } catch { return "handled" } return "loaded" }',
    );
    expectFailure(result, 'runtime');
  });

  it('exposes none of the host globals', async () => {
    const names = [
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'require',
      'module',
      'process',
      'Buffer',
      'fs',
      'child_process',
      'setTimeout',
      'setInterval',
      'setImmediate',
      'queueMicrotask',
      'structuredClone',
      'window',
      'document',
      'navigator',
    ];
    const result = await run(
      'export default (names) => names.filter((name) => typeof globalThis[name] !== "undefined")',
      names,
    );
    expect(result).toMatchObject({ ok: true, output: [] });
  });
});

describe('logs', () => {
  it('captures console output from every level', async () => {
    const result = await run(
      `export default (m) => { console.log(m, { a: 1 }); console.info(m); console.warn(m); console.error(m); return 1 }`,
      'mark-91',
    );
    expect(result.logs.match(/mark-91/g)).toHaveLength(4);
    expect(result.logsTruncated).toBe(false);
  });

  it('caps the logs and flags the truncation', async () => {
    const result = await run(
      'export default () => { for (let i = 0; i < 1000; i++) console.log("x".repeat(100)); return "done" }',
      null,
      { limits: { maxLogBytes: 500 } },
    );
    expect(result).toMatchObject({ ok: true, output: 'done', logsTruncated: true });
    expect(Buffer.byteLength(result.logs)).toBeLessThanOrEqual(500);
  });

  it('never splits a multi-byte character when it truncates', async () => {
    const result = await run(
      'export default () => { console.log("é".repeat(100)); return 1 }',
      null,
      {
        limits: { maxLogBytes: 51 },
      },
    );
    expect(result.logs).not.toContain('\uFFFD');
    expect(result.logsTruncated).toBe(true);
  });

  it('keeps the logs of a script that then fails', async () => {
    const result = await run(
      'export default (m) => { console.log(m); throw new Error("x") }',
      'before-failure',
    );
    expectFailure(result, 'runtime');
    expect(result.logs).toContain('before-failure');
  });

  it('bounds a single huge log line and a huge logged object inside the sandbox', async () => {
    const result = await run(
      `export default () => {
        console.log("x".repeat(5_000_000));
        console.log({ big: "y".repeat(5_000_000) });
        return "done";
      }`,
      null,
      { limits: { maxLogBytes: 1000 } },
    );
    expect(result).toMatchObject({ ok: true, output: 'done', logsTruncated: true });
    expect(Buffer.byteLength(result.logs)).toBeLessThanOrEqual(1000);
  });

  it('stops formatting once the log budget is spent', async () => {
    const result = await run(
      `export default () => {
        let calls = 0;
        const probe = { toJSON() { calls++; return "p"; } };
        for (let i = 0; i < 5000; i++) console.log(probe);
        return calls;
      }`,
      null,
      { limits: { maxLogBytes: 100 } },
    );
    expect(result.ok && (result.output as number)).toBeLessThan(200);
    expect(result.logsTruncated).toBe(true);
  });
});

describe('result and input validation', () => {
  it.each([
    ['undefined', 'export default () => undefined'],
    ['a function', 'export default () => () => 1'],
    ['a symbol', 'export default () => Symbol("s")'],
    ['a BigInt', 'export default () => 10n'],
    ['a cyclic object', 'export default () => { const a = {}; a.self = a; return a }'],
    ['a throwing toJSON', 'export default () => ({ toJSON() { throw new Error("no") } })'],
  ])('rejects %s as an invalid result', async (_label, source) => {
    expectFailure(await run(source), 'invalid_result');
  });

  it('rejects a result larger than the output cap', async () => {
    const result = await run('export default () => "x".repeat(2000)', null, {
      limits: { maxOutputBytes: 1000 },
    });
    expectFailure(result, 'output_too_large');
  });

  it('rejects a result far larger than the cap', async () => {
    const result = await run('export default () => "x".repeat(1_000_000)', null, {
      limits: { maxOutputBytes: 1000 },
    });
    expectFailure(result, 'output_too_large');
  });

  it('accepts a result exactly at the output cap', async () => {
    const result = await run('export default () => "x".repeat(8)', null, {
      limits: { maxOutputBytes: 10 },
    });
    expect(result.ok).toBe(true);
  });

  it('measures the output cap in bytes, not characters', async () => {
    const result = await run('export default () => "é".repeat(8)', null, {
      limits: { maxOutputBytes: 12 },
    });
    expectFailure(result, 'output_too_large');
  });

  it('applies the default output cap', async () => {
    const result = await run(
      `export default () => "x".repeat(${DEFAULT_SCRIPT_LIMITS.maxOutputBytes})`,
    );
    expectFailure(result, 'output_too_large');
  });

  describe('invalid input is refused before a worker is ever started', () => {
    // A worker path that cannot load: a spawn would surface as `internal`, not `invalid_input`.
    const neverSpawned = path.join('does', 'not', 'exist.cjs');

    it('refuses an input larger than the cap', async () => {
      const result = await run(
        'export default () => 1',
        'x'.repeat(2000),
        { limits: { maxInputBytes: 1000 } },
        neverSpawned,
      );
      expectFailure(result, 'invalid_input');
    });

    it('refuses an input that is not JSON-serialisable', async () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      for (const input of [cyclic, 10n]) {
        expectFailure(
          await run('export default () => 1', input, {}, neverSpawned),
          'invalid_input',
        );
      }
    });
  });
});

describe('limits', () => {
  it('stops an infinite loop at the deadline, well before the backstop, keeping its logs', async () => {
    const result = await run(
      'export default (m) => { console.log(m); while (true) {} }',
      'looping',
      { limits: { deadlineMs: 300, backstopMs: 4000 } },
    );
    expectFailure(result, 'timeout');
    expect(result.durationMs).toBeLessThan(3000);
    expect(result.logs).toContain('looping');
  });

  it('stops an endless chain of promise jobs at the deadline', async () => {
    const result = await run('export default async () => { for (;;) await null }', null, {
      limits: { deadlineMs: 300, backstopMs: 4000 },
    });
    expectFailure(result, 'timeout');
    expect(result.durationMs).toBeLessThan(3000);
  });

  it('ends a promise that can never settle as a timeout', async () => {
    const result = await run('export default () => new Promise(() => {})', null, {
      limits: { deadlineMs: 300, backstopMs: 4000 },
    });
    expectFailure(result, 'timeout');
    expect(result.durationMs).toBeLessThan(3000);
  });

  it('terminates the worker at the backstop when the deadline did not stop it', async () => {
    const result = await run('export default () => { while (true) {} }', null, {
      limits: { deadlineMs: 60_000, backstopMs: 400 },
    });
    expectFailure(result, 'timeout');
    expect(result.durationMs).toBeLessThan(3000);
  });

  it('stops an allocation bomb as a memory failure and leaves the host responsive', async () => {
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 20);
    try {
      const result = await run(
        'export default () => { const keep = []; for (;;) keep.push(new Array(10000).fill(1)) }',
        null,
        { limits: { memoryBytes: 8 * 1024 * 1024, deadlineMs: 20_000, backstopMs: 25_000 } },
      );
      expectFailure(result, 'memory');
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(heartbeat);
    }
    expect(await run('export default () => "alive"')).toMatchObject({ ok: true, output: 'alive' });
  }, 40_000);

  it('stops one oversized buffer allocation as a memory failure', async () => {
    const result = await run(
      'export default () => new ArrayBuffer(256 * 1024 * 1024).byteLength',
      null,
      {
        limits: { memoryBytes: 8 * 1024 * 1024 },
      },
    );
    expectFailure(result, 'memory');
  });

  it('reports a worker that exhausts its own heap as a memory failure', async () => {
    // 8 MB is too small for the worker to even load the engine; it ends with ERR_WORKER_OUT_OF_MEMORY.
    const result = await run('export default () => 1', null, { limits: { workerHeapMb: 8 } });
    expectFailure(result, 'memory');
  });

  it('applies the stack limit to recursion', async () => {
    const source =
      'const down = (n) => (n === 0 ? 0 : 1 + down(n - 1)); export default () => down(2000)';
    expect(await run(source)).toMatchObject({ ok: true, output: 2000 });
    expectFailure(await run(source, null, { limits: { stackBytes: 16 * 1024 } }), 'runtime');
  });
});

describe('cancellation and cleanup', () => {
  it('cancels a running script and removes its worker', async () => {
    const controller = new AbortController();
    const pending = run('export default () => { while (true) {} }', null, {
      signal: controller.signal,
      limits: { deadlineMs: 60_000, backstopMs: 60_000 },
    });
    await vi.waitFor(() => {
      expect(activeWorkerCount()).toBe(1);
    });
    controller.abort();
    expectFailure(await pending, 'cancelled');
    await vi.waitFor(() => {
      expect(activeWorkerCount()).toBe(0);
    });
  });

  it('is cancelled without starting a worker when the signal is already aborted', async () => {
    const result = await run(
      'export default () => 1',
      null,
      { signal: AbortSignal.abort() },
      path.join('does', 'not', 'exist.cjs'),
    );
    expectFailure(result, 'cancelled');
  });

  it('leaves no worker, timer or abort listener behind after any outcome', async () => {
    const controller = new AbortController();
    const timers = (): number =>
      process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    const before = timers();
    const sources = [
      'export default () => 1',
      'export default () => { throw new Error("x") }',
      'export default () => undefined',
      'export default () => { while (true) {} }',
    ];
    for (const source of sources) {
      await run(source, null, {
        signal: controller.signal,
        limits: { deadlineMs: 200, backstopMs: 2000 },
      });
    }
    expect(activeWorkerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(timers()).toBeLessThanOrEqual(before);
  });

  it('reports a worker that crashes while loading as an internal failure', async () => {
    const broken = path.join(scratch.create(), 'broken.cjs');
    writeFileSync(broken, 'throw new Error("cannot start")');
    expectFailure(await run('export default () => 1', null, {}, broken), 'internal');
  });

  it('reports a worker that exits without answering as an internal failure', async () => {
    const silent = path.join(scratch.create(), 'silent.cjs');
    writeFileSync(silent, 'process.exit(0)');
    expectFailure(await run('export default () => 1', null, {}, silent), 'internal');
  });

  it('runs several scripts at once without mixing their results', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => run('export default (n) => n * 10', n)),
    );
    expect(results.map((r) => (r.ok ? r.output : undefined))).toEqual([10, 20, 30, 40]);
  });
});
