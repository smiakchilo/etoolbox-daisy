import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // An add-on's own tests live beside it (`src/addons/<id>/tests/`), so
    // deleting the add-on folder takes its tests with it.
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'src/addons/*/tests/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**', 'src/addons/*/e2e/**', 'node_modules/**'],
    environment: 'node',
  },
});
