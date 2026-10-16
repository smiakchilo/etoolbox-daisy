import { defineConfig } from '@playwright/test';

// Occasional runs of the REAL built app against the REAL profile and hosts.
// Never part of `npm run test:e2e`, `npm test` or `npm run verify`:
// see docs/live-testing.md.
export default defineConfig({
  testDir: './tests/live',
  testMatch: '**/*.live.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  outputDir: 'test-results/live/artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/live/results.json' }],
    ['html', { outputFolder: 'test-results/live/html', open: 'never' }],
  ],
});
