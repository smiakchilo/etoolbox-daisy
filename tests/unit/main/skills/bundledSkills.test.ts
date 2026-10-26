import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontMatter } from '../../../../src/main/skills/skillFrontMatter';

/**
 * Facts about the bundled skills in `resources/skills`, held against the files
 * themselves so a copy edit cannot silently break them.
 *
 * 1. **The runtime's description limit.** The Copilot runtime SILENTLY DROPS a
 *    skill whose front-matter `description` is longer than 1024 characters
 *    (verified live 2026-10-14 with an unauthenticated `skills.list()`: 1024
 *    loads, 1025 does not - docs/compatibility.md 4.5). The model then answers
 *    "that skill is not available" even to `/name`. No other check notices, so
 *    every bundled skill is held to the limit here.
 * 2. **The displayed summary is a label, not a sentence.** The home veil and the
 *    composer's `/` popup render a skill's user-facing summary verbatim, so it
 *    never ends with a period (AGENTS.md, "a skill's displayed description never
 *    ends with a period"). The shown text is `metadata.user-description`,
 *    falling back to the technical `description` when that is absent - the same
 *    fallback `skillStore.invocable()` applies - and only user-invocable skills
 *    are displayed at all.
 */
const skillsDir = path.join(process.cwd(), 'resources', 'skills');
const RUNTIME_DESCRIPTION_LIMIT = 1024;

const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** Every skill whose summary the home veil or the `/` popup displays, with the exact text. */
const displayedSummaries = skills.flatMap((name) => {
  const parsed = parseSkillFrontMatter(
    readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'),
  );
  if (parsed === undefined || !parsed.userInvocable) return [];
  const shown = parsed.userDescription === '' ? parsed.description : parsed.userDescription;
  return [{ name, shown }];
});

describe('bundled skills', () => {
  it.each(skills)('%s has a front matter the runtime will accept', (name) => {
    const parsed = parseSkillFrontMatter(
      readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'),
    );
    expect(parsed?.name).toBe(name);
    expect(parsed?.description.length).toBeGreaterThan(0);
    expect(parsed?.description.length).toBeLessThanOrEqual(RUNTIME_DESCRIPTION_LIMIT);
  });

  it.each(displayedSummaries)(
    '$name shows a summary that is a label, not a sentence',
    ({ shown }) => {
      expect(shown).not.toMatch(/[.!?]$/);
    },
  );

  it('flags exactly the skills whose whole answer is their table(s) as table-only', () => {
    const tableOnly = skills.filter(
      (name) =>
        parseSkillFrontMatter(readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'))
          ?.tableOnly === true,
    );
    expect(tableOnly.sort()).toEqual([
      'check-page',
      'search',
      'search-component',
      'search-page',
      'semantic-search',
    ]);
  });
});
