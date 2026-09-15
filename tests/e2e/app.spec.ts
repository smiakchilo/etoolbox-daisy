import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');

test.describe('EToolbox Daisy skeleton', () => {
  test('opens a window, renders a Spectrum button, exposes app info, and grants no Node access', async () => {
    const app = await electron.launch({ args: [mainEntry] });

    try {
      const window = await app.firstWindow();
      await window.waitForSelector('#daisy-hello-button');

      const buttonText = await window.locator('#daisy-hello-button').innerText();
      expect(buttonText).toContain('EToolbox Daisy skeleton');

      // The real security check: the renderer must have zero Node access,
      // even though contextIsolation + sandbox are on and a preload script
      // ran. `require`/`process` must be entirely undefined in page context.
      const nodeAccess = await window.evaluate(() => ({
        hasRequire: typeof (globalThis as unknown as { require?: unknown }).require,
        hasProcess: typeof (globalThis as unknown as { process?: unknown }).process,
      }));
      expect(nodeAccess.hasRequire).toBe('undefined');
      expect(nodeAccess.hasProcess).toBe('undefined');

      // The versioned preload bridge must still work despite the isolation
      // above: it round-trips through IPC and shared Zod validation.
      await window.waitForSelector('#daisy-app-info');
      const appInfoText = await window.locator('#daisy-app-info').innerText();
      expect(appInfoText).toContain('EToolbox Daisy');
    } finally {
      await app.close();
    }
  });
});
