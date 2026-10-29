import js from '@eslint/js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import tseslint from 'typescript-eslint';

const tsconfigRootDir = import.meta.dirname;

const addonsRoot = join(tsconfigRootDir, 'src', 'addons');

/**
 * Every dependency an add-on declares, read from the add-ons' own
 * `package.json` files at config load. Nothing here names a dependency: an
 * add-on's third-party libraries belong to that add-on (they are downloaded with
 * it and are not part of the application), so importing one anywhere else is the
 * defect the rule below names - for whatever library an add-on adds tomorrow.
 */
function addonDependencyNames() {
  if (!existsSync(addonsRoot)) return [];
  const names = new Set();
  for (const entry of readdirSync(addonsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(addonsRoot, entry.name, 'package.json');
    if (!existsSync(file)) continue;
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      for (const name of Object.keys(pkg.dependencies ?? {})) names.add(name);
    } catch {
      // A malformed add-on package.json is the build's to report, not lint's.
    }
  }
  return [...names].sort();
}

const ADDON_DEPENDENCIES = addonDependencyNames();

/** An add-on's own libraries, forbidden everywhere outside an add-on folder. */
const addonDependencyPaths = ADDON_DEPENDENCIES.map((name) => ({
  name,
  message: `${name} belongs to an add-on; import it only inside that add-on's folder (src/addons/<id>/).`,
}));

const appTsconfigs = [
  './tsconfig.addons.json',
  './tsconfig.agent.json',
  './tsconfig.main.json',
  './tsconfig.preload.json',
  './tsconfig.renderer.json',
  './tsconfig.test.json',
  './tsconfig.shared.json',
];

// Rule 1 (all app code except agent and add-on folders, `src/agents/<name>/`
// and `src/addons/<name>/`): the provider SDKs may only be imported from an
// agent folder, per docs/implementation-plan.md ("Import the SDK only through
// the agent adapter"). An add-on's own dependencies belong to that add-on for
// the same reason: they are downloaded with it and are not part of the
// application. Both lists are driven by data (the agent folder, each add-on's
// package.json), so a new provider or add-on needs no edit here.
//
// The add-on pattern is folded in here rather than given its own blanket config
// block: in ESLint's flat config a later `no-restricted-imports` *replaces* an
// earlier one, so a separate `src/**` block would silently drop the
// shared-purity and tool/agent plugin boundaries those blocks install.
const sdkOutsideAgentRestriction = [
  'error',
  {
    paths: [
      {
        name: '@github/copilot-sdk',
        message: 'Import the Copilot SDK only inside an agent folder (src/agents/<name>/).',
      },
      {
        name: '@github/copilot',
        message: 'Import the Copilot CLI package only inside an agent folder (src/agents/<name>/).',
      },
      {
        name: '@openrouter/agent',
        message:
          'Import the OpenRouter agent SDK only inside an agent folder (src/agents/<name>/).',
      },
      {
        name: '@openrouter/sdk',
        message: 'Import the OpenRouter SDK only inside an agent folder (src/agents/<name>/).',
      },
      ...addonDependencyPaths,
    ],
    patterns: [
      {
        regex: '^(\\.\\./)+addons/',
        message:
          'An add-on is a downloaded plugin: only its own folder may import it (use the add-on manager).',
      },
    ],
  },
];

// Rule 6 (`src/addons/<name>/`): an add-on has no application source beside it
// when it runs - it is downloaded to %LOCALAPPDATA% - so it may import only its
// own files and src/shared, and it may import Electron *types* only (the
// application supplies the live objects). Its own runtime dependencies are
// allowed.
const addonRestriction = [
  'error',
  {
    paths: [
      {
        name: 'electron',
        allowTypeImports: true,
        message:
          'An add-on may import Electron types only; the application supplies the live objects.',
      },
    ],
    patterns: [
      {
        regex: '^\\.\\./(?!\\.\\./shared(/|$))',
        message:
          'An add-on may import only its own files and src/shared - not the application or a sibling add-on.',
      },
    ],
  },
];

// An add-on's tests live one level deeper (`src/addons/<id>/tests/`), where
// `src/shared` is three `../` away and the shared test helpers four. They may
// reach only those: the add-on's own files, `src/shared` and `tests/support`.
const addonTestRestriction = [
  'error',
  {
    paths: [
      {
        name: 'electron',
        allowTypeImports: true,
        message:
          'An add-on may import Electron types only; the application supplies the live objects.',
      },
    ],
    patterns: [
      {
        regex: '^(?:\\.\\./){3}(?!\\.\\./)(?!shared(?:/|$))',
        message: `An add-on's tests may import only its own files, src/shared and tests/support.`,
      },
      {
        regex: '^(?:\\.\\./){4}(?!\\.\\./)(?!tests/support(?:/|$))',
        message: `An add-on's tests may import only its own files, src/shared and tests/support.`,
      },
      {
        regex: '^(?:\\.\\./){5,}',
        message: `An add-on's tests may import only its own files, src/shared and tests/support.`,
      },
    ],
  },
];

// Rule 2 (src/shared only, superset of rule 1): shared DTOs/schemas must not
// import Electron, Node built-ins, or the SDK, so they stay usable from any
// process (main, preload, renderer, tests) without pulling in privileged APIs.
const sharedPurityRestriction = [
  'error',
  {
    paths: [
      { name: 'electron', message: 'src/shared must not import Electron.' },
      {
        name: '@github/copilot-sdk',
        message: 'src/shared must not import the Copilot SDK; it belongs only in an agent folder.',
      },
      {
        name: '@github/copilot',
        message:
          'src/shared must not import the Copilot CLI package; it belongs only in an agent folder.',
      },
      {
        name: '@openrouter/agent',
        message:
          'src/shared must not import the OpenRouter SDK; it belongs only in an agent folder.',
      },
      {
        name: '@openrouter/sdk',
        message:
          'src/shared must not import the OpenRouter SDK; it belongs only in an agent folder.',
      },
      ...addonDependencyPaths,
    ],
    patterns: [
      {
        group: ['node:*'],
        message: 'src/shared must not import Node built-ins.',
      },
      {
        regex: '^(\\.\\./)+addons/',
        message:
          'An add-on is a downloaded plugin: only its own folder may import it (use the add-on manager).',
      },
    ],
  },
];

// Rule 3 (src/shared only): `tsconfig.shared.json` enables the `DOM` lib so
// that universal WHATWG types (`URL`, `AbortSignal`) resolve. That lib also
// declares genuinely browser-only globals, which would silently compile inside
// shared code and then explode in the main process. Ban them by name so the
// "usable from any process" guarantee is enforced, not merely documented.
// Node-only globals are listed too: they are not in shared's lib today, but
// they would become available the moment someone added `types: ["node"]`.
const sharedGlobalsRestriction = [
  'error',
  ...[
    'window',
    'document',
    'navigator',
    'location',
    'history',
    'localStorage',
    'sessionStorage',
    'alert',
    'confirm',
    'prompt',
    'process',
    '__dirname',
    '__filename',
    'require',
    'global',
    'Buffer',
  ].map((name) => ({
    name,
    message: `src/shared must not use \`${name}\`; it is not available in every process.`,
  })),
];

// Rule 4 (src/tools/<name>/): a tool folder is a plugin. It may import the
// shared kit (src/shared) and its own files - never the app (src/main,
// src/agents, src/renderer, src/preload), never Electron, Node or the SDK, and
// never another tool, so deleting any one folder cannot break another. (Agent
// folders, `src/agents/<name>/`, follow the same shape - see rule 5.) The
// regexes are relative-path shapes: at a tool folder's top level `../../shared`
// is the only permitted way out; inside `renderer/` `../` (the tool's own
// files) and `../../../shared` are.
const toolBoundaryPaths = sharedPurityRestriction[1].paths;
const toolBoundaryNodePattern = sharedPurityRestriction[1].patterns;
const pluginRestriction = (escape, noun) => [
  'error',
  {
    paths: toolBoundaryPaths,
    patterns: [
      ...toolBoundaryNodePattern,
      {
        regex: escape,
        message: `${noun} may import only its own files and src/shared - not the app or a sibling plugin.`,
      },
    ],
  },
];
const toolTopLevelRestriction = pluginRestriction(
  '^\\.\\./(?!\\.\\./shared(/|$))',
  'A tool folder',
);
const toolRendererRestriction = pluginRestriction(
  '^\\.\\./\\.\\./(?!\\.\\./shared(/|$))',
  'A tool folder',
);
// Rule 5 (src/agents/<name>/): an agent folder is a plugin too. Its `meta.ts`
// is shared code (pure, SDK-free - the renderer imports it) and gets the tool
// rule; the rest of the folder runs in main, so Electron, Node and the SDK are
// allowed, but it may still reach only its own files and src/shared - never
// src/main or a sibling agent - so deleting the folder cannot break another.
const agentMetaRestriction = pluginRestriction('^\\.\\./(?!\\.\\./shared(/|$))', 'An agent folder');
const agentRestriction = [
  'error',
  {
    patterns: [
      {
        regex: '^\\.\\./(?!\\.\\./shared(/|$))',
        message:
          'An agent folder may import only its own files and src/shared - not the app or another agent.',
      },
    ],
  },
];

/**
 * The same boundary for a folder nested one level inside an agent
 * (`src/agents/<name>/<sub>/`), where `src/shared` is one `../` further away:
 * one `../` stays inside the agent, two would be a sibling agent, three reach
 * `src` - and there only `shared` is allowed. A second level of nesting needs
 * its own entry here, which is deliberate: it keeps the rule exact rather than
 * "anything goes below two levels".
 */
const agentNestedRestriction = [
  'error',
  {
    patterns: [
      {
        regex: '^(?:\\.\\./){2}(?!\\.\\./shared(?:/|$))',
        message:
          'An agent folder may import only its own files and src/shared - not the app or another agent.',
      },
    ],
  },
];
const nodeOnlyGlobals = ['process', '__dirname', '__filename', 'require', 'global', 'Buffer'];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      '.tsc-out/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      // Intentional rule-violation fixtures: proven with a direct,
      // non-default `eslint --no-ignore` invocation, never part of `eslint .`.
      'tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    ignores: [
      'electron.vite.config.ts',
      'electron.vite.webview-preload.config.ts',
      'scripts/**',
      'vitest.config.ts',
      'playwright.config.ts',
      'playwright.live.config.ts',
      'tests/fixtures/**',
    ],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir,
        project: appTsconfigs,
      },
    },
    rules: {
      'no-restricted-imports': sdkOutsideAgentRestriction,
    },
  },
  {
    // Root tooling configs and the ESLint-violation fixtures below: real
    // TypeScript files that are not (and must not be) part of any app
    // tsconfig's `include`, so they are linted without type information.
    files: [
      'electron.vite.config.ts',
      'electron.vite.webview-preload.config.ts',
      'scripts/**/*.ts',
      'scripts/**/*.mjs',
      'install/**/*.mjs',
      'vitest.config.ts',
      'playwright.config.ts',
      'playwright.live.config.ts',
      'tests/fixtures/**/*.ts',
    ],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      // These run under Node (the icon generator prints its result). The
      // typed app configs get `console`/`process` from their Node types.
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': sharedPurityRestriction,
      'no-restricted-globals': sharedGlobalsRestriction,
    },
  },
  {
    // An add-on's non-renderer code runs in main and is shared with the
    // renderer and tests: same purity as src/shared, plus the plugin boundary.
    files: ['src/tools/**/*.ts'],
    ignores: ['src/tools/*/renderer/**'],
    rules: {
      'no-restricted-imports': toolTopLevelRestriction,
      'no-restricted-globals': sharedGlobalsRestriction,
    },
  },
  {
    // An add-on folder is a plugin with no application source beside it.
    files: ['src/addons/**/*.ts'],
    rules: {
      'no-restricted-imports': addonRestriction,
    },
  },
  {
    // An add-on's own tests and E2E specs, one level deeper than its sources.
    files: ['src/addons/*/tests/**/*.ts', 'src/addons/*/e2e/**/*.ts'],
    rules: {
      'no-restricted-imports': addonTestRestriction,
    },
  },
  {
    // A tool's renderer module runs in the renderer: DOM types are fine, Node is not.
    files: ['src/tools/*/renderer/**/*.ts'],
    rules: {
      'no-restricted-imports': toolRendererRestriction,
      'no-restricted-globals': [
        'error',
        ...nodeOnlyGlobals.map((name) => ({
          name,
          message: `A tool renderer must not use \`${name}\`; it runs in the renderer.`,
        })),
      ],
    },
  },
  {
    // Agent folders are the only place allowed to import an SDK/CLI package:
    // the blanket restriction above is replaced by the plugin boundary.
    files: ['src/agents/**/*.ts'],
    rules: {
      'no-restricted-imports': agentRestriction,
    },
  },
  {
    // A nested folder inside an agent is one `../` further from src/shared, so
    // it gets the matching boundary (see `agentNestedRestriction`).
    files: ['src/agents/*/*/**/*.ts'],
    rules: {
      'no-restricted-imports': agentNestedRestriction,
    },
  },
  {
    // An agent's `meta.ts` is shared code (the renderer imports it): same
    // purity as src/shared, plus the plugin boundary.
    files: ['src/agents/*/meta.ts'],
    rules: {
      'no-restricted-imports': agentMetaRestriction,
      'no-restricted-globals': sharedGlobalsRestriction,
    },
  },
  {
    // Proves sharedPurityRestriction fires (run directly with --no-ignore).
    files: ['tests/fixtures/eslint-violations/shared-purity-violation.ts'],
    rules: {
      'no-restricted-imports': sharedPurityRestriction,
    },
  },
  {
    // Proves sharedGlobalsRestriction fires (run directly with --no-ignore).
    files: ['tests/fixtures/eslint-violations/shared-globals-violation.ts'],
    rules: {
      'no-restricted-globals': sharedGlobalsRestriction,
    },
  },
  {
    // Proves sdkOutsideAgentRestriction fires (run directly with --no-ignore).
    files: ['tests/fixtures/eslint-violations/sdk-outside-agent-violation.ts'],
    rules: {
      'no-restricted-imports': sdkOutsideAgentRestriction,
    },
  },
  {
    // Proves the plugin boundary fires (run directly with --no-ignore).
    files: ['tests/fixtures/eslint-violations/tool-boundary-violation.ts'],
    rules: {
      'no-restricted-imports': toolTopLevelRestriction,
    },
  },
  {
    // Proves the agent-folder boundary fires (run directly with --no-ignore).
    files: ['tests/fixtures/eslint-violations/agent-boundary-violation.ts'],
    rules: {
      'no-restricted-imports': agentRestriction,
    },
  },
  {
    // Proves the add-on boundary rules fire (run directly with --no-ignore).
    files: ['tests/fixtures/eslint-violations/addon-boundary-violation.ts'],
    rules: {
      'no-restricted-imports': addonRestriction,
    },
  },
);
