import { describe, expect, it } from 'vitest';
import { deriveCurrentPageContext, renderCurrentPageContextForModel } from '../../../../src/shared';

/**
 * Unit tests for `src/shared/tools/core/currentPage.ts` - the pure projection
 * from a live browser-pane URL to what the agent is allowed to know about
 * "where the user is".
 *
 * The two properties that matter most are the boundary rules: nothing is
 * derived when the pane is not on the active server's own origin (so an
 * SSO/IdP URL can never reach the model), and only `/content` is ever named as
 * a content path.
 */

const AUTHOR = 'https://author.example';

function derive(documentUrl: string | undefined): ReturnType<typeof deriveCurrentPageContext> {
  return deriveCurrentPageContext({ documentUrl, activeOrigin: AUTHOR });
}

describe('deriveCurrentPageContext', () => {
  it('returns undefined for a missing or empty URL', () => {
    expect(derive(undefined)).toBeUndefined();
    expect(derive('')).toBeUndefined();
  });

  it('returns undefined for an unparseable URL or a non-http(s) scheme', () => {
    expect(derive('not a url')).toBeUndefined();
    expect(derive('about:blank')).toBeUndefined();
    expect(derive('file:///C:/content/wknd.html')).toBeUndefined();
  });

  it('returns undefined when the pane is on any origin other than the active server - so an SSO/IdP URL never reaches the model', () => {
    expect(derive('https://idp.example/authorize?client_id=x')).toBeUndefined();
    expect(derive('https://author.example.evil.test/content/wknd.html')).toBeUndefined();
    expect(derive('http://author.example/content/wknd.html')).toBeUndefined(); // scheme differs
  });

  it('reports the origin and a URL stripped of query and fragment', () => {
    expect(derive(`${AUTHOR}/editor.html/content/wknd/us/en.html?wcmmode=disabled#x`)).toEqual({
      origin: AUTHOR,
      url: `${AUTHOR}/editor.html/content/wknd/us/en.html`,
      jcrPath: '/content/wknd/us/en',
    });
  });

  it('derives the content path from editor, sites and direct content URLs', () => {
    expect(derive(`${AUTHOR}/editor.html/content/wknd/us/en.html`)?.jcrPath).toBe(
      '/content/wknd/us/en',
    );
    expect(derive(`${AUTHOR}/sites.html/content/wknd/us/en`)?.jcrPath).toBe('/content/wknd/us/en');
    expect(derive(`${AUTHOR}/content/wknd/us/en.html`)?.jcrPath).toBe('/content/wknd/us/en');
  });

  it('leaves a DAM asset path intact', () => {
    expect(derive(`${AUTHOR}/assets.html/content/dam/wknd/asset.jpeg`)?.jcrPath).toBe(
      '/content/dam/wknd/asset.jpeg',
    );
  });

  it('reads the content path out of a damadmin fragment, since the pathname is the app route', () => {
    expect(derive(`${AUTHOR}/damadmin#/content/dam/wknd`)?.jcrPath).toBe('/content/dam/wknd');
  });

  it('reports the host but no content path for a server page that is not content', () => {
    expect(derive(`${AUTHOR}/`)).toEqual({ origin: AUTHOR, url: `${AUTHOR}/`, jcrPath: undefined });
    expect(derive(`${AUTHOR}/libs/granite/core/content/login.html`)?.jcrPath).toBeUndefined();
  });

  it('trims a trailing slash on a content path', () => {
    expect(derive(`${AUTHOR}/content/wknd/`)?.jcrPath).toBe('/content/wknd');
  });
});

describe('renderCurrentPageContextForModel', () => {
  it('names the host and content path and tells the model how to read "this page"/"this host"', () => {
    const rendered = renderCurrentPageContextForModel({
      origin: AUTHOR,
      url: `${AUTHOR}/content/wknd/us/en.html`,
      jcrPath: '/content/wknd/us/en',
    });
    expect(rendered).toContain(`Host: ${AUTHOR}`);
    expect(rendered).toContain('Content path: /content/wknd/us/en');
    expect(rendered).toContain('"this page"');
  });

  it('names the host but withholds a content path, and says so, when none was derived', () => {
    const rendered = renderCurrentPageContextForModel({
      origin: AUTHOR,
      url: `${AUTHOR}/`,
      jcrPath: undefined,
    });
    expect(rendered).toContain(`Host: ${AUTHOR}`);
    expect(rendered).not.toContain('Content path:');
    expect(rendered).toContain('No content path is available');
  });
});
