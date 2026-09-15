import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isTrustedBrowserIpcSender,
  type BrowserIpcSenderInfo,
  type TrustedBrowserSenderExpectation,
} from '../../../../src/main/ipc/browser';

/**
 * `isTrustedBrowserIpcSender` is the security boundary that stops an
 * unexpected or compromised renderer from driving the AEM browser
 * (`browserController.ts`'s `navigate`/`switchServer`/certificate-exception
 * mutation). It is a pure function - mirrors
 * `isTrustedLocalSettingsSender`'s test in `settings.test.ts`, including
 * deliberately asserting every *rejection* path, not only the happy one.
 */
describe('isTrustedBrowserIpcSender', () => {
  const expectation: TrustedBrowserSenderExpectation = {
    mainWebContentsId: 1,
    rendererDistDir: path.join('C:', 'app', 'out', 'renderer'),
  };

  function localFileSender(overrides: Partial<BrowserIpcSenderInfo> = {}): BrowserIpcSenderInfo {
    return {
      url: `file:///${path.join('C:', 'app', 'out', 'renderer', 'index.html').replace(/\\/g, '/')}`,
      isMainFrame: true,
      webContentsId: 1,
      ...overrides,
    };
  }

  it("trusts the main frame of the expected window showing the packaged app's own file:// URL", () => {
    expect(isTrustedBrowserIpcSender(localFileSender(), expectation)).toBe(true);
  });

  it('rejects a request with no sender frame (navigated away / destroyed)', () => {
    expect(isTrustedBrowserIpcSender(undefined, expectation)).toBe(false);
  });

  it("rejects a sender whose webContents id does not match the app's main window - the only trusted push target", () => {
    const sender = localFileSender({ webContentsId: 999 });
    expect(isTrustedBrowserIpcSender(sender, expectation)).toBe(false);
  });

  it('rejects a request from a non-top-level (subframe/iframe) frame, even one from the trusted webContents id', () => {
    const sender = localFileSender({ isMainFrame: false });
    expect(isTrustedBrowserIpcSender(sender, expectation)).toBe(false);
  });

  it('rejects a sender whose URL is a remote AEM-like origin rather than an allowed app URL', () => {
    const sender = localFileSender({ url: 'https://author.example/some/page' });
    expect(isTrustedBrowserIpcSender(sender, expectation)).toBe(false);
  });

  it('rejects a sender whose URL is unparsable', () => {
    const sender = localFileSender({ url: 'not a url' });
    expect(isTrustedBrowserIpcSender(sender, expectation)).toBe(false);
  });

  it('trusts the electron-vite dev server origin when ELECTRON_RENDERER_URL is set', () => {
    const previous = process.env['ELECTRON_RENDERER_URL'];
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    try {
      const sender = localFileSender({ url: 'http://localhost:5173/index.html' });
      expect(isTrustedBrowserIpcSender(sender, expectation)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env['ELECTRON_RENDERER_URL'];
      } else {
        process.env['ELECTRON_RENDERER_URL'] = previous;
      }
    }
  });
});
