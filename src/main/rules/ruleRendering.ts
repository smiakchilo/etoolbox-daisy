import type { LoadedRule } from './ruleStore';

/** Where the rules go in `resources/rules/user-rules.md` and `project-rules.md`. */
export const RULES_PLACEHOLDER = '{{rules}}';

/** Where the project's label goes in `resources/rules/project-rules.md`. */
export const PROJECT_PLACEHOLDER = '{{project}}';

function renderRuleList(rules: readonly LoadedRule[]): string {
  return rules.map((rule) => `### ${rule.name}\n\n${rule.body}`).join('\n\n');
}

function requireOnce(template: string, placeholder: string): void {
  if (template.split(placeholder).length !== 2) {
    throw new Error(`The rules template must contain exactly one ${placeholder}`);
  }
}

/**
 * The block appended to the session instructions for the user's generic rules
 * (`resources/rules/user-rules.md`); `""` when there are none. A template without
 * its one {@link RULES_PLACEHOLDER} throws even when there are no rules, so a
 * broken resource is found at startup rather than the day a rule is added.
 */
export function renderGenericRules(template: string, rules: readonly LoadedRule[]): string {
  requireOnce(template, RULES_PLACEHOLDER);
  if (rules.length === 0) return '';
  return template.replace(RULES_PLACEHOLDER, () => renderRuleList(rules)).trim();
}

/**
 * The block put before a prompt for the rules of one project
 * (`resources/rules/project-rules.md`); `""` when the project has none. The
 * project label is substituted around the rules, never inside them, so a rule
 * that happens to contain a placeholder is left as written.
 */
export function renderProjectRules(
  template: string,
  project: string,
  rules: readonly LoadedRule[],
): string {
  requireOnce(template, RULES_PLACEHOLDER);
  requireOnce(template, PROJECT_PLACEHOLDER);
  if (rules.length === 0) return '';
  const [before = '', after = ''] = template.split(RULES_PLACEHOLDER);
  const withProject = (part: string): string => part.replaceAll(PROJECT_PLACEHOLDER, () => project);
  return `${withProject(before)}${renderRuleList(rules)}${withProject(after)}`.trim();
}
