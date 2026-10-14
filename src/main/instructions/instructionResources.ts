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
 *    and `{{catalogue}}` placeholders (`renderSkillCatalogue`).
 *
 * The directory is the application's own `resources/instructions` (resolved by
 * `resolveBundledResourcesDirectory`), never a user, project or AEM location.
 * Both files are required: the session instructions carry the read-only policy,
 * so a missing file rejects here and the application does not start without it.
 */
export interface InstructionResources {
  readonly sessionTemplate: string;
  readonly skillsTemplate: string;
}

export async function loadInstructionResources(directory: string): Promise<InstructionResources> {
  const [sessionTemplate, skillsTemplate] = await Promise.all([
    readFile(path.join(directory, 'session.md'), 'utf8'),
    readFile(path.join(directory, 'skills.md'), 'utf8'),
  ]);
  return { sessionTemplate, skillsTemplate };
}
