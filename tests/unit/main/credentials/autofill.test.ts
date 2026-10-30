import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachCredentialAutofill, originOf } from '../../../../src/main/credentials/autofill';
import type { StoredCredential } from '../../../../src/main/credentials/credentialVault';
import { flushMicrotasks } from '../../../support/asyncWaits';
import { createFakeWebContents, type FakeWebContents } from '../../../support/fakeWebContents';
import { makeRecordingLogger } from '../../../support/ipcHandlerHarness';

/**
 * The prefill wiring: which events trigger it, which origins are eligible, and
 * that a rejected injection never becomes an unhandled rejection. The script
 * itself is covered by `fillScript.test.ts`.
 */

const ORIGIN = 'https://author.example.com';

function credential(username: string, password: string): StoredCredential {
  return {
    origin: ORIGIN,
    username,
    password,
    hasPassword: password.length > 0,
    lastUsedAt: 1_000,
  };
}

let fake: FakeWebContents;
let execute: ReturnType<typeof vi.fn<(code: string) => Promise<boolean>>>;
let url: string;
let destroyed: boolean;

beforeEach(() => {
  fake = createFakeWebContents();
  execute = vi.fn<(code: string) => Promise<boolean>>(() => Promise.resolve(true));
  url = `${ORIGIN}/libs/granite/core/content/login.html`;
  destroyed = false;
  fake.define('getURL', () => url);
  fake.define('isDestroyed', () => destroyed);
  fake.define('executeJavaScript', execute);
});

async function loadDocument(): Promise<void> {
  fake.emit('dom-ready');
  await flushMicrotasks();
}

function attach(
  credentials: readonly StoredCredential[],
  logger = makeRecordingLogger(),
  usernames: readonly string[] = credentials.map((entry) => entry.username),
): { detach: () => void; logger: ReturnType<typeof makeRecordingLogger> } {
  const detach = attachCredentialAutofill(fake.webContents, {
    listForOrigin: (origin) => credentials.filter((entry) => entry.origin === origin),
    recentUsernames: () => usernames,
    logger,
  });
  return { detach, logger };
}

describe('originOf', () => {
  it('names a canonical origin', () => {
    expect(originOf(`${ORIGIN}/content/page.html?x=1#y`)).toBe(ORIGIN);
  });

  it('refuses anything that is not http(s)', () => {
    for (const value of ['file:///c:/x', 'about:blank', 'chrome://settings', '', 'nonsense']) {
      expect(originOf(value)).toBeUndefined();
    }
  });
});

describe('attachCredentialAutofill', () => {
  it('injects the origin’s saved sign-in on dom-ready', async () => {
    attach([credential('admin', 'secret')]);

    await loadDocument();

    expect(execute).toHaveBeenCalledTimes(1);
    const script = execute.mock.calls[0]?.[0];
    expect(script).toContain('admin');
    expect(script).toContain('secret');
  });

  it('offers the remembered usernames on an origin with no saved sign-in', async () => {
    url = 'https://other.example.com/';
    attach([credential('admin', 'secret')]);

    await loadDocument();

    // The same email is the address at Adobe and at the identity provider
    // behind it, so the suggestion list is deliberately not origin-scoped.
    expect(execute).toHaveBeenCalledTimes(1);
    const script = execute.mock.calls[0]?.[0];
    expect(script).toContain('admin');
    expect(script).not.toContain('secret');
  });

  it('injects nothing at all when nothing is remembered', async () => {
    attach([]);

    await loadDocument();

    expect(execute).not.toHaveBeenCalled();
  });

  it('injects nothing into a non-http document', async () => {
    url = 'file:///c:/app/index.html';
    attach([credential('admin', 'secret')]);

    await loadDocument();

    expect(execute).not.toHaveBeenCalled();
  });

  it('re-runs on an in-page navigation, but only for the main frame', async () => {
    attach([credential('admin', 'secret')]);

    fake.emit('did-navigate-in-page', {}, `${ORIGIN}/login`, false);
    await flushMicrotasks();
    expect(execute).not.toHaveBeenCalled();

    fake.emit('did-navigate-in-page', {}, `${ORIGIN}/login`, true);
    await flushMicrotasks();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does nothing once the contents are destroyed', async () => {
    attach([credential('admin', 'secret')]);
    destroyed = true;

    await loadDocument();

    expect(execute).not.toHaveBeenCalled();
  });

  it('swallows a rejected injection and logs it', async () => {
    execute.mockRejectedValueOnce(new Error('frame gone'));
    const { logger } = attach([credential('admin', 'secret')]);

    await loadDocument();

    expect(logger.warn).toHaveBeenCalledWith('CREDENTIAL_PREFILL_FAILED', { count: 1 });
  });

  it('logs a successful prefill against the origin, never the credential', async () => {
    const { logger } = attach([credential('admin', 'secret')]);

    await loadDocument();

    const [code, fields] = logger.info.mock.calls[0] ?? [];
    expect(code).toBe('CREDENTIAL_PREFILLED');
    expect(fields?.url?.origin).toBe(ORIGIN);
    expect(JSON.stringify(fields)).not.toContain('secret');
  });

  it('does not log a fill when the page had no form to fill', async () => {
    execute.mockResolvedValue(false);
    const { logger } = attach([credential('admin', 'secret')]);

    await loadDocument();

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('stops prefilling after detach', async () => {
    const { detach } = attach([credential('admin', 'secret')]);
    detach();

    await loadDocument();

    expect(execute).not.toHaveBeenCalled();
    expect(fake.listenerCount('dom-ready')).toBe(0);
    expect(fake.listenerCount('did-navigate-in-page')).toBe(0);
  });
});
