import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontMatter } from '../../../../src/main/skills/skillFrontMatter';

/**
 * The Copilot runtime SILENTLY DROPS a skill whose front-matter `description`
 * is longer than 1024 characters (verified live 2026-10-14 with an unauthenticated
 * `skills.list()`: 1024 loads, 1025 does not - docs/compatibility.md 4.5). The
 * model then answers "that skill is not available" even to `/name`. No other
 * check notices, so every bundled skill is held to the limit here.
 */
const skillsDir = path.join(process.cwd(), 'resources', 'skills');
const RUNTIME_DESCRIPTION_LIMIT = 1024;

const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('bundled skills', () => {
  it.each(skills)('%s has a front matter the runtime will accept', (name) => {
    const parsed = parseSkillFrontMatter(
      readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'),
    );
    expect(parsed?.name).toBe(name);
    expect(parsed?.description.length).toBeGreaterThan(0);
    expect(parsed?.description.length).toBeLessThanOrEqual(RUNTIME_DESCRIPTION_LIMIT);
  });
});
