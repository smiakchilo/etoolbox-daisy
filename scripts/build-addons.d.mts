/**
 * The build script's testable parts (`scripts/build-addons.mjs`). It runs its
 * own `main` only when it is executed, so a test can import these directly.
 */

export interface AddonContributionProblem {
  /** What is wrong with the add-on's declaration, as the build would report it. */
  readonly problem?: string;
  readonly contributions?: {
    readonly tools: readonly unknown[];
    readonly skills: readonly unknown[];
  };
}

export interface AppParsers {
  readonly contribution: Record<string, (...args: never[]) => unknown>;
  readonly frontMatter: Record<string, (...args: never[]) => unknown>;
}

export interface DeriveSkillProblem {
  readonly problem?: string;
  readonly name?: string;
  readonly description?: string;
  readonly userDescription?: string;
  readonly userInvocable?: boolean;
  readonly disableModelInvocation?: boolean;
  readonly tableOnly?: boolean;
  readonly hasScripts?: boolean;
}

export interface TakenNames {
  readonly tools: Map<string, string>;
  readonly skills: Map<string, string>;
}

export function loadAppParsers(): Promise<{
  readonly contribution: { hasRunnableScript(files: readonly string[]): boolean };
  readonly frontMatter: { parseSkillFrontMatter(markdown: string): unknown };
}>;

export function addonSkillFolders(directory: string): readonly string[];

export function deriveSkill(folder: string, name: string, parsers: unknown): DeriveSkillProblem;

export function contributionsFor(
  directory: string,
  descriptor: { readonly id: string; readonly contributes?: unknown },
  parsers: unknown,
  taken: TakenNames,
): AddonContributionProblem;

export function sourceFiles(directory: string): readonly string[];

export function inlinedInputsFrom(
  metafile: { readonly inputs?: Readonly<Record<string, unknown>> },
  directory: string,
): readonly string[];

export function identityFor(directory: string, inlinedInputs: readonly string[]): string;
