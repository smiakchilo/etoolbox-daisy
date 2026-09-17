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

// Rule 1 (all app code except src/agent): the Copilot SDK/CLI packages may
// only be imported through the future adapter in `src/agent`, per
// docs/implementation-plan.md ("Import the SDK only through `src/agent`").
const sdkOutsideAgentRestriction = [
  'error',
  {
    paths: [
      {
        name: '@github/copilot-sdk',
        message: 'Import the Copilot SDK only inside src/agent (step 02+).',
      },
      {
        name: '@github/copilot',
        message: 'Import the Copilot CLI package only inside src/agent (step 02+).',
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
        message: 'src/shared must not import the Copilot SDK; it belongs only in src/agent.',
      },
      {
        name: '@github/copilot',
        message:
          'src/shared must not import the Copilot CLI package; it belongs only in src/agent.',
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
      'build/**',
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
      'build/**/*.ts',
      'vitest.config.ts',
      'playwright.config.ts',
      'tests/fixtures/**/*.ts',
    ],
    extends: [...tseslint.configs.recommended],
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': sharedPurityRestriction,
      'no-restricted-globals': sharedGlobalsRestriction,
    },
  },
  {
    // src/agent is the one place allowed to import the SDK/CLI packages -
    // undo the blanket restriction applied to "**/*.ts" above.
    files: ['src/agent/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
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
);
