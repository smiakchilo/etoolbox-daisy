import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPromptResources } from '../../../../src/main/prompts/promptResources';

describe('loadPromptResources', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'daisy-prompts-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const REQUIRED = [
    'session.md',
    'skills.md',
    'rules.md',
    'project-rules.md',
    'project-rules-ended.md',
  ] as const;

  async function writeRequired(): Promise<void> {
    for (const name of REQUIRED) {
      await writeFile(path.join(directory, name), `Content of ${name}\n`, 'utf8');
    }
  }

  it('reads every required template', async () => {
    await writeRequired();
    const resources = await loadPromptResources(directory);
    expect(resources.sessionTemplate).toBe('Content of session.md\n');
    expect(resources.skillsTemplate).toBe('Content of skills.md\n');
    expect(resources.rulesTemplate).toBe('Content of rules.md\n');
    expect(resources.projectRulesTemplate).toBe('Content of project-rules.md\n');
    expect(resources.projectRulesEndedText).toBe('Content of project-rules-ended.md');
  });

  it.each(REQUIRED)(
    'rejects when the required %s is missing, so the application does not start without it',
    async (missing) => {
      await writeRequired();
      await rm(path.join(directory, missing));
      await expect(loadPromptResources(directory)).rejects.toThrow(/ENOENT/);
    },
  );
});
