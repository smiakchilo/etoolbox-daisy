// noinspection HtmlUnknownTarget,HtmlRequiredAltAttribute

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import type { ScriptedTurn } from '../../src/main/agents/fakeAgentService';
import {
  FAKE_AGENT_SERVICE_ENV_VAR,
  TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY,
} from '../../src/main/agentComposition';

/**
 * The `browser_navigate` and `environment_facts` billets, against the BUILT app.
 *
 * The deterministic fake scripts events rather than running tool executors, so
 * what this proves is the real renderer bundle's transcript composition for the
 * two new tools: the collapsed summary (`Open HPE DEV: /content/wknd.html`) and
 * the expanded label/value rows. The *real* navigation itself is proven at the
 * controller level (`tests/unit/main/browser/browserController.test.ts`,
 * `openForAgent`) and the underlying pane navigation by the existing browser
 * specs, because no model and no AEM instance are available to the E2E suite.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/navigate.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'navigate-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
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
      [FAKE_AGENT_SERVICE_ENV_VAR]: '1',
    },
  };
}

function writeSettings(home: string, settings: unknown): void {
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

async function startEchoOrigin(): Promise<{ origin: string; close: () => void }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>echo</title><p>ok</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { origin: `http://127.0.0.1:${String(address.port)}`, close: () => server.close() };
}

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

function scriptTurn(app: ElectronApp, turn: ScriptedTurn): Promise<void> {
  const payload = JSON.stringify({ globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY, turn });
  return app.evaluate((_electronNamespace, json: string) => {
    const arg = JSON.parse(json) as { globalKey: string; turn: unknown };
    const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
      readonly scriptNextResponse: (t: unknown) => void;
    };
    fake.scriptNextResponse(arg.turn);
  }, payload);
}

async function flushFake(app: ElectronApp): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    const delivered = await app.evaluate((_electronNamespace, key: string) => {
      const fake = (globalThis as Record<string, unknown>)[key] as {
        readonly advance: () => boolean;
      };
      return fake.advance();
    }, TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY);
    if (!delivered) return;
  }
  throw new Error('flushFake exceeded its guard - the fake never drained.');
}

const COMPOSER_SEND = '.chat-composer__send';
const CHAT_STATUS_BANNER = '.chat-status-banner';
const COMPOSER_FIELD = '.chat-composer textarea';

async function waitForComposerReady(shell: Page): Promise<void> {
  await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(shell.locator(CHAT_STATUS_BANNER)).not.toHaveAttribute('open', '', {
    timeout: 60_000,
  });
  await expect(shell.locator(COMPOSER_SEND)).toBeVisible();
  await expect(shell.locator(COMPOSER_SEND)).not.toHaveAttribute('disabled', '');
}

async function sendViaComposer(shell: Page, prompt: string): Promise<void> {
  await shell.locator(COMPOSER_FIELD).fill(prompt);
  await shell.locator(COMPOSER_SEND).click();
}

test.describe('navigate: the browser_navigate and environment_facts billets', () => {
  let app: ElectronApp;
  let shell: Page;
  let server: { origin: string; close: () => void };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    server = await startEchoOrigin();
    const { home, env } = launchProfile();
    const base = defaultAppSettings();
    writeSettings(
      home,
      appSettingsSchema.parse({
        ...base,
        hosts: [
          ...base.hosts,
          {
            id: randomUUID(),
            label: 'HPE DEV',
            origin: server.origin,
            color: { kind: 'swatch', swatch: 'green' },
            revision: 0,
          },
        ],
      }),
    );
    app = await electron.launch({ args: [mainEntry], env });
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
  });

  test.afterAll(async () => {
    await app.close();
    server.close();
  });

  test('renders the browser_navigate billet with its host, path and outcome', async () => {
    await scriptTurn(app, {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: 'browser_navigate',
            arguments: { host: 'HPE DEV', path: '/content/wknd.html' },
            decision: {
              kind: 'approved',
              outcome: {
                ok: true,
                data: {
                  ok: true,
                  operation: 'browser_navigate',
                  requestId: 'r1',
                  hostLabel: 'HPE DEV',
                  origin: server.origin,
                  path: '/content/wknd.html',
                  url: `${server.origin}/content/wknd.html`,
                  switched: false,
                  textResultForLlm: 'opened',
                  resultType: 'success',
                } as never,
              },
            },
          },
        },
      ],
    });
    await sendViaComposer(shell, 'open the home page in HPE DEV');
    await flushFake(app);

    const billet = shell.locator('.chat-tool-call').last();
    await expect(billet.locator('.chat-tool-call__header')).toContainText('browser_navigate', {
      timeout: 30_000,
    });
    await expect(billet.locator('.chat-tool-call__summary')).toHaveText(
      'Open HPE DEV: /content/wknd.html',
    );

    // Expanded: the deliberate label/value rows.
    await billet.locator('.chat-tool-call__toggle').click();
    const params = billet.locator('.chat-tool-call__params');
    await expect(params).toContainText('Host');
    await expect(params).toContainText('HPE DEV');
    await expect(params).toContainText('Path');
    await expect(params).toContainText('/content/wknd.html');
    await expect(params).toContainText('Result');
    await expect(params).toContainText('Opened');
  });

  test('renders the environment_facts billet listing the configured host', async () => {
    await scriptTurn(app, {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: 'environment_facts',
            arguments: {},
            decision: {
              kind: 'approved',
              outcome: {
                ok: true,
                data: {
                  ok: true,
                  operation: 'environment_facts',
                  requestId: 'r2',
                  hosts: [
                    {
                      label: 'HPE DEV',
                      origin: server.origin,
                      contentRoots: ['/content'],
                      componentRoots: ['/apps'],
                      current: true,
                    },
                  ],
                  fetchedAt: 1,
                  textResultForLlm: 'hosts',
                  resultType: 'success',
                } as never,
              },
            },
          },
        },
      ],
    });
    await sendViaComposer(shell, 'which environments do I have?');
    await flushFake(app);

    const billet = shell.locator('.chat-tool-call').last();
    await expect(billet.locator('.chat-tool-call__header')).toContainText('environment_facts', {
      timeout: 30_000,
    });
    await billet.locator('.chat-tool-call__toggle').click();
    const params = billet.locator('.chat-tool-call__params');
    await expect(params).toContainText('HPE DEV');
    await expect(params).toContainText(server.origin);
  });
});
