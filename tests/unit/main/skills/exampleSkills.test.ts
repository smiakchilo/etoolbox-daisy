import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontMatter } from '../../../../src/main/skills/skillFrontMatter';

/**
 * The example skills in `docs/examples/skills` are meant to be copied into the
 * user's skills folder, so they are held to the same front-matter rules as a
 * bundled skill: the store accepts them, the folder name is the skill name, the
 * description fits the runtime limit, and the displayed summary is a label.
 */
const examplesDir = path.join(process.cwd(), 'docs', 'examples', 'skills');
const RUNTIME_DESCRIPTION_LIMIT = 1024;

const examples = readdirSync(examplesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('example skills', () => {
  it('ships at least one example', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)('%s parses as a valid, table-only skill', (name) => {
    const parsed = parseSkillFrontMatter(
      readFileSync(path.join(examplesDir, name, 'SKILL.md'), 'utf8'),
    );
    expect(parsed?.name).toBe(name);
    expect(parsed?.description.length).toBeGreaterThan(0);
    expect(parsed?.description.length).toBeLessThanOrEqual(RUNTIME_DESCRIPTION_LIMIT);
    expect(parsed?.tableOnly).toBe(true);
    expect(parsed?.userDescription).not.toMatch(/[.!?]$/);
    expect(parsed?.userDescription).not.toBe('');
  });
});
