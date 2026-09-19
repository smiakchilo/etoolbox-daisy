import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * The address bar displays the full current URL, so it must also ACCEPT one.
 * Before this was fixed it did not: the navigation path reused `parseOrigin`,
 * which exists to guard what may be stored as a *server setting* and therefore
 * rejects any path. A user could copy the URL the app was showing them, paste
 * it straight back, and be told "not a valid address" - while pasting a deep
 * AEM page link is the primary way an author navigates.
 *
 * This spec is the end-to-end guard for that: real typing into the real
 * Spectrum control, real IPC, real `loadURL`, and the loaded URL read back
 * from the address bar the main process drives.
 *
 * It also pins the half of the behaviour that must NOT change: authorization
 * is still decided on the origin alone, so a deep link into an unconfigured
 * origin still prompts instead of navigating (requirements-decisions.md
 * section 3 - "never silently navigate and never auto-create the entry"). The
 * prompt is fixed copy with a single "OK" `sp-action-button` (the origin is
 * deliberately NOT cited - the address bar on the row above already shows it;
 * cancel is the banner's dismiss cross), so the second half of this spec
 * clicks the button and asserts the server appears in settings.json -
 * proving the add happens only after the user's explicit click.
 *
 * It also pins the re-trigger rule after a dismissal: dismissing the prompt
 * must not silence later attempts. Entering the *same* unchanged address again
 * (sp-textfield emits no `change` for an unchanged value, so navigation fires
 * on the Enter keydown itself) and pressing Refresh while the address bar's
 * URL differs from the loaded page must both re-show the prompt. The second
 * test pins that against a seeded profile: a page IS loaded (a panel cannot
 * be dismissed until one is - panel.ts `setCloseable`), so the address-bar
 * URL genuinely differs from the loaded page. The historical fresh-profile
 * branch (zero servers plus a *null* `lastNavigationState` - a refused
 * unknown-origin navigation never pushes state) is unreachable in E2E by
 * design now, because a fresh profile's startup Settings panel cannot be
 * dismissed; that toolbar branch stays covered by the unit suite
 * (browserToolbar.test.ts).
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-deep-link-scratch');

const DEEP_PATH = '/editor.html/content/site/en.html';

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * A server that echoes the path it was asked for, so "did the deep link
 * actually reach the origin?" is answered by the origin itself rather than
 * inferred from the renderer alone.
 */
async function startEchoOrigin(): Promise<{ origin: string; paths: string[]; close: () => void }> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>echo</title><p id="p">${req.url ?? ''}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    paths,
    close: () => server.close(),
  };
}

test('a pasted deep link navigates to that page, while an unconfigured origin still prompts', async () => {
  test.setTimeout(120_000);

  const aem = await startEchoOrigin();
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const env = {
    ...definedEnv(process.env),
    USERPROFILE: home,
    HOME: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };

  // Built from the app's own defaults and validated with the real schema, so
  // a contract change fails loudly here instead of producing a file the app
  // silently rejects at runtime.
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: randomUUID(),
        label: 'Echo fixture',
        origin: aem.origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
    ],
  });
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(seeded, null, 2), 'utf8');

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    // Seeded profile: the hosts panel is already open at startup, and with no
    // page sitting under it yet it is not dismissible. Picking the seeded host
    // is the sanctioned way out - it loads the page "the app was showing
    // them", which the deep link (copied straight back) then deepens.
    await page.locator(`.hosts-item[data-origin="${aem.origin}"]`).click();
    // The address bar is always visible (the toolbar never hides), so waiting
    // on it synchronizes nothing. What must settle first is the picker's
    // server switch: typing the deep link before it finishes races the
    // in-flight switch, and main serializes switches
    // (`ServerSwitchController.switchTo` rejects a second switch with
    // `already_switching`), which would swallow the deep-link navigation. The
    // origin echo of the load and the address bar reflecting the loaded URL
    // together prove the switch has fully settled.
    await expect.poll(() => aem.paths.includes('/'), { timeout: 30_000 }).toBe(true);
    const addressInput = page.locator('#browser-address-bar input');
    await expect
      .poll(async () => await addressInput.inputValue())
      .toMatch(new RegExp(`^${aem.origin}/?$`));

    const deepUrl = `${aem.origin}${DEEP_PATH}`;
    await addressInput.fill(deepUrl);
    await addressInput.press('Enter');

    // The origin itself confirms the request arrived with the full path - the
    // strongest available evidence that nothing stripped it down to the root.
    await expect.poll(() => aem.paths.includes(DEEP_PATH), { timeout: 60_000 }).toBe(true);

    // And the address bar, which the main process drives from the view's real
    // URL, must show that same page rather than the server root.
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 60_000 })
      .toBe(deepUrl);

    const message = page.locator('.browser-toolbar-message');
    expect((await message.textContent()) ?? '').not.toContain('not a valid address');

    // The other half of the contract: a path must not become a way to reach an
    // origin the user never configured.
    const unknownDeepUrl = 'https://unconfigured.example/editor.html/content/x.html';
    await addressInput.fill(unknownDeepUrl);
    await addressInput.press('Enter');

    await expect(message).toContainText(
      'This host is unknown. Press OK to add it to the managed hosts',
      { timeout: 60_000 },
    );
    // The copy must never cite the URL/host: the address bar is right above
    // the banner and already shows it, and repeating it is noise.
    expect((await message.textContent()) ?? '').not.toContain('unconfigured.example');
    expect((await message.textContent()) ?? '').not.toContain('editor.html');

    const dismissMessage = async (): Promise<void> => {
      await page.locator('.browser-toolbar-message sp-close-button').click();
      await expect(message).not.toHaveAttribute('open');
    };

    // Every navigation to an unknown host must re-trigger the banner after a
    // dismissal (bug: dismissing once silently suppressed all later attempts).
    await dismissMessage();

    // Case 1: pressing Enter on the SAME untouched address value (sp-textfield
    // fires no `change` for an unchanged value) must still navigate and prompt
    // again.
    await addressInput.press('Enter');
    await expect(message).toContainText(
      'This host is unknown. Press OK to add it to the managed hosts',
      { timeout: 60_000 },
    );
    expect((await message.textContent()) ?? '').not.toContain('unconfigured.example');

    // Case 2: dismissing again, then pressing Refresh - the address bar's URL
    // differs from the loaded page, so Refresh must navigate it (not blindly
    // reload the stale page) and the prompt must reappear.
    await dismissMessage();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(message).toContainText(
      'This host is unknown. Press OK to add it to the managed hosts',
      { timeout: 60_000 },
    );

    // The prompt's OK action button persists the server (only after the
    // user's explicit click), then retries the address through the normal
    // switchServer path. The retry will DNS-fail (`unconfigured.example` is
    // reserved and unresolvable), so the observable proof is the new entry in
    // settings.json rather than the navigation outcome.
    await page.getByRole('button', { name: 'OK' }).click();
    try {
      await expect
        .poll(
          () => {
            if (!existsSync(settingsPath)) return false;
            const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
              hosts?: Array<{ origin: string }>;
            };
            return (parsed.hosts ?? []).some(
              (server) => server.origin === 'https://unconfigured.example',
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    } catch (error) {
      const onDisk = existsSync(settingsPath)
        ? (
            (
              JSON.parse(readFileSync(settingsPath, 'utf8')) as {
                hosts?: Array<{ origin: string }>;
              }
            ).hosts ?? []
          )
            .map((server) => server.origin)
            .join(', ') || '(hosts: [])'
        : '(settings.json missing)';
      const state = await message.getAttribute('open');
      const bannerText = (await message.textContent()) ?? '';
      const addressValue = await addressInput.inputValue();
      throw new Error(
        `settings.json never gained https://unconfigured.example; ` +
          `onDisk=${onDisk}; bannerOpen=${state}; banner="${bannerText}"; ` +
          `address="${addressValue}"`,
        { cause: error },
      );
    }
  } finally {
    await app.close();
    aem.close();
  }
});

test('Refresh re-triggers the unknown-origin banner when the address bar differs from the loaded page', async () => {
  test.setTimeout(120_000);

  const aem = await startEchoOrigin();
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-fresh-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const env = {
    ...definedEnv(process.env),
    USERPROFILE: home,
    HOME: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };

  // A page must be loaded before the prompt flow can be exercised, because a
  // panel is not user-dismissible until one is (panel.ts `setCloseable`).
  // The historical "FRESH profile, nothing ever loaded" repro for the
  // null-`lastNavigationState` Refresh branch is unreachable by design now
  // (a fresh profile's startup Settings panel cannot be dismissed), so that
  // toolbar branch is covered by unit tests (browserToolbar.test.ts) and this
  // spec pins the same re-trigger rule against a seeded profile where the
  // address bar's URL genuinely differs from the loaded echo page.
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: randomUUID(),
        label: 'Echo fixture',
        origin: aem.origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
    ],
  });
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(seeded, null, 2), 'utf8');

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    // Seeded profile: the hosts panel opens at startup and is not dismissible
    // until a page sits under it - pick the echo host first (it closes the
    // panel AND loads a page in one step).
    await page.locator(`.hosts-item[data-origin="${aem.origin}"]`).click();
    // Same synchronization as test 1: the picker's switch must settle before
    // the unknown deep link is submitted, or `already_switching` swallows it
    // and the prompt never appears.
    await expect.poll(() => aem.paths.includes('/'), { timeout: 30_000 }).toBe(true);
    const addressInput = page.locator('#browser-address-bar input');
    await expect
      .poll(async () => await addressInput.inputValue())
      .toMatch(new RegExp(`^${aem.origin}/?$`));

    const message = page.locator('.browser-toolbar-message');
    const unknownDeepUrl = 'https://unconfigured.example/editor.html/content/x.html';

    await addressInput.fill(unknownDeepUrl);
    await addressInput.press('Enter');
    await expect(message).toContainText(
      'This host is unknown. Press OK to add it to the managed hosts',
      { timeout: 60_000 },
    );

    // Dismiss, then Refresh: the requested URL (the unknown deep link, which
    // the refused navigation never loaded) differs from the loaded echo page,
    // so Refresh must navigate it and re-show the prompt (not blindly reload
    // the stale page).
    await page.locator('.browser-toolbar-message sp-close-button').click();
    await expect(message).not.toHaveAttribute('open');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(message).toContainText(
      'This host is unknown. Press OK to add it to the managed hosts',
      { timeout: 60_000 },
    );
    // The copy still never cites the host after the re-trigger.
    expect((await message.textContent()) ?? '').not.toContain('unconfigured.example');
  } finally {
    await app.close();
    aem.close();
  }
});
