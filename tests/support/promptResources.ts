import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The application's real model-facing markdown resources
 * (`resources/prompts/`), read straight from the repository so a test
 * asserts what actually ships rather than a copy of it.
 */
const PROMPTS_DIRECTORY = path.join(process.cwd(), 'resources', 'prompts');

export const REAL_SESSION_TEMPLATE = readFileSync(
  path.join(PROMPTS_DIRECTORY, 'session.md'),
  'utf8',
);

export const REAL_SKILLS_TEMPLATE = readFileSync(path.join(PROMPTS_DIRECTORY, 'skills.md'), 'utf8');

export const REAL_RULES_TEMPLATE = readFileSync(path.join(PROMPTS_DIRECTORY, 'rules.md'), 'utf8');

export const REAL_PROJECT_RULES_TEMPLATE = readFileSync(
  path.join(PROMPTS_DIRECTORY, 'project-rules.md'),
  'utf8',
);

/** A minimal valid session template, for tests that are not about the prose. */
export const MINIMAL_SESSION_TEMPLATE = 'Before.\n\n{{tools}}\n\nAfter.\n';
