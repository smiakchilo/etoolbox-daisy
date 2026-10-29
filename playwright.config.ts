import { defineConfig } from '@playwright/test';

export default defineConfig({
  // The application's own specs plus each add-on's, which live beside the add-on
  // (`src/addons/<id>/e2e/`) and are picked up by this one glob.
  testDir: '.',
  testMatch: ['tests/e2e/**/*.spec.ts', 'src/addons/*/e2e/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
});
