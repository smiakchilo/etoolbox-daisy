import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The model-facing prose the application ships as markdown, so it reads as text
 * in the repository instead of as string constants:
 *
 *  - `session.md` - the always-on session instructions, with one `{{tools}}`
 *    placeholder where the enabled tools' paragraphs go
 *    (`composeAssistantInstructions`);
 *  - `skills.md` - the preamble of the skill catalogue, with `{{skillTool}}`
 *    and `{{catalogue}}` placeholders (`renderSkillCatalogue`);
 *  - `user-rules.md` - the framing of the user's generic rules, with one `{{rules}}`
 *    placeholder;
 *  - `project-rules.md` - the framing of a project's rules, with `{{project}}`
 *    and `{{rules}}` placeholders;
 *  - `project-rules-ended.md` - the note telling the model that the project
 *    rules it was given no longer apply;
 *  - `memos.md` - the memo guidance and the generic memos, with one `{{memos}}`
 *    placeholder (`renderGenericMemos`);
 *  - `skill-memos.md` - the framing of one skill's memos, with one `{{memos}}`
 *    placeholder (`renderSkillMemos`);
 *  - `memo-reflection.md` - the post-turn reflection prompt, with one
 *    `{{signals}}` placeholder (`renderReflectionPrompt`).
 *
 * The directory is the application's own `resources/rules` (resolved by
 * `resolveBundledResourcesDirectory`), never a user, project or host location
 * (the user's own rules live in `appPaths.rules`). Every file is required: the
 * session instructions carry the read-only policy, so a missing file rejects
 * here and the application does not start without it.
 */
export interface RuleResources {
  readonly sessionTemplate: string;
  readonly skillsTemplate: string;
  readonly rulesTemplate: string;
  readonly projectRulesTemplate: string;
  readonly projectRulesEndedText: string;
  readonly memosTemplate: string;
  readonly skillMemosTemplate: string;
  readonly reflectionTemplate: string;
}

export async function loadRuleResources(directory: string): Promise<RuleResources> {
  const read = (name: string): Promise<string> => readFile(path.join(directory, name), 'utf8');
  const [
    sessionTemplate,
    skillsTemplate,
    rulesTemplate,
    projectRulesTemplate,
    projectRulesEndedText,
    memosTemplate,
    skillMemosTemplate,
    reflectionTemplate,
  ] = await Promise.all([
    read('session.md'),
    read('skills.md'),
    read('user-rules.md'),
    read('project-rules.md'),
    read('project-rules-ended.md'),
    read('memos.md'),
    read('skill-memos.md'),
    read('memo-reflection.md'),
  ]);
  return {
    sessionTemplate,
    skillsTemplate,
    rulesTemplate,
    projectRulesTemplate,
    projectRulesEndedText: projectRulesEndedText.trim(),
    memosTemplate,
    skillMemosTemplate,
    reflectionTemplate,
  };
}
