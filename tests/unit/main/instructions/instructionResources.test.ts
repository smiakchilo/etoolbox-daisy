import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadInstructionResources } from '../../../../src/main/instructions/instructionResources';

describe('loadInstructionResources', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'daisy-instructions-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeRequired(): Promise<void> {
    await writeFile(path.join(directory, 'session.md'), 'Session {{tools}}', 'utf8');
    await writeFile(path.join(directory, 'skills.md'), 'Skills {{catalogue}}', 'utf8');
  }

  it('reads the two required templates', async () => {
    await writeRequired();
    const resources = await loadInstructionResources(directory);
    expect(resources.sessionTemplate).toBe('Session {{tools}}');
    expect(resources.skillsTemplate).toBe('Skills {{catalogue}}');
  });

  it.each(['session.md', 'skills.md'])(
    'rejects when the required %s is missing, so the application does not start without it',
    async (missing) => {
      await writeRequired();
      await rm(path.join(directory, missing));
      await expect(loadInstructionResources(directory)).rejects.toThrow(/ENOENT/);
    },
  );
});
