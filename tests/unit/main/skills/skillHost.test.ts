import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SKILL_RESOURCE_MAX_BYTES,
  SKILL_RESOURCE_MAX_LINES,
  createSkillHost,
} from '../../../../src/main/skills/skillHost';
import type { SkillOutcome } from '../../../../src/shared';
import type {
  ScriptRunRequest,
  ScriptRunResult,
} from '../../../../src/main/skills/sandbox/scriptRunner';
import { createSkillStore } from '../../../../src/main/skills/skillStore';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('skill-host', 'host-');
afterEach(() => scratch.cleanup());

const SKILL_MD = '---\nname: demo\ndescription: A demo skill\n---\n\n# Demo\nBody text.\n';

function writeSkill(root: string, files: Record<string, string | Buffer>): void {
  const directory = path.join(root, 'demo');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'SKILL.md'), SKILL_MD, 'utf8');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

async function makeHost(
  files: Record<string, string | Buffer>,
  runScript?: (request: ScriptRunRequest) => Promise<ScriptRunResult>,
) {
  const root = scratch.create();
  writeSkill(root, files);
  const store = createSkillStore({ bundledDirectory: root });
  await store.load();
  const onScriptFailed = vi.fn();
  const host = createSkillHost({
    store,
    ...(runScript === undefined ? {} : { runScript }),
    onScriptFailed,
  });
  return { host, root, onScriptFailed };
}

const signal = new AbortController().signal;

function failureOf<T>(outcome: { ok: boolean; error?: { code: string; message: string } } & T) {
  if (outcome.ok || outcome.error === undefined) throw new Error('expected a failure');
  return outcome.error;
}

describe('createSkillHost.activate', () => {
  it('returns the body and the file index, and NOT_FOUND for an unknown skill', async () => {
    const { host } = await makeHost({ 'references/a.md': 'x' });
    const activated = await host.activate('demo');
    expect(activated.ok).toBe(true);
    if (activated.ok) {
      expect(activated.value.body).toContain('Body text');
      expect(activated.value.files.map((file) => file.path)).toEqual(['references/a.md']);
    }
    expect(failureOf(await host.activate('missing')).code).toBe('NOT_FOUND');
  });
});

describe('createSkillHost.readResource', () => {
  it('reads a text file with its line window', async () => {
    const { host } = await makeHost({ 'references/a.md': 'one\ntwo\nthree\n' });
    const result = await host.readResource({ skill: 'demo', path: 'references/a.md' });
    expect(result).toMatchObject({
      ok: true,
      value: { kind: 'file', startLine: 1, endLine: 3, totalLines: 3, text: 'one\ntwo\nthree' },
    });
  });

  it('cuts a long file and offers the line to continue with', async () => {
    const lines = Array.from({ length: SKILL_RESOURCE_MAX_LINES + 50 }, (_, i) => `line ${i + 1}`);
    const { host } = await makeHost({ 'references/long.md': lines.join('\n') });

    const first = await host.readResource({ skill: 'demo', path: 'references/long.md' });
    expect(first).toMatchObject({
      ok: true,
      value: { endLine: SKILL_RESOURCE_MAX_LINES, nextStartLine: SKILL_RESOURCE_MAX_LINES + 1 },
    });
    const rest = await host.readResource({
      skill: 'demo',
      path: 'references/long.md',
      startLine: SKILL_RESOURCE_MAX_LINES + 1,
    });
    expect(rest).toMatchObject({ ok: true, value: { endLine: lines.length } });
    if (rest.ok && rest.value.kind === 'file') {
      expect(rest.value.nextStartLine).toBeUndefined();
    }
  });

  it('lists a directory and the skill root', async () => {
    const { host } = await makeHost({ 'references/a.md': 'x', 'scripts/s.js': 'export default 1' });
    const root = await host.readResource({ skill: 'demo', path: '.' });
    expect(root).toMatchObject({ ok: true, value: { kind: 'directory' } });
    if (root.ok && root.value.kind === 'directory') {
      expect(root.value.entries.map((entry) => entry.path).sort()).toEqual([
        'references/a.md',
        'scripts/s.js',
      ]);
    }
    const sub = await host.readResource({ skill: 'demo', path: 'references' });
    if (sub.ok && sub.value.kind === 'directory') {
      expect(sub.value.entries.map((entry) => entry.path)).toEqual(['references/a.md']);
    }
  });

  it('refuses binary content, unreadable types, a bad startLine and a past-the-end window', async () => {
    const { host } = await makeHost({
      'references/bin.md': Buffer.from([0x61, 0x00, 0x62]),
      'references/pic.png': 'not text',
      'references/a.md': 'only\n',
    });
    const code = async (relative: string, startLine?: number) =>
      failureOf(
        await host.readResource({
          skill: 'demo',
          path: relative,
          ...(startLine === undefined ? {} : { startLine }),
        }),
      ).code;
    expect(await code('references/bin.md')).toBe('INVALID_ARGUMENT');
    expect(await code('references/pic.png')).toBe('INVALID_ARGUMENT');
    expect(await code('references/a.md', 0)).toBe('INVALID_ARGUMENT');
    expect(await code('references/a.md', 5)).toBe('INVALID_ARGUMENT');
    expect(await code('references/none.md')).toBe('NOT_FOUND');
  });

  it('refuses every way out of the skill folder', async () => {
    const { host, root } = await makeHost({ 'references/a.md': 'x' });
    writeFileSync(path.join(root, 'outside.md'), 'secret', 'utf8');
    for (const escape of [
      '../outside.md',
      'references/../../outside.md',
      path.join(root, 'outside.md'),
      'C:\\Windows\\win.ini',
      '\\\\server\\share\\x.md',
      'references/a.md:stream',
      '.hidden',
    ]) {
      const outcome = await host.readResource({ skill: 'demo', path: escape });
      expect(outcome.ok, escape).toBe(false);
    }
  });

  it('does not follow a junction that leaves the skill folder', async () => {
    const { host, root } = await makeHost({ 'references/a.md': 'x' });
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.md'), 'secret', 'utf8');
    symlinkSync(outside, path.join(root, 'demo', 'references', 'link'), 'junction');

    const outcome = await host.readResource({ skill: 'demo', path: 'references/link/secret.md' });
    expect(outcome.ok).toBe(false);
  });

  it('serves only the files the index lists, not one added after startup', async () => {
    const { host, root } = await makeHost({ 'references/a.md': 'x' });
    writeFileSync(path.join(root, 'demo', 'references', 'late.md'), 'late', 'utf8');
    expect(
      failureOf(await host.readResource({ skill: 'demo', path: 'references/late.md' })).code,
    ).toBe('NOT_FOUND');
    const listing = await host.readResource({ skill: 'demo', path: 'references' });
    if (listing.ok && listing.value.kind === 'directory') {
      expect(listing.value.entries.map((entry) => entry.path)).toEqual(['references/a.md']);
    }
  });

  it('refuses an indexed file that grew since startup instead of loading it', async () => {
    const { host, root } = await makeHost({ 'references/a.md': 'small' });
    writeFileSync(
      path.join(root, 'demo', 'references', 'a.md'),
      'x'.repeat(SKILL_RESOURCE_MAX_BYTES * 4),
      'utf8',
    );
    const outcome = await host.readResource({ skill: 'demo', path: 'references/a.md' });
    expect(failureOf(outcome).code).toBe('UNEXPECTED_RESPONSE');
  });

  it('reports NOT_FOUND for an unknown skill', async () => {
    const { host } = await makeHost({});
    expect(failureOf(await host.readResource({ skill: 'ghost', path: '.' })).code).toBe(
      'NOT_FOUND',
    );
  });
});

describe('createSkillHost.runScript', () => {
  const okResult: ScriptRunResult = {
    ok: true,
    output: { sum: 3 },
    logs: 'hi',
    logsTruncated: false,
    durationMs: 4,
  };

  it('runs the entry with the skill’s scripts as modules and returns the output', async () => {
    const runner = vi.fn((request: ScriptRunRequest) => {
      void request;
      return Promise.resolve(okResult);
    });
    const { host } = await makeHost(
      {
        'scripts/run.js': 'export default () => 1',
        'scripts/lib/util.mjs': 'export const a = 1',
        'references/helper.js': 'export const b = 2',
      },
      runner,
    );

    const outcome = await host.runScript({
      skill: 'demo',
      script: 'scripts/run.js',
      input: { a: 1 },
      signal,
    });

    expect(outcome).toEqual({
      ok: true,
      value: { output: { sum: 3 }, logs: 'hi', logsTruncated: false, durationMs: 4 },
    });
    const request = runner.mock.calls[0]?.[0];
    expect(request?.entry).toBe('scripts/run.js');
    expect(Object.keys(request?.modules ?? {}).sort()).toEqual([
      'scripts/lib/util.mjs',
      'scripts/run.js',
    ]);
    expect(request?.input).toEqual({ a: 1 });
  });

  it('keeps non-JavaScript files readable but not runnable', async () => {
    const runner = vi.fn();
    const { host } = await makeHost(
      { 'scripts/tool.py': 'print(1)', 'references/x.js': 'export default 1' },
      runner,
    );
    for (const script of ['scripts/tool.py', 'references/x.js']) {
      const outcome = await host.runScript({ skill: 'demo', script, input: {}, signal });
      expect(failureOf(outcome).code).toBe('INVALID_ARGUMENT');
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses an escaping or missing script and an unknown skill without running anything', async () => {
    const runner = vi.fn();
    const { host } = await makeHost({ 'scripts/run.js': 'export default 1' }, runner);
    for (const script of ['../x.js', 'scripts/../../x.js', 'scripts/missing.js']) {
      const outcome = await host.runScript({ skill: 'demo', script, input: {}, signal });
      expect(outcome.ok, script).toBe(false);
    }
    expect(
      failureOf(
        await host.runScript({ skill: 'ghost', script: 'scripts/run.js', input: {}, signal }),
      ).code,
    ).toBe('NOT_FOUND');
    expect(runner).not.toHaveBeenCalled();
  });

  it('runs the scripts of one turn one at a time, and other turns in parallel', async () => {
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const runner = () =>
      new Promise<ScriptRunResult>((resolve) => {
        running++;
        peak = Math.max(peak, running);
        gates.push(() => {
          running--;
          resolve(okResult);
        });
      });
    const { host } = await makeHost({ 'scripts/run.js': 'export default 1' }, runner);
    const call = (turn: AbortSignal) =>
      host.runScript({ skill: 'demo', script: 'scripts/run.js', input: {}, signal: turn });

    const turnA = new AbortController().signal;
    const first = call(turnA);
    const second = call(turnA);
    await vi.waitFor(() => {
      expect(gates).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gates).toHaveLength(1);

    const other = call(new AbortController().signal);
    await vi.waitFor(() => {
      expect(gates).toHaveLength(2);
    });
    expect(peak).toBe(2);

    gates[0]?.();
    await vi.waitFor(() => {
      expect(gates).toHaveLength(3);
    });
    gates[1]?.();
    gates[2]?.();
    for (const outcome of await Promise.all([first, second, other])) {
      expect(outcome.ok).toBe(true);
    }
    expect(peak).toBe(2);
  });

  it('keeps the queue moving when a run in front of it fails', async () => {
    let calls = 0;
    const runner = () => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error('runner blew up'))
        : Promise.resolve<ScriptRunResult>(okResult);
    };
    const { host } = await makeHost({ 'scripts/run.js': 'export default 1' }, runner);
    const turn = new AbortController().signal;
    const request = { skill: 'demo', script: 'scripts/run.js', input: {}, signal: turn };

    const first = host.runScript(request);
    const second = host.runScript(request);
    await expect(first).rejects.toThrow('runner blew up');
    expect((await second).ok).toBe(true);
  });

  it.each([
    ['timeout', 'TIMEOUT'],
    ['cancelled', 'CANCELLED'],
    ['output_too_large', 'RESULT_TOO_LARGE_FOR_MODEL'],
    ['syntax', 'UNEXPECTED_RESPONSE'],
    ['memory', 'UNEXPECTED_RESPONSE'],
  ] as const)('maps a %s failure to %s, with its logs, and reports it', async (kind, code) => {
    const runner = () =>
      Promise.resolve<ScriptRunResult>({
        ok: false,
        kind,
        message: 'boom',
        logs: 'before the failure',
        logsTruncated: false,
        durationMs: 1,
      });
    const { host, onScriptFailed } = await makeHost({ 'scripts/run.js': 'x' }, runner);

    const outcome = await host.runScript({
      skill: 'demo',
      script: 'scripts/run.js',
      input: {},
      signal,
    });

    const error = failureOf(outcome);
    expect(error.code).toBe(code);
    expect(error.message).toContain('before the failure');
    expect(onScriptFailed).toHaveBeenCalledWith({
      skill: 'demo',
      script: 'scripts/run.js',
      kind,
    });
  });
});

describe('a skill an add-on contributes', () => {
  /**
   * A store holding one pinned add-on skill that has not been read yet: the
   * host's `prepareSkill` is what installs the add-on and hydrates it.
   */
  function addonHost(prepareSkill: (name: string) => Promise<SkillOutcome<void>>) {
    const store = createSkillStore({
      bundledDirectory: scratch.create(),
      addons: [
        {
          addonId: 'demo-addon',
          skill: {
            name: 'demo',
            description: 'A demo skill',
            userDescription: '',
            userInvocable: true,
            disableModelInvocation: false,
            tableOnly: false,
            hasScripts: false,
          },
        },
      ],
    });
    const host = createSkillHost({ store, prepareSkill });
    return { store, host };
  }

  it('installs the add-on on first use, then answers the activation', async () => {
    const install = scratch.create();
    // An installed add-on carries its skills under `<install>/skills`.
    writeSkill(path.join(install, 'skills'), { 'references/a.md': 'x' });
    const store = createSkillStore({
      bundledDirectory: scratch.create(),
      addons: [
        {
          addonId: 'demo-addon',
          skill: {
            name: 'demo',
            description: 'A demo skill',
            userDescription: '',
            userInvocable: true,
            disableModelInvocation: false,
            tableOnly: false,
            hasScripts: false,
          },
        },
      ],
      addonDirectory: () => Promise.resolve(install),
    });
    const prepareSkill = vi.fn(async () => {
      await store.hydrateAddon('demo-addon');
      return { ok: true, value: undefined } as const;
    });
    const host = createSkillHost({ store, prepareSkill });
    await store.load();

    const activation = await host.activate('demo');

    expect(prepareSkill).toHaveBeenCalledWith('demo');
    expect(activation).toMatchObject({
      ok: true,
      value: { name: 'demo', files: [{ path: 'references/a.md', size: 1 }] },
    });
  });

  it('fails the call when the add-on cannot be installed, with the loader’s own reason', async () => {
    const { host } = addonHost(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'STORAGE_ERROR', message: 'The "demo-addon" add-on is not available' },
      } as const),
    );

    const outcome = await host.activate('demo');

    expect(failureOf(outcome as never)).toMatchObject({
      code: 'STORAGE_ERROR',
      message: expect.stringContaining('demo-addon') as unknown,
    });
    // The same mapping for the other two tools.
    expect((await host.readResource({ skill: 'demo', path: 'x' })).ok).toBe(false);
    expect(
      (await host.runScript({ skill: 'demo', script: 'scripts/x.js', input: null, signal })).ok,
    ).toBe(false);
  });

  it('reports a cancelled install as CANCELLED', async () => {
    const { host } = addonHost(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'CANCELLED', message: 'The download was cancelled' },
      } as const),
    );

    expect(failureOf((await host.activate('demo')) as never).code).toBe('CANCELLED');
  });
});
