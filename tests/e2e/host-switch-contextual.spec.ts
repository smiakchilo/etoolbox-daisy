import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * The hosts picker's contextual switch, against the real built app: picking
 * another host while a page is open carries that page (path, query and
 * fragment) to the new host instead of opening the host's root.
 *
 * Two local servers stand for two AEM hosts and record every request URL, which
 * is the proof that the pane actually asked the *new* host for the *same* path
 * rather than merely repainting the address bar. The fall-back cases (a login
 * URL, re-picking the open host) and the address bar's role as the escape hatch
 * are asserted through the same request logs.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'host-switch-contextual-scratch');

interface RecordingServer {
  readonly origin: string;
  readonly requests: string[];
  readonly close: () => void;
}

async function startRecordingServer(): Promise<RecordingServer> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '/');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>echo</title><p>ok</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const declared = server.address();
  if (declared === null || typeof declared === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${String(declared.port)}`,
    requests,
    close: () => server.close(),
  };
}

test('picking a host carries the open page to it, and falls back to the root otherwise', async () => {
  test.setTimeout(150_000);

  const env = createLaunchProfile(scratchBase).env;
  const hostA = await startRecordingServer();
  const hostB = await startRecordingServer();

  const base = defaultAppSettings();
  writeSettings(
    env.USERPROFILE as string,
    appSettingsSchema.parse({
      ...base,
      hosts: [
        ...base.hosts,
        {
          id: randomUUID(),
          label: 'Host A',
          origin: hostA.origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
        {
          id: randomUUID(),
          label: 'Host B',
          origin: hostB.origin,
          color: { kind: 'swatch', swatch: 'green' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressInput = page.locator(byTestId('browser-address')).locator('input').first();
    const pickerButton = page.locator(byTestId('browser-hosts-button'));
    const itemA = page.locator(`${byTestId('hosts-item')}[data-origin="${hostA.origin}"]`);
    const itemB = page.locator(`${byTestId('hosts-item')}[data-origin="${hostB.origin}"]`);

    // A load that is still settling pushes its URL back into the address field,
    // which can overwrite a value typed a moment earlier; retry the typing until
    // the host has actually been asked for the page.
    async function typeUntilRequested(
      url: string,
      server: RecordingServer,
      expected: string,
    ): Promise<void> {
      const before = server.requests.length;
      await expect(async () => {
        await addressInput.fill(url);
        await addressInput.press('Enter');
        await expect
          .poll(() => server.requests.slice(before).includes(expected), { timeout: 4_000 })
          .toBe(true);
      }).toPass({ timeout: 30_000 });
    }

    async function pickHost(item: typeof itemA, server: RecordingServer): Promise<string> {
      const before = server.requests.length;
      await pickerButton.click();
      await expect(item).toBeVisible({ timeout: 10_000 });
      await item.click();
      await expect.poll(() => server.requests.length, { timeout: 30_000 }).toBeGreaterThan(before);
      return server.requests[before] ?? '';
    }

    // The seeded profile opens the picker at startup, with no page under it:
    // nothing to carry, so this is a plain open of the host root.
    await expect(itemA).toBeVisible({ timeout: 30_000 });
    await itemA.click();
    await expect.poll(() => hostA.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(hostA.requests[0]).toBe('/');

    // A page open on host A is carried to host B whole: path and query.
    const pagePath = '/content/acme/us/en/home.html?wcmmode=disabled';
    await typeUntilRequested(`${hostA.origin}${pagePath}`, hostA, pagePath);

    expect(await pickHost(itemB, hostB)).toBe(pagePath);
    await expect(addressInput).toHaveValue(`${hostB.origin}${pagePath}`);

    // Re-picking the host that is already open loads its root, as before.
    expect(await pickHost(itemB, hostB)).toBe('/');

    // A login URL is outside the allowlist: the picked host opens at its root.
    const loginPath = '/libs/granite/core/content/login.html?resource=%2Fcontent%2Facme';
    await typeUntilRequested(`${hostA.origin}${loginPath}`, hostA, loginPath);
    expect(await pickHost(itemB, hostB)).toBe('/');
    expect(hostB.requests).not.toContain(loginPath);

    // The address bar is the escape hatch: an origin typed over a deep page
    // opens that origin's root, with nothing carried.
    await typeUntilRequested(`${hostB.origin}${pagePath}`, hostB, pagePath);
    const aBefore = hostA.requests.length;
    await typeUntilRequested(hostA.origin, hostA, '/');
    expect(hostA.requests.slice(aBefore)).not.toContain(pagePath);
  } finally {
    await app.close();
    hostA.close();
    hostB.close();
  }
});
