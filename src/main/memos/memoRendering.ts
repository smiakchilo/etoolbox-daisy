import type { LoadedMemo } from './memoStore';

/** Where the memos go in `resources/rules/memos.md` and `skill-memos.md`. */
export const MEMOS_PLACEHOLDER = '{{memos}}';

/** Where the observed problems go in `resources/rules/memo-reflection.md`. */
export const SIGNALS_PLACEHOLDER = '{{signals}}';

function requireOnce(template: string, placeholder: string): void {
  if (template.split(placeholder).length !== 2) {
    throw new Error(`The memo template must contain exactly one ${placeholder}`);
  }
}

function renderMemoList(memos: readonly LoadedMemo[]): string {
  return memos.map((memo) => `### ${memo.title}\n\n${memo.body}`).join('\n\n');
}

function fill(template: string, placeholder: string, value: string): string {
  // A function replacement, so a `$&` in a hand-edited memo is kept as written.
  return template
    .replace(placeholder, () => value)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The memo guidance with the generic memos (`resources/rules/memos.md`). The
 * guidance is returned even with no memos, because it is what tells the model
 * when to write one. A template without its one {@link MEMOS_PLACEHOLDER} throws.
 */
export function renderGenericMemos(template: string, memos: readonly LoadedMemo[]): string {
  requireOnce(template, MEMOS_PLACEHOLDER);
  return fill(template, MEMOS_PLACEHOLDER, renderMemoList(memos));
}

/**
 * One skill's memos, framed by `resources/rules/skill-memos.md`, appended to
 * that skill's activation; `""` when the skill has none.
 */
export function renderSkillMemos(template: string, memos: readonly LoadedMemo[]): string {
  requireOnce(template, MEMOS_PLACEHOLDER);
  if (memos.length === 0) return '';
  return fill(template, MEMOS_PLACEHOLDER, renderMemoList(memos));
}

/** The post-turn reflection prompt (`resources/rules/memo-reflection.md`), one bullet per signal. */
export function renderReflectionPrompt(template: string, signals: readonly string[]): string {
  requireOnce(template, SIGNALS_PLACEHOLDER);
  return fill(template, SIGNALS_PLACEHOLDER, signals.map((signal) => `- ${signal}`).join('\n'));
}
