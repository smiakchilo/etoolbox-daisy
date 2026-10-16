import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, type Page } from '@playwright/test';
import {
  type AppPaths,
  getLocalDataDirectory,
  getOsHomeDirectory,
  resolveAppPaths,
} from '../../../src/main/appPaths';
import { type ElectronApp, mainEntry } from '../e2e/app';
import { waitForComposerReady } from '../e2e/composer';
import { definedEnv } from '../e2e/env';
import { byTestId } from '../selectors';
import { deleteConversation, switchServer } from './daisyBridge';
import { redactValue } from './redact';

export interface LiveHostInfo {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
}

export interface LiveAgentInfo {
  readonly id: string;
  /** The model the settings select; `undefined` means the agent's own default. */
  readonly model: string | undefined;
  readonly reasoningEffort: string | undefined;
}

export interface LiveAppOptions {
  /** A host label, id or origin (case-insensitive) to open before the test; default is whatever the app restores. */
  readonly host?: string;
  /** How long the app may take to present its window (default 60 s). */
  readonly windowTimeoutMs?: number;
  /** How long a host switch may take to show the host's page (default 60 s). */
  readonly hostTimeoutMs?: number;
}

export interface LiveApp {
  readonly app: ElectronApp;
  /** The renderer (shell) window: chat on the right, browser chrome on the left. */
  readonly shell: Page;
  readonly paths: AppPaths;
  /** The real settings.json with every secret-looking value redacted; safe to store or print. */
  readonly settings: unknown;
  readonly agent: LiveAgentInfo;
  readonly hosts: readonly LiveHostInfo[];
  /**
   * Ids of the conversations this run started (via `startFreshConversation`).
   * With `LIVE_CLEANUP=1`, `close()` deletes exactly these through the app's own
   * delete; real conversations are never touched.
   */
  readonly createdChatIds: string[];
  /** The configured host whose origin the address bar currently shows, if any. */
  currentHost(): Promise<LiveHostInfo | undefined>;
  close(): Promise<void>;
}

const DEFAULT_WINDOW_TIMEOUT_MS = 60_000;
const DEFAULT_HOST_TIMEOUT_MS = 60_000;
const SETTINGS_FILE = 'settings.json';
/** Set to `1` to have `close()` delete the conversations this run created. */
export const CLEANUP_ENV = 'LIVE_CLEANUP';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Reads the settings the app would load; never writes them. Throws an actionable error when unusable. */
export function readLiveSettings(paths: AppPaths): {
  readonly raw: unknown;
  readonly agent: LiveAgentInfo;
  readonly hosts: readonly LiveHostInfo[];
} {
  const file = path.join(paths.settings, SETTINGS_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `No settings found at ${file}. Live tests use your real profile: start EToolbox Daisy once, ` +
        'configure a host and sign in to an agent, then close it and re-run.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Settings at ${file} are not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
  const document = asRecord(raw);
  const agents = asRecord(document?.['agents']) ?? {};
  const active = Object.entries(agents).find(([, entry]) => asRecord(entry)?.['active'] === true);
  if (active === undefined) {
    throw new Error(
      `No agent is active in ${file}. Open EToolbox Daisy > Settings > Agents, press "Set active" ` +
        'on the agent to test, close the app and re-run (live tests never choose an agent for you).',
    );
  }
  const entry = asRecord(active[1]) ?? {};
  const hosts: LiveHostInfo[] = [];
  const rawHosts = document?.['hosts'];
  for (const candidate of Array.isArray(rawHosts) ? (rawHosts as unknown[]) : []) {
    const host = asRecord(candidate);
    const id = text(host?.['id']);
    const label = text(host?.['label']);
    const origin = text(host?.['origin']);
    if (id !== undefined && label !== undefined && origin !== undefined) {
      hosts.push({ id, label, origin });
    }
  }
  return {
    raw,
    agent: {
      id: active[0],
      model: text(entry['model']),
      reasoningEffort: text(entry['reasoningEffort']),
    },
    hosts,
  };
}

function findHost(hosts: readonly LiveHostInfo[], wanted: string): LiveHostInfo {
  const needle = wanted.trim().toLowerCase();
  const found = hosts.find(
    (host) =>
      host.id.toLowerCase() === needle ||
      host.label.toLowerCase() === needle ||
      host.origin.toLowerCase() === needle,
  );
  if (found === undefined) {
    const available = hosts.map((host) => `"${host.label}" (${host.origin})`).join(', ');
    throw new Error(
      `Host "${wanted}" is not configured. Configured hosts: ${available || '(none)'}.`,
    );
  }
  return found;
}

function originMatches(address: string, origin: string): boolean {
  try {
    return new URL(address).origin.toLowerCase() === new URL(origin).origin.toLowerCase();
  } catch {
    return false;
  }
}

async function readAddress(shell: Page): Promise<string> {
  return shell.locator(byTestId('browser-address')).locator('input').first().inputValue();
}

async function switchToHost(shell: Page, host: LiveHostInfo, timeoutMs: number): Promise<void> {
  const result = await switchServer(shell, host.id);
  if (!result.ok) {
    throw new Error(
      `Switching to host "${host.label}" failed: ${JSON.stringify(redactValue(result.error))}`,
    );
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (originMatches(await readAddress(shell).catch(() => ''), host.origin)) return;
    await shell.waitForTimeout(250);
  }
  throw new Error(
    `The browser pane did not show host "${host.label}" (${host.origin}) within ${timeoutMs} ms. ` +
      'Is the host reachable (VPN, local AEM started)?',
  );
}

const LOCK_HINT =
  'Most likely another EToolbox Daisy is already running and holds the single-instance lock: ' +
  'close your running EToolbox Daisy (also check the tray / Task Manager) and re-run.';

async function launchOrExplain(
  windowTimeoutMs: number,
): Promise<{ app: ElectronApp; shell: Page }> {
  let app: ElectronApp | undefined;
  try {
    app = await electron.launch({
      args: [mainEntry],
      env: definedEnv(process.env),
      timeout: windowTimeoutMs,
    });
    const launched = app;
    const closed = new Promise<never>((_resolve, reject) => {
      launched.once('close', () => {
        reject(new Error('The app exited before presenting a window.'));
      });
    });
    const shell = await Promise.race([launched.firstWindow({ timeout: windowTimeoutMs }), closed]);
    return { app: launched, shell };
  } catch (error) {
    await app?.close().catch(() => undefined);
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(`The real app did not start (${detail}). ${LOCK_HINT}`, { cause: error });
  }
}

/**
 * Launches the BUILT app against the user's REAL profile: plain `process.env`,
 * no home override, no fake agent - the selected agent, model, secrets and AEM
 * sign-in session are exactly what the user has. Preflights with actionable
 * errors, waits for the composer, and optionally opens a configured host.
 */
export async function launchLiveApp(options: LiveAppOptions = {}): Promise<LiveApp> {
  const {
    host: wantedHost,
    windowTimeoutMs = DEFAULT_WINDOW_TIMEOUT_MS,
    hostTimeoutMs = DEFAULT_HOST_TIMEOUT_MS,
  } = options;
  if (!existsSync(mainEntry)) {
    throw new Error(`The built app is missing (${mainEntry}). Run \`npm run build\` and re-run.`);
  }
  const paths = resolveAppPaths(getOsHomeDirectory(), getLocalDataDirectory());
  const { raw, agent, hosts } = readLiveSettings(paths);
  const target = wantedHost === undefined ? undefined : findHost(hosts, wantedHost);

  const { app, shell } = await launchOrExplain(windowTimeoutMs);
  const createdChatIds: string[] = [];
  try {
    await waitForComposerReady(shell, { sendEnabledTimeoutMs: 60_000 });
  } catch (error) {
    await app.close().catch(() => undefined);
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(
      `The app started but the chat did not become ready: ${detail}. ` +
        `Check that agent "${agent.id}" is signed in (Settings > Agents).`,
      { cause: error },
    );
  }
  if (target !== undefined) {
    try {
      await switchToHost(shell, target, hostTimeoutMs);
    } catch (error) {
      await app.close().catch(() => undefined);
      throw error;
    }
  }

  return {
    app,
    shell,
    paths,
    settings: redactValue(raw),
    agent,
    hosts,
    createdChatIds,
    async currentHost() {
      const address = await readAddress(shell).catch(() => '');
      return hosts.find((host) => originMatches(address, host.origin));
    },
    async close() {
      if (process.env[CLEANUP_ENV] === '1') {
        for (const chatId of createdChatIds) {
          await deleteConversation(shell, chatId).catch(() => false);
        }
      }
      await app.close().catch(() => undefined);
    },
  };
}
