import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * The architectural boundaries are enforced by `no-restricted-imports` blocks
 * in `eslint.config.mjs`, one per file set (`src/shared`, `src/tools`,
 * `src/agents`, `src/addons`, and the blanket app rule).
 *
 * In ESLint's flat config a **later** config for the same rule replaces the
 * earlier one instead of merging, so one new blanket block silently dropped
 * both the shared-purity and the tool-plugin boundaries - and `npm run lint`
 * stayed green, because the proof fixtures are linted with a direct, targeted
 * invocation which does not go through the layered config at all.
 *
 * These cases read the *effective, layered* config for a representative path in
 * each file set, which is exactly what `eslint .` uses. They are the regression
 * guard the fixtures cannot be.
 */

const SECURITY_SDK_PACKAGES = [
  '@github/copilot-sdk',
  '@github/copilot',
  '@openrouter/agent',
  '@openrouter/sdk',
] as const;

const ADDON_IMPORT_REGEX = '^(\\.\\./)+addons/';
const NODE_BUILTIN_GROUP = 'node:*';
const TOOL_ESCAPE_REGEX = '^\\.\\./(?!\\.\\./shared(/|$))';
const TOOL_RENDERER_ESCAPE_REGEX = '^\\.\\./\\.\\./(?!\\.\\./shared(/|$))';

interface PatternSpec {
  readonly group: readonly string[];
  readonly regex: string | undefined;
}

interface ImportRestriction {
  readonly paths: readonly string[];
  readonly patterns: readonly PatternSpec[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function readPathNames(options: unknown): string[] {
  const paths = isRecord(options) ? options['paths'] : undefined;
  if (!Array.isArray(paths)) return [];
  return paths.flatMap((entry: unknown) => {
    if (typeof entry === 'string') return [entry];
    const name = isRecord(entry) ? entry['name'] : undefined;
    return typeof name === 'string' ? [name] : [];
  });
}

function readPatterns(options: unknown): PatternSpec[] {
  const patterns = isRecord(options) ? options['patterns'] : undefined;
  if (!Array.isArray(patterns)) return [];
  return patterns.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const regex = entry['regex'];
    return [
      {
        group: readStrings(entry['group']),
        regex: typeof regex === 'string' ? regex : undefined,
      },
    ];
  });
}

/**
 * The part of an ESLint config document these cases read. `ESLint`'s
 * `calculateConfigForFile` is declared `Promise<any>`, so its answer is given a
 * shape at this one boundary and narrowed field by field below.
 */
interface LayeredConfig {
  readonly rules?: { readonly [ruleName: string]: unknown };
}

/** The effective `no-restricted-imports` options for one repo-relative path. */
async function restrictionFor(path: string): Promise<ImportRestriction> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const config = (await eslint.calculateConfigForFile(path)) as LayeredConfig | undefined;
  const rule = config?.rules?.['no-restricted-imports'];
  if (!Array.isArray(rule)) throw new Error(`${path}: no layered no-restricted-imports config`);
  const options: unknown = (rule as readonly unknown[])[1];
  return { paths: readPathNames(options), patterns: readPatterns(options) };
}

function hasPattern(restriction: ImportRestriction, regex: string): boolean {
  return restriction.patterns.some((pattern) => pattern.regex === regex);
}

function hasNodeBuiltinGroup(restriction: ImportRestriction): boolean {
  return restriction.patterns.some((pattern) => pattern.group.includes(NODE_BUILTIN_GROUP));
}

describe('layered ESLint boundaries', () => {
  it('keeps src/shared pure (no Electron, no Node built-ins)', async () => {
    const shared = await restrictionFor('src/shared/tools/core/x.ts');

    expect(shared.paths).toContain('electron');
    expect(hasNodeBuiltinGroup(shared)).toBe(true);
  });

  it('keeps a tool folder a self-contained plugin', async () => {
    const tool = await restrictionFor('src/tools/aem-query/tool.ts');

    expect(hasPattern(tool, TOOL_ESCAPE_REGEX)).toBe(true);
    expect(hasNodeBuiltinGroup(tool)).toBe(true);
  });

  it("keeps a tool's renderer module on its own escape depth", async () => {
    const renderer = await restrictionFor('src/tools/aem-query/renderer/index.ts');

    expect(hasPattern(renderer, TOOL_RENDERER_ESCAPE_REGEX)).toBe(true);
  });

  it('keeps an agent folder a self-contained plugin', async () => {
    const agent = await restrictionFor('src/agents/copilot/runtime.ts');

    expect(hasPattern(agent, TOOL_ESCAPE_REGEX)).toBe(true);
  });

  it("keeps an agent's meta.ts as pure as shared code", async () => {
    const meta = await restrictionFor('src/agents/copilot/meta.ts');

    expect(meta.paths).toContain('electron');
    expect(hasNodeBuiltinGroup(meta)).toBe(true);
    expect(hasPattern(meta, TOOL_ESCAPE_REGEX)).toBe(true);
  });

  it('forbids the app core from importing an add-on', async () => {
    const main = await restrictionFor('src/main/index.ts');

    expect(hasPattern(main, ADDON_IMPORT_REGEX)).toBe(true);
  });

  it('forbids shared code and tools from importing an add-on', async () => {
    const shared = await restrictionFor('src/shared/tools/core/x.ts');
    const tool = await restrictionFor('src/tools/aem-query/tool.ts');

    expect(hasPattern(shared, ADDON_IMPORT_REGEX)).toBe(true);
    expect(hasPattern(tool, ADDON_IMPORT_REGEX)).toBe(true);
  });

  it('restricts every provider SDK outside agent folders', async () => {
    for (const path of [
      'src/main/x.ts',
      'src/renderer/x.ts',
      'src/preload/x.ts',
      'src/shared/x.ts',
      'src/tools/aem-query/tool.ts',
    ]) {
      const restriction = await restrictionFor(path);
      for (const sdk of SECURITY_SDK_PACKAGES) expect(restriction.paths).toContain(sdk);
    }
  });

  it('lets an add-on import lighthouse and puppeteer-core but not application source', async () => {
    const addon = await restrictionFor('src/addons/page-audit/index.ts');

    expect(addon.paths).not.toContain('lighthouse');
    expect(addon.paths).not.toContain('puppeteer-core');
    expect(addon.paths).toContain('electron');
    expect(hasPattern(addon, TOOL_ESCAPE_REGEX)).toBe(true);
  });
});
