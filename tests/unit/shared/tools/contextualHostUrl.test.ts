import { describe, expect, it } from 'vitest';
import { isCarryablePagePath, resolveContextualHostUrl } from '../../../../src/shared';

const LOCAL = 'http://localhost:4502';
const CLOUD = 'https://acme.adobe.com';
const OTHER = 'https://stage.acme.example';
const CONFIGURED = [LOCAL, CLOUD, OTHER];

function resolve(currentUrl: string, targetOrigin = CLOUD, configured = CONFIGURED): string {
  return resolveContextualHostUrl({ currentUrl, configuredOrigins: configured, targetOrigin });
}

describe('resolveContextualHostUrl - carrying the open page to another host', () => {
  it('re-targets a web-content page at the new origin', () => {
    expect(resolve(`${LOCAL}/content/acme/us/en/home.html`)).toBe(
      `${CLOUD}/content/acme/us/en/home.html`,
    );
  });

  it('carries the page editor form unchanged', () => {
    expect(resolve(`${LOCAL}/editor.html/content/acme/us/en/home.html`)).toBe(
      `${CLOUD}/editor.html/content/acme/us/en/home.html`,
    );
  });

  it('carries the query, because consoles keep the content path in it', () => {
    expect(
      resolve(
        `${LOCAL}/mnt/overlay/wcm/core/content/sites/properties.html?item=/content/acme/us/en`,
      ),
    ).toBe(`${CLOUD}/mnt/overlay/wcm/core/content/sites/properties.html?item=/content/acme/us/en`);
    expect(resolve(`${LOCAL}/content/acme/home.html?wcmmode=disabled`)).toBe(
      `${CLOUD}/content/acme/home.html?wcmmode=disabled`,
    );
  });

  it('carries the fragment, because CRXDE keeps the node path in it', () => {
    expect(resolve(`${LOCAL}/crx/de/index.jsp#/content/acme/us/en/jcr%3Acontent`)).toBe(
      `${CLOUD}/crx/de/index.jsp#/content/acme/us/en/jcr%3Acontent`,
    );
  });

  it('carries every allowlisted console shape', () => {
    for (const path of [
      '/sites.html/content/acme',
      '/assets.html/content/dam/acme',
      '/assetdetails.html/content/dam/acme/a.jpg',
      '/aem/start.html',
      '/crx/packmgr/index.jsp#/etc/packages/acme/site-1.0.zip',
      '/crx/explorer/index.jsp',
      '/system/console/bundles',
      '/system/console/configMgr',
      '/ui#/aem/sites.html/content/acme',
      '/content/dam/acme/a.jpg',
    ]) {
      expect(resolve(`${LOCAL}${path}`)).toBe(`${CLOUD}${path}`);
    }
  });

  it('keeps percent-encoding byte for byte rather than re-encoding it', () => {
    expect(resolve(`${LOCAL}/content/acme/a%20b/jcr%3Acontent.html`)).toBe(
      `${CLOUD}/content/acme/a%20b/jcr%3Acontent.html`,
    );
  });

  it('carries the page to an origin with a non-default port and an http scheme', () => {
    expect(resolve(`${CLOUD}/content/acme/home.html`, LOCAL)).toBe(
      `${LOCAL}/content/acme/home.html`,
    );
  });

  it('takes the origin only from the target, never from the current URL', () => {
    expect(resolve(`${LOCAL}/content/acme/home.html`, OTHER)).toBe(
      `${OTHER}/content/acme/home.html`,
    );
  });
});

describe('resolveContextualHostUrl - falling back to the bare origin', () => {
  it('opens the root when the target is the host already open', () => {
    expect(resolve(`${LOCAL}/content/acme/home.html`, LOCAL)).toBe(LOCAL);
  });

  it('opens the root for a path outside the allowlist', () => {
    for (const path of [
      '/libs/granite/core/content/login.html?resource=%2Fcontent%2Facme',
      '/bin/querybuilder.json?path=/content',
      '/saml_login',
      '/',
      '/contentious/page.html',
      '/crxde/page.html',
      '/systemic/console',
    ]) {
      expect(resolve(`${LOCAL}${path}`)).toBe(CLOUD);
    }
  });

  it('never carries a logout, but only under /crx and /system', () => {
    for (const path of [
      '/system/sling/logout.html',
      '/system/sling/logout',
      '/system/sling/logout?resource=/content/acme',
      '/crx/de/logout.jsp',
      '/crx/explorer/Logout.jsp',
    ]) {
      expect(resolve(`${LOCAL}${path}`)).toBe(CLOUD);
    }
    // A content page that happens to be called logout is an ordinary page.
    expect(resolve(`${LOCAL}/content/acme/us/en/logout.html`)).toBe(
      `${CLOUD}/content/acme/us/en/logout.html`,
    );
    expect(resolve(`${LOCAL}/system/console/logoutput`)).toBe(`${CLOUD}/system/console/logoutput`);
  });

  it('opens the root for an allowlisted path that carries an authentication parameter', () => {
    for (const tail of [
      '?code=abc',
      '?SAMLResponse=xyz',
      '?foo=1&state=s',
      '?access_token=t',
      '?j_password=p',
      '#access_token=t',
      '#/page&id_token=t',
    ]) {
      expect(resolve(`${LOCAL}/content/acme/home.html${tail}`)).toBe(CLOUD);
    }
  });

  it('does not mistake a path that merely contains an auth word for an auth parameter', () => {
    expect(resolve(`${LOCAL}/content/acme/code/state/home.html?codex=1`)).toBe(
      `${CLOUD}/content/acme/code/state/home.html?codex=1`,
    );
  });

  it('opens the root when the current page is not on a configured host', () => {
    expect(resolve('https://login.idp.example/content/acme/home.html')).toBe(CLOUD);
    expect(resolve(`${LOCAL}/content/acme/home.html`, CLOUD, [CLOUD])).toBe(CLOUD);
  });

  it('opens the root when there is no usable current URL', () => {
    for (const current of ['', 'about:blank', 'not a url', 'file:///content/x.html']) {
      expect(resolve(current)).toBe(CLOUD);
    }
  });

  it('opens the root when the current URL carries userinfo', () => {
    expect(resolve('http://user:pw@localhost:4502/content/acme/home.html')).toBe(CLOUD);
  });

  it('opens the root when the carried path is longer than a browser path may be', () => {
    expect(resolve(`${LOCAL}/content/${'a'.repeat(2100)}.html`)).toBe(CLOUD);
  });

  it('opens the root when dot segments would have walked out of an allowlisted root', () => {
    expect(resolve(`${LOCAL}/content/../libs/granite/core/content/login.html`)).toBe(CLOUD);
  });
});

describe('isCarryablePagePath', () => {
  it('matches a whole leading segment only', () => {
    expect(isCarryablePagePath('/content')).toBe(true);
    expect(isCarryablePagePath('/content/x')).toBe(true);
    expect(isCarryablePagePath('/contents/x')).toBe(false);
    expect(isCarryablePagePath('/crx/de')).toBe(true);
    expect(isCarryablePagePath('/crx/de/index.jsp')).toBe(true);
    expect(isCarryablePagePath('/crx/packmgr/index.jsp')).toBe(true);
    expect(isCarryablePagePath('/crxde/x')).toBe(false);
    expect(isCarryablePagePath('/system/console')).toBe(true);
    expect(isCarryablePagePath('/systemic/x')).toBe(false);
    expect(isCarryablePagePath('/mnt/overlay/x')).toBe(true);
    expect(isCarryablePagePath('/mnt/other')).toBe(false);
  });
});
