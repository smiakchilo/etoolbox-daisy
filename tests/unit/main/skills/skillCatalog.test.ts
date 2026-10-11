import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSkillCatalog,
  parseSkillFrontMatter,
  readSkillCatalog,
} from '../../../../src/main/skills/skillCatalog';

function frontMatter(name: string, description: string, userInvocable?: boolean): string {
  const invocable = userInvocable === undefined ? '' : `\nuser-invocable: ${String(userInvocable)}`;
  return `---\nname: ${name}\ndescription: ${description}${invocable}\n---\n\n# ${name}\n`;
}

function makeSkillsDir(files: Record<string, string | null>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'daisy-skills-'));
  for (const [skillName, contents] of Object.entries(files)) {
    const dir = path.join(root, skillName);
    mkdirSync(dir, { recursive: true });
    // `null` means "a directory with no SKILL.md at all".
    if (contents !== null) writeFileSync(path.join(dir, 'SKILL.md'), contents, 'utf8');
  }
  return root;
}

describe('parseSkillFrontMatter', () => {
  it('reads name and description from the leading block, defaulting userInvocable to true', () => {
    expect(parseSkillFrontMatter(frontMatter('aem-tool-selection', 'How to choose.'))).toEqual({
      name: 'aem-tool-selection',
      description: 'How to choose.',
      userDescription: '',
      userInvocable: true,
    });
  });

  it('reads user-invocable: false', () => {
    expect(parseSkillFrontMatter(frontMatter('query-results', 'Reading results.', false))).toEqual({
      name: 'query-results',
      description: 'Reading results.',
      userDescription: '',
      userInvocable: false,
    });
  });

  it('accepts the documented boolean spellings in any case', () => {
    for (const spelling of ['true', 'yes', 'on', '1', 'TRUE', 'Yes']) {
      const parsed = parseSkillFrontMatter(`---\nname: s\nuser-invocable: ${spelling}\n---\n`);
      expect(parsed?.userInvocable).toBe(true);
    }
    for (const spelling of ['false', 'no', 'off', '0', 'FALSE', 'No']) {
      const parsed = parseSkillFrontMatter(`---\nname: s\nuser-invocable: ${spelling}\n---\n`);
      expect(parsed?.userInvocable).toBe(false);
    }
  });

  it('falls back to the default for an unrecognised boolean value', () => {
    const parsed = parseSkillFrontMatter('---\nname: s\nuser-invocable: maybe\n---\n');
    expect(parsed?.userInvocable).toBe(true);
  });

  it('strips one pair of surrounding quotes', () => {
    expect(parseSkillFrontMatter('---\nname: "quoted"\ndescription: \'works\'\n---\n')).toEqual({
      name: 'quoted',
      description: 'works',
      userDescription: '',
      userInvocable: true,
    });
  });

  it('returns an empty description when it is missing', () => {
    expect(parseSkillFrontMatter('---\nname: only-name\n---\n')).toEqual({
      name: 'only-name',
      description: '',
      userDescription: '',
      userInvocable: true,
    });
  });

  it('returns undefined when there is no leading front matter block', () => {
    expect(parseSkillFrontMatter('# Just a heading\n')).toBeUndefined();
  });

  it('returns undefined when the block is unterminated', () => {
    expect(parseSkillFrontMatter('---\nname: lost\n')).toBeUndefined();
  });

  it('returns undefined when name is absent or empty', () => {
    expect(parseSkillFrontMatter('---\ndescription: no name\n---\n')).toBeUndefined();
    expect(parseSkillFrontMatter('---\nname:\n---\n')).toBeUndefined();
  });

  it('tolerates CRLF line endings', () => {
    expect(parseSkillFrontMatter('---\r\nname: crlf\r\ndescription: fine\r\n---\r\n')).toEqual({
      name: 'crlf',
      description: 'fine',
      userDescription: '',
      userInvocable: true,
    });
  });

  it('reads a user-friendly summary from a nested metadata.user-description', () => {
    const parsed = parseSkillFrontMatter(
      '---\nname: s\ndescription: Technical.\nmetadata:\n  user-description: Friendly.\n  version: 1\n---\n',
    );
    expect(parsed?.userDescription).toBe('Friendly.');
    // The model-facing description is untouched.
    expect(parsed?.description).toBe('Technical.');
  });

  it('also accepts a top-level user-description', () => {
    const parsed = parseSkillFrontMatter('---\nname: s\nuser-description: Friendly.\n---\n');
    expect(parsed?.userDescription).toBe('Friendly.');
  });

  it('closes the metadata block at the next top-level field', () => {
    const parsed = parseSkillFrontMatter(
      '---\nname: s\nmetadata:\n  user-description: Friendly.\nuser-invocable: false\n---\n',
    );
    expect(parsed?.userDescription).toBe('Friendly.');
    expect(parsed?.userInvocable).toBe(false);
  });
});

describe('readSkillCatalog', () => {
  it('reads every user-invocable directory with valid front matter, sorted by name', async () => {
    const dir = makeSkillsDir({
      'z-last': frontMatter('z-last', 'Last.'),
      'a-first': frontMatter('a-first', 'First.'),
    });

    expect(await readSkillCatalog(dir)).toEqual([
      { name: 'a-first', description: 'First.' },
      { name: 'z-last', description: 'Last.' },
    ]);
  });

  it('omits a skill marked user-invocable: false', async () => {
    const dir = makeSkillsDir({
      search: frontMatter('search', 'Interactive.'),
      'aem-tool-selection': frontMatter('aem-tool-selection', 'Auxiliary.', false),
    });

    expect((await readSkillCatalog(dir)).map((skill) => skill.name)).toEqual(['search']);
  });

  it('reports the user-facing summary when metadata.user-description is present', async () => {
    const dir = makeSkillsDir({
      search:
        '---\nname: search\ndescription: Technical details.\nmetadata:\n  user-description: Friendly phrase.\n---\n',
    });

    expect(await readSkillCatalog(dir)).toEqual([
      { name: 'search', description: 'Friendly phrase.' },
    ]);
  });

  it('skips a directory without a SKILL.md, a file, and malformed front matter', async () => {
    const dir = makeSkillsDir({
      good: frontMatter('good', 'Kept.'),
      'no-file': null,
    });
    // A stray file at the top level must not be treated as a skill.
    writeFileSync(path.join(dir, 'README.md'), 'not a skill', 'utf8');
    // A directory whose SKILL.md has no usable front matter is skipped too.
    mkdirSync(path.join(dir, 'bad'), { recursive: true });
    writeFileSync(path.join(dir, 'bad', 'SKILL.md'), 'no front matter here', 'utf8');

    expect((await readSkillCatalog(dir)).map((skill) => skill.name)).toEqual(['good']);
  });

  it('returns an empty catalogue for a missing directory rather than throwing', async () => {
    expect(await readSkillCatalog(path.join(tmpdir(), 'daisy-does-not-exist-xyz'))).toEqual([]);
  });
});

describe('createSkillCatalog', () => {
  it('starts empty, shares one read, and exposes the loaded catalogue synchronously', async () => {
    const dir = makeSkillsDir({ only: frontMatter('only', 'The one.') });
    const catalog = createSkillCatalog(dir);

    expect(catalog.current()).toEqual([]);

    const [first, second] = await Promise.all([catalog.load(), catalog.load()]);
    expect(first).toEqual([{ name: 'only', description: 'The one.' }]);
    // The single-flight read hands every concurrent caller the same result.
    expect(second).toBe(first);
    expect(catalog.current()).toEqual([{ name: 'only', description: 'The one.' }]);
  });

  it('caches the loaded catalogue, so a later load does not re-read the disk', async () => {
    const dir = makeSkillsDir({ only: frontMatter('only', 'The one.') });
    const catalog = createSkillCatalog(dir);

    const first = await catalog.load();
    // Mutating the directory after the read must not change the cached answer.
    writeFileSync(path.join(dir, 'only', 'SKILL.md'), frontMatter('changed', 'New.'), 'utf8');

    expect(await catalog.load()).toBe(first);
  });

  it('exposes a model catalogue of every skill, using the technical description', async () => {
    const dir = makeSkillsDir({
      search:
        '---\nname: search\ndescription: Technical search guidance.\nmetadata:\n  user-description: Find things.\n---\n',
      'query-results': frontMatter('query-results', 'Reading results.', false),
    });
    const catalog = createSkillCatalog(dir);

    // Nothing is known before the one read lands.
    expect(catalog.modelCatalogue()).toEqual([]);
    await catalog.load();

    // Both skills are in the model catalogue (the auxiliary one included), and
    // the model sees the technical description, not the user-facing summary.
    expect(catalog.modelCatalogue()).toEqual([
      { name: 'query-results', description: 'Reading results.' },
      { name: 'search', description: 'Technical search guidance.' },
    ]);
    // The composer's catalogue still omits the auxiliary skill and shows the
    // user-facing summary.
    expect(catalog.current()).toEqual([{ name: 'search', description: 'Find things.' }]);
  });

  it('falls back to the user description for a model entry with no technical one', async () => {
    const dir = makeSkillsDir({
      only: '---\nname: only\nmetadata:\n  user-description: A friendly phrase.\n---\n',
    });
    const catalog = createSkillCatalog(dir);
    await catalog.load();
    expect(catalog.modelCatalogue()).toEqual([{ name: 'only', description: 'A friendly phrase.' }]);
  });

  it('reports an empty model catalogue when the read fails', async () => {
    const catalog = createSkillCatalog(path.join(tmpdir(), 'daisy-does-not-exist-xyz'));
    await catalog.load();
    expect(catalog.modelCatalogue()).toEqual([]);
  });
});
