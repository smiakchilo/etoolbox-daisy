import { describe, expect, it } from 'vitest';
import {
  parseSkillFrontMatter,
  splitSkillMarkdown,
} from '../../../../src/main/skills/skillFrontMatter';

function frontMatter(name: string, description: string, userInvocable?: boolean): string {
  const invocable = userInvocable === undefined ? '' : `\nuser-invocable: ${String(userInvocable)}`;
  return `---\nname: ${name}\ndescription: ${description}${invocable}\n---\n\n# ${name}\n`;
}

describe('parseSkillFrontMatter', () => {
  it('reads name and description, defaulting the flags', () => {
    expect(parseSkillFrontMatter(frontMatter('choose', 'How to choose.'))).toEqual({
      name: 'choose',
      description: 'How to choose.',
      userDescription: '',
      userInvocable: true,
      disableModelInvocation: false,
    });
  });

  it('reads user-invocable: false', () => {
    expect(parseSkillFrontMatter(frontMatter('aux', 'Reading.', false))?.userInvocable).toBe(false);
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
    expect(parseSkillFrontMatter('---\nname: s\nuser-invocable: maybe\n---\n')?.userInvocable).toBe(
      true,
    );
  });

  it('reads disable-model-invocation', () => {
    const parsed = parseSkillFrontMatter('---\nname: s\ndisable-model-invocation: true\n---\n');
    expect(parsed?.disableModelInvocation).toBe(true);
  });

  it('reads quoted values', () => {
    const parsed = parseSkillFrontMatter('---\nname: "quoted"\ndescription: \'works\'\n---\n');
    expect(parsed?.name).toBe('quoted');
    expect(parsed?.description).toBe('works');
  });

  it('reads a folded and a literal block description', () => {
    const folded = parseSkillFrontMatter('---\nname: s\ndescription: >\n  one\n  two\n---\n');
    expect(folded?.description).toBe('one two');
    const literal = parseSkillFrontMatter('---\nname: s\ndescription: |\n  one\n  two\n---\n');
    expect(literal?.description).toBe('one\ntwo');
  });

  it('reads a description that contains a colon when it is quoted', () => {
    const parsed = parseSkillFrontMatter('---\nname: s\ndescription: "Use when: asked"\n---\n');
    expect(parsed?.description).toBe('Use when: asked');
  });

  it('returns an empty description when it is missing', () => {
    expect(parseSkillFrontMatter('---\nname: only-name\n---\n')?.description).toBe('');
  });

  it('returns undefined without a terminated block, a name, valid YAML or a mapping', () => {
    expect(parseSkillFrontMatter('# Just a heading\n')).toBeUndefined();
    expect(parseSkillFrontMatter('---\nname: lost\n')).toBeUndefined();
    expect(parseSkillFrontMatter('---\ndescription: no name\n---\n')).toBeUndefined();
    expect(parseSkillFrontMatter('---\nname:\n---\n')).toBeUndefined();
    expect(parseSkillFrontMatter('---\nname: [unclosed\n---\n')).toBeUndefined();
    expect(parseSkillFrontMatter('---\n- a\n- b\n---\n')).toBeUndefined();
  });

  it('ignores a name that is not a string', () => {
    expect(parseSkillFrontMatter('---\nname: 42\n---\n')).toBeUndefined();
  });

  it('tolerates CRLF line endings and a byte-order mark', () => {
    expect(
      parseSkillFrontMatter('---\r\nname: crlf\r\ndescription: fine\r\n---\r\n')?.description,
    ).toBe('fine');
    expect(parseSkillFrontMatter('\ufeff---\nname: bom\n---\n')?.name).toBe('bom');
  });

  it('reads the user description from metadata, then from the top level', () => {
    const nested = parseSkillFrontMatter(
      '---\nname: s\ndescription: Technical.\nmetadata:\n  user-description: Friendly.\n  version: 1\n---\n',
    );
    expect(nested?.userDescription).toBe('Friendly.');
    expect(nested?.description).toBe('Technical.');
    expect(
      parseSkillFrontMatter('---\nname: s\nuser-description: Top.\n---\n')?.userDescription,
    ).toBe('Top.');
  });

  it('ignores allowed-tools and unknown keys', () => {
    const parsed = parseSkillFrontMatter(
      '---\nname: s\ndescription: d\nallowed-tools: Bash\nwhatever: 1\n---\n',
    );
    expect(parsed).toEqual({
      name: 's',
      description: 'd',
      userDescription: '',
      userInvocable: true,
      disableModelInvocation: false,
    });
  });
});

describe('splitSkillMarkdown', () => {
  it('returns the body after the front matter without its leading blank line', () => {
    const split = splitSkillMarkdown('---\nname: s\n---\n\n# Title\n\ntext\n');
    expect(split?.body).toBe('# Title\n\ntext\n');
  });

  it('returns undefined when the block is absent', () => {
    expect(splitSkillMarkdown('plain')).toBeUndefined();
  });
});
