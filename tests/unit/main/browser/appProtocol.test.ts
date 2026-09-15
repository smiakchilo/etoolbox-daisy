import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_PROTOCOL_HOST,
  APP_PROTOCOL_SCHEME,
  buildAppUrl,
  resolveAppProtocolFile,
} from '../../../../src/main/browser/appProtocol';

const rendererDistDir = path.join('E:', 'fake-project', 'out', 'renderer');

describe('resolveAppProtocolFile', () => {
  it('resolves the root path to index.html', () => {
    const result = resolveAppProtocolFile(buildAppUrl(''), rendererDistDir);
    expect(result).toEqual({ ok: true, filePath: path.join(rendererDistDir, 'index.html') });
  });

  it('resolves a nested asset path', () => {
    const result = resolveAppProtocolFile(
      `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/assets/index-abc123.js`,
      rendererDistDir,
    );
    expect(result).toEqual({
      ok: true,
      filePath: path.join(rendererDistDir, 'assets', 'index-abc123.js'),
    });
  });

  it('resolves settings.html for the settings window', () => {
    const result = resolveAppProtocolFile(buildAppUrl('settings.html'), rendererDistDir);
    expect(result).toEqual({ ok: true, filePath: path.join(rendererDistDir, 'settings.html') });
  });

  it("harmlessly collapses a forward-slash '..' segment inside the root, because WHATWG URL parsing already normalizes dot-segments before this function ever sees them", () => {
    // `new URL(...).pathname` cannot itself escape above the authority root,
    // so this never reaches the path-containment check as an escape attempt
    // at all - it resolves to a perfectly ordinary in-root file.
    const result = resolveAppProtocolFile(
      `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/../../secrets/settings.json`,
      rendererDistDir,
    );
    expect(result).toEqual({
      ok: true,
      filePath: path.join(rendererDistDir, 'secrets', 'settings.json'),
    });
  });

  it('refuses a backslash-encoded traversal attempt, which WHATWG URL parsing does NOT normalize (backslash is not a URL path separator) but Windows path.resolve does treat as one', () => {
    const result = resolveAppProtocolFile(
      `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/..%5C..%5Csecrets%5Csettings.json`,
      rendererDistDir,
    );
    expect(result).toEqual({ ok: false });
  });

  it('refuses a request for a different scheme', () => {
    const result = resolveAppProtocolFile('https://daisy/index.html', rendererDistDir);
    expect(result).toEqual({ ok: false });
  });

  it('refuses a request for an unexpected host under the app scheme', () => {
    const result = resolveAppProtocolFile(
      `${APP_PROTOCOL_SCHEME}://not-daisy/index.html`,
      rendererDistDir,
    );
    expect(result).toEqual({ ok: false });
  });

  it('refuses a malformed URL', () => {
    const result = resolveAppProtocolFile('not a url', rendererDistDir);
    expect(result).toEqual({ ok: false });
  });
});
