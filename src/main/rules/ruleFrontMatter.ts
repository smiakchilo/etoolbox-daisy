import { parse } from 'yaml';
import { splitSkillMarkdown } from '../skills/skillFrontMatter';

/**
 * Reads a rule file: optional front matter whose only key is `project` (a
 * label or a list of labels), then the rule's text.
 *
 * A rule with no `project` is generic. A mistyped scope must never leak a
 * project's rule into every session, so anything that looks like an attempt at
 * front matter but cannot be read is a rejection, not a generic rule: an
 * opening `---` with no closing one, invalid YAML, a `project` that is neither
 * a string nor a list of strings, or an empty one. Every other key is ignored.
 */

export type ParsedRule =
  | {
      readonly ok: true;
      /** Normalized project labels (trimmed, lower-case); empty for a generic rule. */
      readonly projects: readonly string[];
      readonly body: string;
    }
  | { readonly ok: false; readonly reason: string };

/** How a project label is compared: trimmed and case-insensitive. */
export function normalizeProjectLabel(label: string): string {
  return label.trim().toLowerCase();
}

function readProjects(value: unknown): readonly string[] | undefined {
  const items = Array.isArray(value) ? (value as unknown[]) : [value];
  const labels: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') return undefined;
    const label = normalizeProjectLabel(item);
    if (label === '') return undefined;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length === 0 ? undefined : labels;
}

export function parseRuleMarkdown(markdown: string): ParsedRule {
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const split = splitSkillMarkdown(text);
  if (split === undefined) {
    if (text.split(/\r?\n/)[0]?.trim() === '---') {
      return { ok: false, reason: 'The front matter is not closed.' };
    }
    return { ok: true, projects: [], body: text.trim() };
  }

  let document: unknown;
  try {
    document = parse(split.frontMatter);
  } catch {
    return { ok: false, reason: 'The front matter is not valid YAML.' };
  }
  const body = split.body.trim();
  if (document === null || document === undefined) return { ok: true, projects: [], body };
  if (typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, reason: 'The front matter is not a mapping.' };
  }

  const project = (document as Record<string, unknown>)['project'];
  if (project === undefined) return { ok: true, projects: [], body };
  const projects = readProjects(project);
  if (projects === undefined) {
    return { ok: false, reason: 'The project must be a label or a list of labels.' };
  }
  return { ok: true, projects, body };
}
