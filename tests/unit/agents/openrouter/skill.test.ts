import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSkillToolSpec, listSkillNames } from '../../../../src/agents/openrouter/skill';
import { toolCallIdSchema, type ToolCallId } from '../../../../src/shared';

/**
 * The OpenRouter agent's own `skill` tool: a read-only reader of the
 * application-owned bundled skill directories. Exercised against a scratch
 * directory, no SDK involved.
 */

const TOOL_CALL_ID: ToolCallId = toolCallIdSchema.parse('call-1');
const roots: string[] = [];

async function scratchSkills(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openrouter-skills-'));
  roots.push(root);
  await mkdir(path.join(root, 'search'));
  await writeFile(path.join(root, 'search', 'SKILL.md'), '# search\nQuery guidance.');
  await mkdir(path.join(root, 'semantic-search'));
  await writeFile(path.join(root, 'semantic-search', 'SKILL.md'), '# semantic search');
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(spec: ReturnType<typeof createSkillToolSpec>, args: Record<string, string>) {
  if (spec === undefined) throw new Error('expected a skill spec');
  return spec.executor(args, { toolCallId: TOOL_CALL_ID, signal: undefined });
}

describe('listSkillNames', () => {
  it('lists skill directories in sorted order and ignores a missing directory', async () => {
    const root = await scratchSkills();
    const names = await listSkillNames([root, path.join(root, 'does-not-exist')]);
    expect(names).toEqual(['search', 'semantic-search']);
  });
});

describe('createSkillToolSpec', () => {
  it('returns undefined without a bundled directory', () => {
    expect(createSkillToolSpec([], [], () => 'id')).toBeUndefined();
  });

  it('names the available skills in the model-facing description', async () => {
    const root = await scratchSkills();
    const spec = createSkillToolSpec([root], ['search', 'semantic-search'], () => 'id');
    expect(spec?.name).toBe('skill');
    expect(spec?.description).toContain('search');
    expect(spec?.description).toContain('semantic-search');
  });

  it('loads a skill body as the model-facing result', async () => {
    const root = await scratchSkills();
    const result = await run(
      createSkillToolSpec([root], ['search'], () => 'id'),
      { skill: 'search' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ resultType: 'success' });
      const payload = result.value as { textResultForLlm: string };
      expect(payload.textResultForLlm).toContain('Query guidance.');
    }
  });

  it('rejects an unknown skill without leaking the filesystem', async () => {
    const root = await scratchSkills();
    const result = await run(
      createSkillToolSpec([root], [], () => 'id'),
      { skill: 'ghost' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects an invalid or traversal-shaped name', async () => {
    const root = await scratchSkills();
    const spec = createSkillToolSpec([root], [], () => 'id');
    for (const skill of ['../secret', 'a/b', '..', '']) {
      const result = await run(spec, { skill });
      expect(result.ok).toBe(false);
    }
  });
});
