import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  startAemOrigin,
  type AemOrigin,
} from './support/testAemServer';

/**
 * The Sling-shaped JSON endpoints added to the fixture for step 06 are only
 * useful if they really behave the way Sling does. Asserting that here, against
 * the fixture directly over plain HTTP, keeps the far slower Electron E2E from
 * having to distinguish "the app is wrong" from "the fixture is wrong" - a
 * confusion that has cost this project real time before.
 */
describe('fixture Sling JSON rendering', () => {
  let aem: AemOrigin;
  let cookie: string;

  beforeAll(async () => {
    aem = await startAemOrigin({});
    // Sign in the way a browser would, and keep the Set-Cookie for later calls.
    const form = new URLSearchParams({
      username: FIXTURE_USERNAME,
      password: FIXTURE_PASSWORD,
      next: '/content/site',
    });
    const login = await fetch(aem.url('/login'), {
      method: 'POST',
      body: form,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const setCookie = login.headers.getSetCookie();
    expect(setCookie.length).toBeGreaterThan(0);
    cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
  });

  afterAll(async () => {
    await aem.close();
  });

  const get = (path: string): Promise<Response> =>
    fetch(aem.url(path), { headers: { cookie }, redirect: 'manual' });

  it('serves depth 0 as properties only, with no child nodes', async () => {
    const response = await get('/content/site.0.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body: unknown = await response.json();
    expect(body).toMatchObject({ 'jcr:primaryType': 'cq:Page', 'jcr:path': '/content/site' });
    expect(Object.keys(body as object)).not.toContain('jcr:content');
  });

  it('serves depth 1 as properties plus immediate children', async () => {
    const body: unknown = await (await get('/content/site.1.json')).json();
    const keys = Object.keys(body as object);
    expect(keys).toContain('jcr:content');
    expect(keys).toContain('child-two');
    // Immediate children only: the child must not itself carry grandchildren.
    const child: unknown = (body as Record<string, unknown>)['jcr:content'];
    expect(Object.keys(child as object)).not.toContain('jcr:content');
  });

  it('rejects a non-numeric recursion selector with 400, as Sling does', async () => {
    const response = await get('/content/site.bogus.json');
    expect(response.status).toBe(400);
  });

  it('answers the too-many-results case with HTTP 300 and a JSON ARRAY body', async () => {
    const response = await get('/content/too-many.1.json');
    expect(response.status).toBe(300);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body: unknown = await response.json();
    // The trap: valid JSON, JSON content type, but an array of URLs - not data.
    expect(Array.isArray(body)).toBe(true);
  });

  it('can answer HTML for a .json request', async () => {
    const response = await get('/content/html-not-json.0.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('serves 403, 404 and malformed JSON on demand', async () => {
    expect((await get('/content/forbidden.0.json')).status).toBe(403);
    expect((await get('/content/missing.0.json')).status).toBe(404);
    const broken = await get('/content/broken-json.0.json');
    expect(broken.status).toBe(200);
    await expect(broken.json()).rejects.toThrow();
  });

  it('serves a payload larger than 1 MiB', async () => {
    const body = await (await get('/content/large.0.json')).text();
    expect(body.length).toBeGreaterThan(1024 * 1024);
  });

  it('redirects an UNAUTHENTICATED .json request to the login page', async () => {
    // No cookie header: this is the case that proves a tool fetch by an
    // unauthenticated app never receives data.
    const response = await fetch(aem.url('/content/site.0.json'), { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('preserves a namespaced node name in the request path', async () => {
    const body: unknown = await (await get('/content/site/jcr:content.0.json')).json();
    expect(body).toMatchObject({ 'jcr:path': '/content/site/jcr:content' });
  });

  it('keeps a dot inside a node name as part of the resource path', async () => {
    // Sling resolves the LONGEST existing prefix, so `my.file.pdf` is the node
    // name and only `0` is the selector. A parser that stopped at the first dot
    // would report `/content/my` here and quietly serve the wrong resource.
    const body: unknown = await (await get('/content/my.file.pdf.0.json')).json();
    expect(body).toMatchObject({ 'jcr:path': '/content/my.file.pdf' });
  });

  it('treats a bare .json as depth 0', async () => {
    const body: unknown = await (await get('/content/site.json')).json();
    expect(Object.keys(body as object)).not.toContain('jcr:content');
    expect(body).toMatchObject({ 'jcr:path': '/content/site' });
  });
});
