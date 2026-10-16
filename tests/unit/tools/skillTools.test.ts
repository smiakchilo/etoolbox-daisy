import { describe, expect, it, vi } from 'vitest';
import { createFakeSkillHost } from '../../support/fakeSkillHost';
import { type SkillSummary, type ToolHost, err, ok } from '../../../src/shared';
import { tool as skillTool } from '../../../src/tools/skill/tool';
import { tool as skillResourceTool } from '../../../src/tools/skill-resource/tool';
import { tool as skillScriptTool } from '../../../src/tools/skill-script/tool';
import { createCountingIdGenerator } from '../../support/testIds';

const ids = createCountingIdGenerator('skill');
const callContext = { toolCallId: 'call-1' as never, signal: undefined };

function makeHost(skills: ToolHost['skills']): ToolHost {
  return {
    bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
    currentContext: () => {
      throw new Error('skill tools must never ask for an AEM context');
    },
    environmentFacts: () => undefined,
    configuredHosts: () => [],
    skills,
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
    clock: () => 1,
    idGenerator: ids,
    invokeTool: () => Promise.reject(new Error('not used')),
  };
}

function summary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: 'demo',
    description: 'A demo skill',
    userDescription: '',
    source: 'user',
    userInvocable: true,
    disableModelInvocation: false,
    hasScripts: true,
    ...overrides,
  };
}

function failure(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok || result.error === undefined) throw new Error('expected a failure');
  return result.error.code;
}

function successPayload(result: { ok: boolean; value?: unknown }): Record<string, unknown> {
  if (!result.ok) throw new Error('expected a success');
  return result.value as Record<string, unknown>;
}

describe('skill manifests', () => {
  it.each([
    ['skill', skillTool],
    ['skill_resource', skillResourceTool],
    ['skill_script', skillScriptTool],
  ] as const)(
    '%s is internally consistent and its schema is a JSON object schema',
    (name, tool) => {
      expect(tool.name).toBe(name);
      if (!('descriptor' in tool)) throw new Error('expected a model-facing tool');
      expect(tool.descriptor.name).toBe(name);
      expect(tool.allowlistEntry).toBe(`custom:${name}`);
      expect(tool.descriptor.parameters).toMatchObject({ type: 'object' });
      expect(tool.instructions.length).toBeGreaterThan(0);
    },
  );

  it('skill_script describes its JSON input without leaving an unresolved reference', () => {
    if (!('descriptor' in skillScriptTool)) throw new Error('expected a model-facing tool');
    const text = JSON.stringify(skillScriptTool.descriptor.parameters);
    expect(text).toContain('input');
    for (const [, target] of text.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)) {
      expect(text).toContain(`"${target}":`);
    }
  });
});

describe('skill executor', () => {
  it('loads a skill and reports its source and file counts', async () => {
    const execute = skillTool.createExecutor(
      makeHost(
        createFakeSkillHost({
          list: () => [summary()],
          activate: (name) =>
            ok({
              name,
              body: 'Do the thing.',
              files: [
                { path: 'references/a.md', size: 3 },
                { path: 'scripts/run.js', size: 9 },
                { path: 'scripts/tool.py', size: 4 },
              ],
            }),
        }),
      ),
    );

    const payload = successPayload(await execute({ name: 'demo' }, callContext));

    expect(payload).toMatchObject({
      operation: 'skill',
      skill: 'demo',
      source: 'user',
      fileCount: 3,
      scriptCount: 1,
      resultType: 'success',
    });
    expect(String(payload['textResultForLlm'])).toContain('Do the thing.');
  });

  it('refuses a skill only the user may start, without loading it', async () => {
    const activate = vi.fn();
    const execute = skillTool.createExecutor(
      makeHost(
        createFakeSkillHost({
          list: () => [summary({ disableModelInvocation: true })],
          activate,
        }),
      ),
    );

    expect(failure(await execute({ name: 'demo' }, callContext))).toBe('ACCESS_DENIED');
    expect(activate).not.toHaveBeenCalled();
  });

  it('reports an unknown skill, a malformed name and an extra argument', async () => {
    const execute = skillTool.createExecutor(makeHost(createFakeSkillHost({})));
    expect(failure(await execute({ name: 'ghost' }, callContext))).toBe('NOT_FOUND');
    expect(failure(await execute({ name: '../x' }, callContext))).toBe('INVALID_ARGUMENT');
    expect(failure(await execute({ name: 'demo', extra: 1 }, callContext))).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('is cancelled before touching the host when the turn is already aborted', async () => {
    const activate = vi.fn();
    const execute = skillTool.createExecutor(makeHost(createFakeSkillHost({ activate })));
    const aborted = new AbortController();
    aborted.abort();
    expect(
      failure(await execute({ name: 'demo' }, { ...callContext, signal: aborted.signal })),
    ).toBe('CANCELLED');
    expect(activate).not.toHaveBeenCalled();
  });
});

describe('skill_resource executor', () => {
  it('returns a file window, flags a cut-off and passes startLine through', async () => {
    const readResource = vi.fn(() =>
      Promise.resolve(
        ok({
          kind: 'file' as const,
          path: 'references/a.md',
          size: 20,
          startLine: 3,
          endLine: 4,
          totalLines: 9,
          text: 'c\nd',
          nextStartLine: 5,
        }),
      ),
    );
    const execute = skillResourceTool.createExecutor(
      makeHost(createFakeSkillHost({ readResource })),
    );

    const payload = successPayload(
      await execute({ skill: 'demo', path: 'references/a.md', startLine: 3 }, callContext),
    );

    expect(readResource).toHaveBeenCalledWith({
      skill: 'demo',
      path: 'references/a.md',
      startLine: 3,
    });
    expect(payload).toMatchObject({
      operation: 'skill_resource',
      kind: 'file',
      truncated: true,
      startLine: 3,
      endLine: 4,
      totalLines: 9,
    });
    expect(String(payload['textResultForLlm'])).toContain('startLine=5');
  });

  it('lists a folder', async () => {
    const execute = skillResourceTool.createExecutor(
      makeHost(
        createFakeSkillHost({
          readResource: () =>
            Promise.resolve(
              ok({
                kind: 'directory' as const,
                path: '.',
                entries: [{ path: 'references/a.md', size: 3 }],
              }),
            ),
        }),
      ),
    );

    const payload = successPayload(await execute({ skill: 'demo', path: '.' }, callContext));

    expect(payload).toMatchObject({ kind: 'directory', entryCount: 1 });
    expect(String(payload['textResultForLlm'])).toContain('references/a.md');
  });

  it('passes the host’s refusal through and validates its arguments', async () => {
    const execute = skillResourceTool.createExecutor(
      makeHost(
        createFakeSkillHost({
          readResource: () =>
            Promise.resolve(err({ code: 'INVALID_ARGUMENT' as const, message: 'nope' })),
        }),
      ),
    );
    expect(failure(await execute({ skill: 'demo', path: 'x' }, callContext))).toBe(
      'INVALID_ARGUMENT',
    );
    for (const bad of [
      { skill: 'demo' },
      { skill: 'demo', path: 'x', startLine: 0 },
      { skill: 'D', path: 'x' },
    ]) {
      expect(failure(await execute(bad, callContext))).toBe('INVALID_ARGUMENT');
    }
  });
});

describe('skill_script executor', () => {
  it('runs the script with the input and returns the output, logs and duration', async () => {
    const runScript = vi.fn(() =>
      Promise.resolve(
        ok({ output: { total: 6 }, logs: 'hello', logsTruncated: false, durationMs: 12 }),
      ),
    );
    const execute = skillScriptTool.createExecutor(makeHost(createFakeSkillHost({ runScript })));

    const payload = successPayload(
      await execute(
        { skill: 'demo', script: 'scripts/run.js', input: { values: [1, 2, 3] } },
        callContext,
      ),
    );

    expect(runScript).toHaveBeenCalledWith(
      expect.objectContaining({
        skill: 'demo',
        script: 'scripts/run.js',
        input: { values: [1, 2, 3] },
      }),
    );
    expect(payload).toMatchObject({
      operation: 'skill_script',
      output: { total: 6 },
      logs: 'hello',
      durationMs: 12,
    });
    expect(String(payload['textResultForLlm'])).toContain('"total": 6');
  });

  it('defaults a missing input to an empty object', async () => {
    const runScript = vi.fn(() =>
      Promise.resolve(ok({ output: null, logs: '', logsTruncated: false, durationMs: 1 })),
    );
    const execute = skillScriptTool.createExecutor(makeHost(createFakeSkillHost({ runScript })));
    await execute({ skill: 'demo', script: 'scripts/run.js' }, callContext);
    expect(runScript).toHaveBeenCalledWith(expect.objectContaining({ input: {} }));
  });

  it('maps a host failure to its tool error and rejects malformed arguments', async () => {
    const execute = skillScriptTool.createExecutor(
      makeHost(
        createFakeSkillHost({
          runScript: () => Promise.resolve(err({ code: 'TIMEOUT' as const, message: 'slow' })),
        }),
      ),
    );
    expect(failure(await execute({ skill: 'demo', script: 'scripts/run.js' }, callContext))).toBe(
      'TIMEOUT',
    );
    expect(failure(await execute({ skill: 'demo' }, callContext))).toBe('INVALID_ARGUMENT');
    expect(
      failure(await execute({ skill: 'demo', script: 'a.js', extra: true }, callContext)),
    ).toBe('INVALID_ARGUMENT');
  });

  it.each([['text'], [42], [true], [null], [[1, 2, 3]]])(
    'passes the JSON value %j through as the input',
    async (value) => {
      const runScript = vi.fn(() =>
        Promise.resolve(ok({ output: null, logs: '', logsTruncated: false, durationMs: 1 })),
      );
      const execute = skillScriptTool.createExecutor(makeHost(createFakeSkillHost({ runScript })));
      const payload = successPayload(
        await execute({ skill: 'demo', script: 'scripts/run.js', input: value }, callContext),
      );
      expect(runScript).toHaveBeenCalledWith(expect.objectContaining({ input: value }));
      expect(payload['input']).toEqual(value);
    },
  );
});
