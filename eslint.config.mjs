import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const tsconfigRootDir = import.meta.dirname;

const appTsconfigs = [
  './tsconfig.agent.json',
  './tsconfig.main.json',
  './tsconfig.preload.json',
  './tsconfig.renderer.json',
  './tsconfig.test.json',
  './tsconfig.shared.json',
];

// Rule 1 (all app code except agent folders, `src/agents/<name>/`): the
// provider SDKs may only be imported from an agent folder, per
// docs/implementation-plan.md ("Import the SDK only through the agent adapter").
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
    ],
    patterns: [
      {
        group: ['node:*'],
        message: 'src/shared must not import Node built-ins.',
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
      'electron.vite.aem-preload.config.ts',
      'scripts/**',
      'vitest.config.ts',
      'playwright.config.ts',
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
      'electron.vite.aem-preload.config.ts',
      'scripts/**/*.ts',
      'scripts/**/*.mjs',
      'vitest.config.ts',
      'playwright.config.ts',
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
    // A tool's non-renderer code runs in main and is shared with the renderer
    // and tests: same purity as src/shared, plus the plugin boundary.
    files: ['src/tools/**/*.ts'],
    ignores: ['src/tools/*/renderer/**'],
    rules: {
      'no-restricted-imports': toolTopLevelRestriction,
      'no-restricted-globals': sharedGlobalsRestriction,
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
);
