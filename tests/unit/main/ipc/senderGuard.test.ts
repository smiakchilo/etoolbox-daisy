import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretCipher } from '../../../../src/main/secretStore';
import type { BrowserController } from '../../../../src/main/browser/browserController';
import type { AemBrowserView } from '../../../../src/main/browser/aemBrowserView';
import type { NavigationEpochTracker } from '../../../../src/main/browser/navigationEpoch';
import type { Logger } from '../../../../src/main/logger';
import { err } from '../../../../src/shared';

/**
 * Proves the sender check is actually WIRED to every registered IPC channel.
 *
 * This exists because of a gap found by mutation testing, not by reading code:
 * `isTrustedLocalSettingsSender` / `isTrustedBrowserIpcSender` were both
 * thoroughly tested as pure predicates, and every handler body was tested as a
 * directly-exported function - but nothing tested the wiring between them.
 * Disabling the `checkSender` guard inside the `settings:add-server` handler
 * left the entire suite green. A channel that simply forgot the guard would
 * have shipped silently.
 *
 * So this suite deliberately does NOT hardcode a channel list. It discovers
 * every channel the registration functions actually register and asserts the
 * guard on each one, which is what makes it cover channels that do not exist
 * yet.
 *
 * It also covers a Step 05 success criterion head-on: "neither AEM nor the IdP
 * can reach app IPC". Those hostile cases are exactly that - a frame showing
 * remote content, with an otherwise perfectly valid `webContentsId`, must be
 * refused by every channel.
 */

const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>();
const sendHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      invokeHandlers.set(channel, listener);
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      sendHandlers.set(channel, listener);
    },
  },
  app: { on: vi.fn(), removeListener: vi.fn() },
  screen: { on: vi.fn(), removeListener: vi.fn() },
  WebContentsView: class {},
  BrowserWindow: class {},
}));

const { registerSettingsIpcHandlers } = await import('../../../../src/main/ipc/settings');
const { registerBrowserIpcHandlers } = await import('../../../../src/main/ipc/browser');
const { createSecretStore } = await import('../../../../src/main/secretStore');

const MAIN_WEB_CONTENTS_ID = 7;
const OTHER_WEB_CONTENTS_ID = 8;

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'senderGuard-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeCipher(): SecretCipher {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(plainText: string): Buffer {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(encrypted: Buffer): string {
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}

/**
 * Builds an `IpcMainInvokeEvent`-shaped value carrying only the three fields
 * the trust check reads. `top` is self-referential because the guard derives
 * `isMainFrame` from `frame.top === frame`.
 */
function eventWith(options: { url: string | null; webContentsId: number }): unknown {
  if (options.url === null) {
    return { senderFrame: null, sender: { id: options.webContentsId } };
  }
  const frame: { url: string; top?: unknown } = { url: options.url };
  frame.top = frame;
  return { senderFrame: frame, sender: { id: options.webContentsId } };
}

function errorCodeOf(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return undefined;
  if (Reflect.get(result, 'ok') !== false) return undefined;
  const error: unknown = Reflect.get(result, 'error');
  if (error === null || typeof error !== 'object') return undefined;
  return Reflect.get(error, 'code');
}

let trustedUrl: string;
let controllerCalls: string[];

beforeEach(() => {
  invokeHandlers.clear();
  sendHandlers.clear();
  controllerCalls = [];

  const rendererDistDir = createScratchRoot();
  trustedUrl = pathToFileURL(path.join(rendererDistDir, 'index.html')).href;

  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
  };

  registerSettingsIpcHandlers({
    settingsDir: path.join(rendererDistDir, 'settings'),
    secretStore: createSecretStore(path.join(rendererDistDir, 'secrets'), fakeCipher()),
    logger,
    rendererDistDir,
    isTrustedWebContentsId: (id) => id === MAIN_WEB_CONTENTS_ID,
    modelSelection: {
      // Recorders, not throwers: the "does NOT reject the app's own renderer"
      // case drives every registered handler with a trusted sender, so these
      // must be callable. The guard itself is asserted by the untrusted sweeps.
      loadCatalog: () => Promise.resolve(err({ message: 'catalogue not available in this suite' })),
      isTurnInFlight: () => false,
    },
    agentSettings: {
      loadCatalog: () => Promise.resolve(err({ message: 'catalogue not available in this suite' })),
      isTurnInFlight: () => false,
      onAgentSettingsSaved: vi.fn(),
    },
  });

  const record = (name: string) => {
    controllerCalls.push(name);
    return { ok: true as const };
  };

  // The controller is a recorder, so "did the guard stop this?" is answered by
  // whether the controller was touched at all - not only by the returned
  // error. `aemView` is a throwing getter rather than a cast: the IPC layer
  // never reads it, and a getter keeps the object genuinely typed as a
  // `BrowserController` instead of asserting that it is one.
  const controller: BrowserController = {
    get aemView(): AemBrowserView {
      throw new Error('aemView must not be read by the IPC layer');
    },
    get navigationEpoch(): NavigationEpochTracker {
      throw new Error('navigationEpoch must not be read by the IPC layer');
    },
    activeServer: () => {
      throw new Error('activeServer must not be read by the IPC layer');
    },
    currentDocumentUrl: () => {
      throw new Error('currentDocumentUrl must not be read by the IPC layer');
    },
    navigate: () => Promise.resolve(record('navigate')),
    openExternal: () => Promise.resolve(record('openExternal')),
    switchServer: () => Promise.resolve(record('switchServer')),
    goBack: () => Promise.resolve(record('goBack')),
    goForward: () => Promise.resolve(record('goForward')),
    reload: () => Promise.resolve(record('reload')),
    stop: () => record('stop'),
    setViewBounds: () => {
      controllerCalls.push('setViewBounds');
    },
    approveCertificateException: () => Promise.resolve(record('approveCertificateException')),
    hydrateCertificateExceptions: () => Promise.resolve(),
    destroy: () => {
      controllerCalls.push('destroy');
    },
  };

  registerBrowserIpcHandlers({
    controller,
    logger,
    rendererDistDir,
    mainWebContentsId: MAIN_WEB_CONTENTS_ID,
  });
});

/** Named hostile senders, each built lazily so it can use the per-test trusted URL. */
const hostileSenders: readonly { readonly name: string; readonly build: () => unknown }[] = [
  {
    name: "remote AEM content in an otherwise valid window (the plan's 'AEM cannot reach app IPC')",
    build: () =>
      eventWith({
        url: 'https://author.example/editor.html',
        webContentsId: MAIN_WEB_CONTENTS_ID,
      }),
  },
  {
    name: "an identity provider's sign-in page",
    build: () =>
      eventWith({ url: 'https://idp.example/saml', webContentsId: MAIN_WEB_CONTENTS_ID }),
  },
  {
    name: 'a destroyed or navigated-away frame',
    build: () => eventWith({ url: null, webContentsId: MAIN_WEB_CONTENTS_ID }),
  },
];

describe('IPC sender guard wiring', () => {
  it('registers the channels this suite then checks (guards against a silently empty sweep)', () => {
    // Without this, deleting every `ipcMain.handle` call would make the
    // per-channel loops below iterate zero times and still pass.
    expect(invokeHandlers.size).toBeGreaterThanOrEqual(8);
    expect(sendHandlers.size).toBeGreaterThanOrEqual(1);
  });

  for (const hostile of hostileSenders) {
    it(`rejects ${hostile.name}`, async () => {
      const event = hostile.build();

      for (const [channel, handler] of invokeHandlers) {
        const result = await handler(event, {});
        expect(errorCodeOf(result), `${channel} must refuse an untrusted sender`).toBe(
          'untrusted_sender',
        );
      }
      for (const handler of sendHandlers.values()) {
        handler(event, { x: 0, y: 0, width: 10, height: 10 });
      }

      // A refusal that still performed the action would be worthless.
      expect(controllerCalls).toEqual([]);
    });
  }

  it("rejects the app's own local UI when it is a different WebContents", async () => {
    const event = eventWith({ url: trustedUrl, webContentsId: OTHER_WEB_CONTENTS_ID });

    for (const [channel, handler] of invokeHandlers) {
      expect(
        errorCodeOf(await handler(event, {})),
        `${channel} must check the WebContents id`,
      ).toBe('untrusted_sender');
    }
    expect(controllerCalls).toEqual([]);
  });

  it("does NOT reject the app's own renderer - proving the refusals above fail for the right reason", async () => {
    const trusted = eventWith({ url: trustedUrl, webContentsId: MAIN_WEB_CONTENTS_ID });

    // Every channel must get PAST the sender gate. Most then fail on an empty
    // payload or absent settings, which is expected; the assertion is
    // specifically that `untrusted_sender` is not the reason.
    for (const [channel, handler] of invokeHandlers) {
      const result = await handler(trusted, {});
      expect(errorCodeOf(result), `${channel} must not refuse the app's own renderer`).not.toBe(
        'untrusted_sender',
      );
    }
  });
});
