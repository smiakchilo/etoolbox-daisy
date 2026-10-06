import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * The address bar is a plain `sp-textfield` with an `sp-picker-button`
 * (`#hosts-button`) coupled to its right edge. Clicking the button
 * suspends the native `WebContentsView`, hides the reserved
 * `#browser-view-host` region, and reveals a whole-size hosts list panel
 * (`.hosts-panel`) in its place - instead of a dropdown trying to
 * float above the always-composited-above native view. Picking a host (click
 * or Enter on a `.hosts-item` row, or the header's cross close button)
 * restores the view and, for a selection, fills the address bar with that
 * host's origin and navigates to it - the exact same `navigate()` path a
 * typed address goes through. With zero configured hosts the button stays
 * visible but disabled and the panel never opens.
 *
 * This is exercised against the real built app/real Spectrum control rather
 * than jsdom: the whole point is the interaction between real DOM layout, the
 * hidden/suspended native view, and a real custom element.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'address-picker-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function startEchoOrigin(): Promise<{ origin: string; hits: number; close: () => void }> {
  const state = { hits: 0 };
  const server: Server = createServer((_req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>echo</title><p>ok</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    get hits() {
      return state.hits;
    },
    close: () => server.close(),
  };
}

/**
 * Like {@link startEchoOrigin}, but the response is held back for `delayMs`
 * so the pane sits in the "Loading…" state long enough to interact with it.
 * Records whether the client aborted the request before the delayed response
 * was written - the direct evidence that a superseding navigation cancelled
 * the pending load rather than leaving it running.
 */
async function startSlowOrigin(
  delayMs: number,
): Promise<{ origin: string; hits: number; aborted: boolean; close: () => void }> {
  const state = { hits: 0, aborted: false };
  const server: Server = createServer((_req, res) => {
    state.hits += 1;
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>slow</title><p>ok</p>`);
    }, delayMs);
    res.on('close', () => {
      clearTimeout(timer);
      if (!res.writableEnded) state.aborted = true;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    get hits() {
      return state.hits;
    },
    get aborted() {
      return state.aborted;
    },
    close: () => server.close(),
  };
}

function launchProfile(): { home: string; env: Record<string, string> } {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    home,
    env: {
      ...definedEnv(process.env),
      USERPROFILE: home,
      HOME: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    },
  };
}

function writeSettings(home: string, settings: unknown): void {
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * The `open` attribute must *paint* pressed, not just tag the element: the
 * non-quiet `sp-picker-button` paints its resting fill on `.spectrum-PickerButton-fill`
 * (`.root` itself stays `background-color: initial`) inside the shadow root,
 * and the fill flips to the darker "down" variant under `:host([open]) .root`.
 * Playwright parks the pointer away first so `:hover` contributes nothing,
 * then reads the actual computed background of the fill element.
 */
async function pickerPressedBackground(page: Page): Promise<string | null> {
  await page.mouse.move(2, 2);
  return page.evaluate(() => {
    const el = document.getElementById('hosts-button');
    const fill = el?.shadowRoot?.querySelector('.spectrum-PickerButton-fill') ?? null;
    return fill ? getComputedStyle(fill).backgroundColor : null;
  });
}

test("picking a host from the address bar's hosts panel navigates to it", async () => {
  test.setTimeout(120_000);

  const serverA = await startEchoOrigin();
  const serverB = await startEchoOrigin();
  const { home, env } = launchProfile();

  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: randomUUID(),
        label: 'Server A',
        origin: serverA.origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
      {
        id: randomUUID(),
        label: 'Server B',
        origin: serverB.origin,
        color: { kind: 'swatch', swatch: 'green' },
        revision: 0,
      },
    ],
  });
  writeSettings(home, seeded);

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();
    const pickerButton = page.locator('#hosts-button');
    const panel = page.locator('.hosts-panel');
    const viewHost = page.locator('[data-testid="browser-view-host"]');
    const addressLabel = page.locator('.address-bar__host-label');
    await expect(pickerButton).toBeVisible({ timeout: 10_000 });

    // Nothing is loaded yet, so the paired host label is hidden rather than
    // showing any host's colour/name, and the address text uses only the
    // field's resting padding.
    await expect(addressLabel).toBeHidden();
    await expect
      .poll(
        async () =>
          await addressInput.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft)),
      )
      .toBeLessThan(20);

    // A seeded profile means the hosts panel is already open at startup.
    // Because no page sits under it yet, the panel is not closeable: its
    // cross button is disabled, Escape is inert, and the picker button's
    // toggle does nothing. Selecting a host is the sanctioned way to leave
    // it (it closes the panel AND loads a page in one step).
    const itemA = page.locator(`.hosts-item[data-origin="${serverA.origin}"]`);
    const itemB = page.locator(`.hosts-item[data-origin="${serverB.origin}"]`);
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(itemA).toBeVisible({ timeout: 10_000 });
    await expect(itemB).toBeVisible({ timeout: 10_000 });
    await expect(viewHost).toBeHidden();
    await expect(pickerButton).toHaveAttribute('open', '');

    // Pick Server A directly from the startup panel. The panel closes and
    // navigates in one step: the page-view region is never left bare.
    await itemA.click();
    await expect
      .poll(async () => await addressInput.inputValue())
      .toMatch(new RegExp(`^${serverA.origin}/?$`));
    await expect.poll(() => serverA.hits > 0, { timeout: 30_000 }).toBe(true);
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();
    await expect(pickerButton).not.toHaveAttribute('open', '');
    // Server A's page is loaded, so the paired host label now names it on its
    // blue, with white text.
    await expect(addressLabel).toBeVisible();
    await expect(addressLabel).toHaveText('Server A');
    await expect(addressLabel).toHaveCSS('background-color', 'rgb(38, 128, 235)');
    await expect(addressLabel).toHaveCSS('color', 'rgb(255, 255, 255)');
    // The address text is pushed past the measured label block by the input's
    // left padding (outside its scroll area).
    await expect
      .poll(
        async () =>
          await addressInput.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft)),
      )
      .toBeGreaterThan(20);
    // A real custom element registry entry is the only proof the
    // register-imports step ran - see AGENTS.md's "jsdom cannot prove a custom
    // element is registered" rule.
    const registered = await page.evaluate(() => ({
      pickerButton: Boolean(customElements.get('sp-picker-button')),
      closeIcon: Boolean(customElements.get('daisy-close-icon')),
    }));
    expect(registered.pickerButton).toBe(true);
    expect(registered.closeIcon).toBe(true);
    const baselineA = serverA.hits;

    // The page has loaded, so the panel is now closeable. Clicking the picker
    // button opens the panel: the native view region disappears underneath it
    // and the button shows its pressed/open state - both the `open` attribute
    // AND the painted "down" background it triggers.
    const restingBackground = await pickerPressedBackground(page);
    expect(restingBackground).not.toBeNull();
    await pickerButton.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(viewHost).toBeHidden();
    await expect(pickerButton).toHaveAttribute('open', '');
    await page.waitForTimeout(300);
    const pressedBackground = await pickerPressedBackground(page);
    expect(pressedBackground).not.toBe(restingBackground);

    // Deciding to back out: the header's cross button closes the panel and
    // restores the native view region without navigating anywhere.
    await page.locator('.hosts-panel__close').click();
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();
    await expect(pickerButton).not.toHaveAttribute('open', '');
    expect(serverA.hits).toBe(baselineA);
    expect(serverB.hits).toBe(0);

    // Re-open and actually pick Server B.
    await pickerButton.click();
    await expect(itemB).toBeVisible({ timeout: 10_000 });
    await itemB.click();

    // Selecting fills the address bar and navigates. The final address-bar
    // text comes from the real post-navigation URL (which can add a trailing
    // "/"), not literally the item's string.
    await expect
      .poll(async () => await addressInput.inputValue())
      .toMatch(new RegExp(`^${serverB.origin}/?$`));
    await expect.poll(() => serverB.hits > 0, { timeout: 30_000 }).toBe(true);
    expect(serverA.hits).toBe(baselineA);

    // The panel closed again, the native view region is back, and the button
    // has released its pressed state back to the resting background.
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();
    await expect(pickerButton).not.toHaveAttribute('open', '');
    await page.waitForTimeout(300);
    expect(await pickerPressedBackground(page)).toBe(restingBackground);

    // The host label follows the loaded host: Server B's green now.
    await expect(addressLabel).toHaveText('Server B');
    await expect(addressLabel).toHaveCSS('background-color', 'rgb(45, 157, 120)');

    const message = page.locator('.browser-toolbar-message');
    await expect(message).toBeHidden();
    expect((await message.textContent()) ?? '').toBe('');

    // Opening the picker again and picking the other server works too - not
    // a one-shot affordance.
    await pickerButton.click();
    await expect(itemA).toBeVisible({ timeout: 10_000 });
    await itemA.click();
    await expect.poll(() => serverA.hits > baselineA, { timeout: 30_000 }).toBe(true);

    // Let the picker-initiated switch settle before typing the next address,
    // so this assertion measures "typing to a different host works" rather than
    // "a superseding navigation works" (that supersede path is covered by the
    // dedicated test below). The toolbar's Refresh (rather than Stop) is the
    // "not loading" signal.
    await expect(page.locator('.browser-toolbar [aria-label="Refresh"]')).toHaveCount(1, {
      timeout: 30_000,
    });

    // Typing directly into the field still works too - the same field, not
    // a separate mode.
    await addressInput.fill(serverB.origin);
    await addressInput.press('Enter');
    await expect.poll(() => serverB.hits > 1, { timeout: 30_000 }).toBe(true);
  } finally {
    await app.close();
    serverA.close();
    serverB.close();
  }
});

test("with no configured hosts, the address bar's hosts button stays visible but disabled", async () => {
  test.setTimeout(60_000);

  const { home, env } = launchProfile();
  writeSettings(home, defaultAppSettings());

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();
    const pickerButton = page.locator('#hosts-button');

    // The button is still present (never hidden) but disabled, and clicking
    // it must never surface the panel when there is nothing to pick from.
    await expect(pickerButton).toBeVisible();
    await expect(pickerButton).toBeDisabled();
    await addressInput.click();
    await pickerButton.click({ force: true });
    await page.waitForTimeout(500);
    await expect(page.locator('.hosts-panel')).toBeHidden();
    await expect(addressInput).toBeEnabled();
  } finally {
    await app.close();
  }
});

test('the hosts picker stays enabled while a page loads, and picking another host aborts the pending load', async () => {
  test.setTimeout(120_000);

  const slow = await startSlowOrigin(15_000);
  const fast = await startEchoOrigin();
  const { home, env } = launchProfile();

  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: randomUUID(),
        label: 'Slow',
        origin: slow.origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
      {
        id: randomUUID(),
        label: 'Fast',
        origin: fast.origin,
        color: { kind: 'swatch', swatch: 'green' },
        revision: 0,
      },
    ],
  });
  writeSettings(home, seeded);

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();
    const pickerButton = page.locator('#hosts-button');
    const panel = page.locator('.hosts-panel');
    const message = page.locator('.browser-toolbar-message');

    // Startup panel is open; pick the slow host to begin a long load.
    await page.locator(`.hosts-item[data-origin="${slow.origin}"]`).click();
    await expect.poll(() => slow.hits > 0, { timeout: 30_000 }).toBe(true);

    // The loading presentation appears (debounced) while the request hangs.
    await expect(message).toContainText('Loading', { timeout: 20_000 });

    // The picker must not be disabled mid-load - that was the usability trap:
    // a slow or wrong address must never leave the user with no way to pick
    // another host.
    await expect(pickerButton).toBeEnabled();

    // It must actually open the hosts panel while the page is still loading.
    await pickerButton.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(pickerButton).toHaveAttribute('open', '');

    // Picking another host aborts the pending slow load and navigates instead.
    await page.locator(`.hosts-item[data-origin="${fast.origin}"]`).click();
    await expect.poll(() => fast.hits > 0, { timeout: 30_000 }).toBe(true);
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toMatch(new RegExp(`^${fast.origin}/?$`));
    await expect(panel).toBeHidden();

    // The abandoned navigation was genuinely aborted, not merely left to race
    // the new one.
    await expect.poll(() => slow.aborted, { timeout: 20_000 }).toBe(true);
  } finally {
    await app.close();
    slow.close();
    fast.close();
  }
});

test('the address bar selects all on the first click and inline-completes host addresses as you type', async () => {
  test.setTimeout(120_000);

  const server = await startEchoOrigin();
  const { home, env } = launchProfile();

  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: randomUUID(),
        label: 'Author',
        origin: server.origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
    ],
  });
  writeSettings(home, seeded);

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();
    const addressLabel = page.locator('.address-bar__host-label');

    // Load the host so the field holds a real navigated URL to select.
    await page.locator(`.hosts-item[data-origin="${server.origin}"]`).click();
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toMatch(new RegExp(`^${server.origin}/?$`));

    // Click once into an unfocused address bar: the whole value is selected
    // (Chrome behaviour). The field is blurred first so the click starts from
    // the unfocused state.
    await addressInput.blur();
    await addressInput.click();
    const selected = await addressInput.evaluate((el) => {
      const input = el as HTMLInputElement;
      return { start: input.selectionStart, end: input.selectionEnd, length: input.value.length };
    });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.start).toBe(0);
    expect(selected.end).toBe(selected.length);

    // A second click clears the selection and places the caret.
    await addressInput.click();
    const collapsed = await addressInput.evaluate((el) => {
      const input = el as HTMLInputElement;
      return { start: input.selectionStart, end: input.selectionEnd };
    });
    expect(collapsed.start).toBe(collapsed.end);

    // Typing an address prefix inline-completes to the host's origin, with the
    // appended text selected. Typed key by key so the real per-keystroke flow
    // (each character replacing the previous completion's selection) runs.
    await addressInput.fill('');
    await addressInput.pressSequentially('http');
    await expect.poll(async () => await addressInput.inputValue()).toBe(server.origin);
    const completion = await addressInput.evaluate((el) => {
      const input = el as HTMLInputElement;
      return { start: input.selectionStart, end: input.selectionEnd };
    });
    expect(completion.start).toBe('http'.length);
    expect(completion.end).toBe(server.origin.length);

    // The next typed symbol discards the completion instead of appending to it.
    await addressInput.press('x');
    await expect.poll(async () => await addressInput.inputValue()).toBe('httpx');
    await expect(addressLabel).toBeHidden();

    // Typing from the domain name (no protocol) also completes: the protocol is
    // inferred from the host and the typed prefix is kept, with the rest of the
    // host selected ("127" -> "http://127[.0.0.1:port]").
    await addressInput.fill('');
    await addressInput.pressSequentially('127');
    await expect.poll(async () => await addressInput.inputValue()).toBe(server.origin);
    const domainCompletion = await addressInput.evaluate((el) => {
      const input = el as HTMLInputElement;
      return { start: input.selectionStart, end: input.selectionEnd };
    });
    expect(domainCompletion.start).toBe('http://'.length + '127'.length);
    expect(domainCompletion.end).toBe(server.origin.length);

    // A scheme-less full host submitted with Enter gets the host's protocol and
    // navigates. The live URL then comes from the real navigation, which adds a
    // trailing slash.
    const hitsBefore = server.hits;
    await addressInput.fill(server.origin.replace(/^https?:\/\//, ''));
    await addressInput.press('Enter');
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toMatch(new RegExp(`^${server.origin}/?$`));
    await expect.poll(() => server.hits > hitsBefore, { timeout: 30_000 }).toBe(true);
  } finally {
    await app.close();
    server.close();
  }
});

test('a long host label shrinks inside the address field instead of overflowing it', async () => {
  test.setTimeout(120_000);

  const server = await startEchoOrigin();
  const { home, env } = launchProfile();

  const base = defaultAppSettings();
  const longLabel = 'HPE DEV Author With A Very Long Environment Name';
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: randomUUID(),
        label: longLabel,
        origin: server.origin,
        color: { kind: 'swatch', swatch: 'green' },
        revision: 0,
      },
    ],
  });
  writeSettings(home, seeded);

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressLabel = page.locator('.address-bar__host-label');

    // Load the host so the long label is shown.
    await page.locator(`.hosts-item[data-origin="${server.origin}"]`).click();
    await expect(addressLabel).toBeVisible();
    await expect(addressLabel).toHaveText(longLabel);

    // Force the field narrow enough that the label's natural width cannot fit,
    // so the clamp has to shrink it. The field is a flex item, so pin its size.
    await page.evaluate(() => {
      const field = document.getElementById('browser-address-bar');
      if (field) {
        field.style.flex = '0 0 auto';
        field.style.width = '150px';
      }
    });

    // Wait for the resize-driven clamp, then read the geometry.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const field = document.getElementById('browser-address-bar');
            const label = document.querySelector('.address-bar__host-label');
            if (!field || !label) return false;
            return label.getBoundingClientRect().right <= field.getBoundingClientRect().right - 40;
          }),
      )
      .toBe(true);

    const geometry = await page.evaluate(() => {
      const field = document.getElementById('browser-address-bar');
      const label = document.querySelector('.address-bar__host-label');
      if (!field || !label) throw new Error('address field or label missing');
      const fieldRect = field.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      return {
        fieldWidth: fieldRect.width,
        labelWidth: labelRect.width,
        labelRight: labelRect.right,
        fieldRight: fieldRect.right,
        clipped: (label as HTMLElement).scrollWidth > (label as HTMLElement).clientWidth,
      };
    });

    // The chip is clamped below its 160px upper bound, ellipsized, and stops
    // short of the field's right border by the reserved slice of address text.
    expect(geometry.labelWidth).toBeLessThan(160);
    expect(geometry.clipped).toBe(true);
    expect(geometry.fieldRight - geometry.labelRight).toBeGreaterThanOrEqual(40);
  } finally {
    await app.close();
    server.close();
  }
});

test('selecting a long address keeps its start visible and never under the chip', async () => {
  test.setTimeout(120_000);

  const server = await startEchoOrigin();
  const { home, env } = launchProfile();

  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: randomUUID(),
        label: 'Author',
        origin: server.origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
    ],
  });
  writeSettings(home, seeded);

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();

    // A loaded address far wider than the field, so it must scroll.
    const longUrl = `${server.origin}/${'a'.repeat(200)}`;
    await addressInput.fill(longUrl);
    await addressInput.press('Enter');
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toBe(longUrl);

    // Wait for the chip and its padding to settle.
    await expect
      .poll(
        async () =>
          await addressInput.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft)),
      )
      .toBeGreaterThan(20);

    // Click once into the unfocused field: select-all must keep the start in
    // view (no leftward shift) and the text must sit right of the chip.
    await addressInput.blur();
    await addressInput.click();

    const selection = await addressInput.evaluate((el) => {
      const input = el as HTMLInputElement;
      return {
        start: input.selectionStart,
        end: input.selectionEnd,
        scrollLeft: input.scrollLeft,
        length: input.value.length,
      };
    });
    expect(selection.length).toBeGreaterThan(100);
    expect(selection.start).toBe(0);
    expect(selection.end).toBe(selection.length);
    expect(selection.scrollLeft).toBe(0);

    const geometry = await page.evaluate(() => {
      const field = document.getElementById('browser-address-bar');
      const input = field?.shadowRoot?.querySelector('input.input:not(#sizer)');
      const label = document.querySelector('.address-bar__host-label');
      if (!input || !label) throw new Error('address input or label missing');
      const inputRect = input.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      return {
        contentLeft:
          inputRect.left +
          input.clientLeft +
          Number.parseFloat(getComputedStyle(input).paddingLeft),
        chipRight: labelRect.right,
      };
    });
    // The text's content edge is never left of the chip's right edge.
    expect(geometry.contentLeft).toBeGreaterThanOrEqual(geometry.chipRight);
  } finally {
    await app.close();
    server.close();
  }
});

test('typing a host label completes to "label + URL" without selecting the whole field', async () => {
  test.setTimeout(120_000);

  const server = await startEchoOrigin();
  const { home, env } = launchProfile();

  const base = defaultAppSettings();
  const label = 'HPE DEV Author';
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: randomUUID(),
        label,
        origin: server.origin,
        color: { kind: 'swatch', swatch: 'green' },
        revision: 0,
      },
    ],
  });
  writeSettings(home, seeded);

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();

    // Type the label prefix: the value becomes "label + URL" and only the text
    // after the typed prefix is selected, so continuing to type keeps the
    // prefix instead of erasing the field.
    await addressInput.click();
    await addressInput.pressSequentially('hpe');
    const combined = `${label} ${server.origin}`;
    await expect.poll(async () => await addressInput.inputValue()).toBe(combined);
    const selection = await addressInput.evaluate((el) => {
      const input = el as HTMLInputElement;
      return { start: input.selectionStart, end: input.selectionEnd, length: input.value.length };
    });
    expect(selection.start).toBe('hpe'.length);
    expect(selection.end).toBe(selection.length);
    expect(selection.start).toBeGreaterThan(0);

    // Enter strips the label and navigates to the URL.
    const hitsBefore = server.hits;
    await addressInput.press('Enter');
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toMatch(new RegExp(`^${server.origin}/?$`));
    await expect.poll(() => server.hits > hitsBefore, { timeout: 30_000 }).toBe(true);
  } finally {
    await app.close();
    server.close();
  }
});
