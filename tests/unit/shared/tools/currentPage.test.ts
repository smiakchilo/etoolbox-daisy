import { describe, expect, it } from 'vitest';
import {
  deriveCurrentPageContext,
  editorPagePath,
  renderCurrentPageContextForModel,
} from '../../../../src/shared';

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
      contentRoots: ['/content'],
      componentRoots: ['/apps'],
    });
  });

  it("carries a host's configured roots through, defaulting when none are given", () => {
    expect(
      deriveCurrentPageContext({
        documentUrl: `${AUTHOR}/content/wknd.html`,
        activeOrigin: AUTHOR,
        contentRoots: ['/content/wknd', '/content/shared'],
        componentRoots: ['/apps/wknd'],
      }),
    ).toEqual({
      origin: AUTHOR,
      url: `${AUTHOR}/content/wknd.html`,
      jcrPath: '/content/wknd',
      contentRoots: ['/content/wknd', '/content/shared'],
      componentRoots: ['/apps/wknd'],
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

  it('reads the content path out of an AEM as a Cloud Service shell fragment', () => {
    expect(derive(`${AUTHOR}/ui#/aem/editor.html/content/hpe/country/us/en/about.html`)).toEqual({
      origin: AUTHOR,
      url: `${AUTHOR}/ui`,
      jcrPath: '/content/hpe/country/us/en/about',
      contentRoots: ['/content'],
      componentRoots: ['/apps'],
    });
    expect(derive(`${AUTHOR}/ui#/aem/sites.html/content/wknd/us/en`)?.jcrPath).toBe(
      '/content/wknd/us/en',
    );
  });

  it('reports no content path for a shell fragment that names none', () => {
    expect(derive(`${AUTHOR}/ui#/aem/`)?.jcrPath).toBeUndefined();
    expect(derive(`${AUTHOR}/ui`)?.jcrPath).toBeUndefined();
  });

  it('reports the host but no content path for a server page that is not content', () => {
    expect(derive(`${AUTHOR}/`)).toEqual({
      origin: AUTHOR,
      url: `${AUTHOR}/`,
      jcrPath: undefined,
      contentRoots: ['/content'],
      componentRoots: ['/apps'],
    });
    expect(derive(`${AUTHOR}/libs/granite/core/content/login.html`)?.jcrPath).toBeUndefined();
  });

  it('trims a trailing slash on a content path', () => {
    expect(derive(`${AUTHOR}/content/wknd/`)?.jcrPath).toBe('/content/wknd');
  });
});

describe('editorPagePath', () => {
  it('reads the page out of the on-prem editor pathname', () => {
    expect(editorPagePath('/editor.html/content/site/page.html')).toBe('/content/site/page.html');
    expect(editorPagePath('/editor.html/content/hpe/country/us/en/about.html')).toBe(
      '/content/hpe/country/us/en/about.html',
    );
  });

  it('reads the page out of an AEM as a Cloud Service shell fragment', () => {
    // The shell puts the real UI path behind an `/aem` app segment in the
    // fragment, not at the start of the pathname.
    expect(editorPagePath('/aem/editor.html/content/hpe/country/us/en/about.html')).toBe(
      '/content/hpe/country/us/en/about.html',
    );
  });

  it('drops a query or fragment the shell route carried after the page', () => {
    expect(editorPagePath('/aem/editor.html/content/site/page.html?appId=aemshell')).toBe(
      '/content/site/page.html',
    );
    expect(editorPagePath('/editor.html/content/site/page.html?wcmmode=disabled')).toBe(
      '/content/site/page.html',
    );
  });

  it('returns undefined for a console route or a bare content path', () => {
    expect(editorPagePath('/sites.html/content/site/page.html')).toBeUndefined();
    expect(editorPagePath('/content/site/page.html')).toBeUndefined();
    expect(editorPagePath('/aem/sites.html/content/site/page.html')).toBeUndefined();
  });

  it('never mistakes a page named editor.html for the editor', () => {
    expect(editorPagePath('/content/editor.html/page.html')).toBeUndefined();
  });

  it('resolves the editor wrapper alone to the empty path, and keeps a non-content remainder', () => {
    expect(editorPagePath('/editor.html')).toBe('');
    expect(editorPagePath('/editor.html/libs/x.html')).toBe('/libs/x.html');
  });
});

describe('renderCurrentPageContextForModel', () => {
  const withPath = {
    origin: AUTHOR,
    url: `${AUTHOR}/content/wknd/us/en.html`,
    jcrPath: '/content/wknd/us/en',
    contentRoots: ['/content'],
    componentRoots: ['/apps'],
  };

  it('includes the host, URL, roots and content path values', () => {
    const rendered = renderCurrentPageContextForModel(withPath);
    expect(rendered).toContain(AUTHOR);
    expect(rendered).toContain(`${AUTHOR}/content/wknd/us/en.html`);
    expect(rendered).toContain('/content/wknd/us/en');
    expect(rendered).toContain('/apps');
  });

  it('reports the roots, and a different rendering when no content path was derived', () => {
    const rendered = renderCurrentPageContextForModel({
      origin: AUTHOR,
      url: `${AUTHOR}/`,
      jcrPath: undefined,
      contentRoots: ['/content/a', '/content/b'],
      componentRoots: ['/apps'],
    });
    expect(rendered).toContain(AUTHOR);
    expect(rendered).toContain('/content/a, /content/b');
    expect(rendered).not.toBe(renderCurrentPageContextForModel(withPath));
  });
});
