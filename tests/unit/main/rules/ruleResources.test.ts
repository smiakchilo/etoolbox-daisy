import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRuleResources } from '../../../../src/main/rules/ruleResources';

describe('loadRuleResources', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'daisy-rules-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const REQUIRED = [
    'session.md',
    'skills.md',
    'user-rules.md',
    'project-rules.md',
    'project-rules-ended.md',
    'memos.md',
    'skill-memos.md',
    'memo-reflection.md',
  ] as const;

  async function writeRequired(): Promise<void> {
    for (const name of REQUIRED) {
      await writeFile(path.join(directory, name), `Content of ${name}\n`, 'utf8');
    }
  }

  it('reads every required template', async () => {
    await writeRequired();
    const resources = await loadRuleResources(directory);
    expect(resources.sessionTemplate).toBe('Content of session.md\n');
    expect(resources.skillsTemplate).toBe('Content of skills.md\n');
    expect(resources.rulesTemplate).toBe('Content of user-rules.md\n');
    expect(resources.projectRulesTemplate).toBe('Content of project-rules.md\n');
    expect(resources.projectRulesEndedText).toBe('Content of project-rules-ended.md');
    expect(resources.memosTemplate).toBe('Content of memos.md\n');
    expect(resources.skillMemosTemplate).toBe('Content of skill-memos.md\n');
    expect(resources.reflectionTemplate).toBe('Content of memo-reflection.md\n');
  });

  it.each(REQUIRED)(
    'rejects when the required %s is missing, so the application does not start without it',
    async (missing) => {
      await writeRequired();
      await rm(path.join(directory, missing));
      await expect(loadRuleResources(directory)).rejects.toThrow(/ENOENT/);
    },
  );
});
