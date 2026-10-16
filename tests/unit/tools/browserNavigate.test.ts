import { describe, expect, it, vi } from 'vitest';
import { NO_SKILLS } from '../../support/fakeSkillHost';
import {
  BROWSER_NAVIGATE_TOOL_NAME,
  browserNavigateArgsSchema,
  BROWSER_NAVIGATE_PLACE_PATHS,
  completeBrowserPath,
  createBrowserNavigateExecutor,
  resolveNavigateHost,
  shapeModeBrowserPath,
} from '../../../src/tools/browser-navigate/browserNavigate';
import {
  type ConfiguredHostInfo,
  type OpenPageOutcome,
  type OpenPageTarget,
  type ToolHost,
  newServerId,
} from '../../../src/shared';
import { createCountingIdGenerator } from '../../support/testIds';

const ids = createCountingIdGenerator('nav');

const HPE_DEV: ConfiguredHostInfo = {
  serverId: newServerId(ids),
  label: 'HPE DEV',
  origin: 'https://author.example',
  contentRoots: ['/content'],
  componentRoots: ['/apps'],
  damRoots: ['/content/dam'],
  contentPriorityPaths: [],
};
const STAGING: ConfiguredHostInfo = {
  serverId: newServerId(ids),
  label: 'Staging',
  origin: 'https://stage.example',
  contentRoots: ['/content'],
  componentRoots: ['/apps'],
  damRoots: ['/content/dam'],
  contentPriorityPaths: [],
};
const DUP: ConfiguredHostInfo = { ...STAGING, serverId: newServerId(ids), label: 'HPE DEV' };

function makeHost(options: {
  hosts?: readonly ConfiguredHostInfo[];
  currentOrigin?: string;
  outcome?: OpenPageOutcome;
  onOpen?: (target: OpenPageTarget) => void;
}): ToolHost {
  return {
    bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
    currentContext: () => {
      throw new Error('browser_navigate must never ask for an AEM context');
    },
    environmentFacts: () =>
      options.currentOrigin === undefined
        ? undefined
        : {
            origin: options.currentOrigin,
            contentRoots: ['/content'],
            componentRoots: ['/apps'],
            damRoots: ['/content/dam'],
            contentPriorityPaths: [],
          },
    configuredHosts: () => options.hosts ?? [HPE_DEV, STAGING],
    skills: NO_SKILLS,
    openPage: (target) => {
      options.onOpen?.(target);
      return Promise.resolve(
        options.outcome ?? { kind: 'opened', url: `${target.path}`, switched: false },
      );
    },
    requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
    clock: () => 1,
    idGenerator: ids,
    invokeTool: () => Promise.reject(new Error('not used')),
  };
}

const callContext = { toolCallId: 'call-1' as never, signal: undefined };

describe('browserNavigateArgsSchema', () => {
  it('rejects a path that is not a bare browser path', () => {
    for (const path of ['content/x', '//evil.example/x', 'https://evil.example/x', '/a b', '']) {
      expect(browserNavigateArgsSchema.safeParse({ path }).success).toBe(false);
    }
  });

  it('accepts a content page, an editor path, and a tool path', () => {
    for (const path of ['/content/wknd.html', '/editor.html/content/wknd.html', '/crx/de']) {
      expect(browserNavigateArgsSchema.safeParse({ path }).success).toBe(true);
    }
  });

  it('accepts a mode with the raw repository path it takes', () => {
    const parsed = browserNavigateArgsSchema.safeParse({
      mode: 'sites',
      path: '/content/hpe/languages/jp-apj/home',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a mode combined with an already-shaped browser path', () => {
    for (const [mode, path] of [
      ['sites', '/sites.html/content/wknd/us/en'],
      ['assets', '/assets.html/content/dam/brand'],
      ['edit', '/editor.html/content/wknd/us/en'],
      ['asset_details', '/assetdetails.html/content/dam/brand/hero.jpg'],
      ['crxde', '/crx/de/index.jsp#/content/wknd/us/en'],
      ['properties', '/mnt/overlay/wcm/core/content/sites/properties.html?item=/content/wknd'],
    ] as const) {
      const parsed = browserNavigateArgsSchema.safeParse({ mode, path });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects a mode combined with a query or fragment - a raw repository path carries none', () => {
    expect(
      browserNavigateArgsSchema.safeParse({ mode: 'view', path: '/content/x?wcmmode=disabled' })
        .success,
    ).toBe(false);
    expect(
      browserNavigateArgsSchema.safeParse({ mode: 'view', path: '/content/x#frag' }).success,
    ).toBe(false);
  });
});

describe('shapeModeBrowserPath', () => {
  it('builds every display mode from the raw repository path', () => {
    expect(shapeModeBrowserPath('view', '/content/wknd/us/en')).toBe('/content/wknd/us/en.html');
    expect(shapeModeBrowserPath('edit', '/content/wknd/us/en')).toBe(
      '/editor.html/content/wknd/us/en.html',
    );
    expect(shapeModeBrowserPath('sites', '/content/hpe/languages/jp-apj/home')).toBe(
      '/sites.html/content/hpe/languages/jp-apj/home',
    );
    expect(shapeModeBrowserPath('assets', '/content/dam/brand')).toBe(
      '/assets.html/content/dam/brand',
    );
    expect(shapeModeBrowserPath('crxde', '/content/site/alpha/jcr:content/myComponent')).toBe(
      '/crx/de/index.jsp#/content/site/alpha/jcr%3Acontent/myComponent',
    );
    expect(shapeModeBrowserPath('asset_details', '/content/dam/brand/hero.jpg')).toBe(
      '/assetdetails.html/content/dam/brand/hero.jpg',
    );
    expect(shapeModeBrowserPath('properties', '/content/wknd/us/en')).toBe(
      '/mnt/overlay/wcm/core/content/sites/properties.html?item=/content/wknd/us/en',
    );
  });

  it('owns the .html rules: a raw asset URL stays raw, a console carries no .html, a page keeps exactly one', () => {
    expect(shapeModeBrowserPath('view', '/content/dam/brand/hero.jpg')).toBe(
      '/content/dam/brand/hero.jpg',
    );
    expect(shapeModeBrowserPath('sites', '/content/wknd/us/en.html')).toBe(
      '/sites.html/content/wknd/us/en',
    );
    expect(shapeModeBrowserPath('assets', '/content/dam/brand/hero.jpg')).toBe(
      '/assets.html/content/dam/brand/hero.jpg',
    );
    expect(shapeModeBrowserPath('view', '/content/wknd/us/en.html')).toBe(
      '/content/wknd/us/en.html',
    );
  });
});

describe('completeBrowserPath', () => {
  it('appends .html to an extensionless page path, also under the editor prefix', () => {
    expect(completeBrowserPath('/content/wknd/us/en')).toBe('/content/wknd/us/en.html');
    expect(completeBrowserPath('/editor.html/content/wknd/us/en')).toBe(
      '/editor.html/content/wknd/us/en.html',
    );
  });

  it('leaves every other path verbatim', () => {
    for (const path of [
      '/content/wknd/us/en.html',
      '/content', // a bare root, not a page
      '/content/dam/brand', // the DAM subtree is assets, not pages
      '/content/dam/brand/hero.jpg',
      '/sites.html/content/wknd/us/en', // a console form owns its own suffix
      '/crx/de/',
      '/system/console/configMgr',
      '/content/wknd/us/en?wcmmode=disabled', // a deliberately built query form
    ]) {
      expect(completeBrowserPath(path)).toBe(path);
    }
  });
});

describe('resolveNavigateHost', () => {
  it('matches a label case-insensitively', () => {
    const result = resolveNavigateHost(
      { host: 'hpe dev', path: '/x' },
      [HPE_DEV, STAGING],
      undefined,
    );
    expect(result).toEqual({ ok: true, value: HPE_DEV });
  });

  it('reports the configured labels when none match', () => {
    const result = resolveNavigateHost({ host: 'Prod', path: '/x' }, [HPE_DEV, STAGING], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('unknown_host');
    expect(result.error.message).toContain('HPE DEV');
    expect(result.error.message).toContain('Staging');
  });

  it('refuses an ambiguous label', () => {
    const result = resolveNavigateHost({ host: 'HPE DEV', path: '/x' }, [HPE_DEV, DUP], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('ambiguous_host');
  });

  it('falls back to the current host when none is named', () => {
    const result = resolveNavigateHost({ path: '/x' }, [HPE_DEV, STAGING], STAGING.origin);
    expect(result).toEqual({ ok: true, value: STAGING });
  });

  it('fails when no host is named and the pane is on no configured host', () => {
    const result = resolveNavigateHost({ path: '/x' }, [HPE_DEV], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('no_current_host');
  });
});

describe('createBrowserNavigateExecutor', () => {
  it('opens the resolved host and reports the URL', async () => {
    const onOpen = vi.fn();
    const host = makeHost({
      outcome: { kind: 'opened', url: 'https://author.example/content/wknd.html', switched: false },
      onOpen,
    });
    const executor = createBrowserNavigateExecutor(host);

    const result = await executor({ host: 'HPE DEV', path: '/content/wknd.html' }, callContext);

    expect(onOpen).toHaveBeenCalledWith({
      serverId: HPE_DEV.serverId,
      path: '/content/wknd.html',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value as Readonly<Record<string, unknown>>;
    expect(payload['operation']).toBe(BROWSER_NAVIGATE_TOOL_NAME);
    expect(payload['hostLabel']).toBe('HPE DEV');
    expect(payload['url']).toBe('https://author.example/content/wknd.html');
    expect(typeof payload['textResultForLlm']).toBe('string');
  });

  it('defaults to the current host', async () => {
    const onOpen = vi.fn();
    const host = makeHost({ currentOrigin: STAGING.origin, onOpen });
    await createBrowserNavigateExecutor(host)({ path: '/crx/de' }, callContext);
    expect(onOpen).toHaveBeenCalledWith({ serverId: STAGING.serverId, path: '/crx/de' });
  });

  it('opens the mode-shaped path and reports the mode', async () => {
    const onOpen = vi.fn();
    const host = makeHost({ onOpen });
    const result = await createBrowserNavigateExecutor(host)(
      { host: 'HPE DEV', path: '/content/hpe/languages/jp-apj/home', mode: 'sites' },
      callContext,
    );
    expect(onOpen).toHaveBeenCalledWith({
      serverId: HPE_DEV.serverId,
      path: '/sites.html/content/hpe/languages/jp-apj/home',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value as Readonly<Record<string, unknown>>;
    expect(payload['mode']).toBe('sites');
  });

  it('completes an extensionless page path when no mode was given', async () => {
    const onOpen = vi.fn();
    const host = makeHost({ onOpen });
    await createBrowserNavigateExecutor(host)(
      { host: 'HPE DEV', path: '/content/wknd/us/en' },
      callContext,
    );
    expect(onOpen).toHaveBeenCalledWith({
      serverId: HPE_DEV.serverId,
      path: '/content/wknd/us/en.html',
    });
  });

  it('never reaches openPage for an invalid path', async () => {
    const onOpen = vi.fn();
    const host = makeHost({ onOpen });
    const result = await createBrowserNavigateExecutor(host)(
      { host: 'HPE DEV', path: 'https://evil.example' },
      callContext,
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('maps a TLS network failure to TLS_ERROR', async () => {
    const host = makeHost({
      outcome: {
        kind: 'network_error',
        errorCode: 'ERR_CERT_AUTHORITY_INVALID',
        message: 'bad cert',
      },
    });
    const result = await createBrowserNavigateExecutor(host)(
      { host: 'HPE DEV', path: '/content/x.html' },
      callContext,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TLS_ERROR');
  });

  it('maps a missing view to a precondition failure', async () => {
    const host = makeHost({ outcome: { kind: 'no_view' } });
    const result = await createBrowserNavigateExecutor(host)(
      { host: 'HPE DEV', path: '/content/x.html' },
      callContext,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('browserNavigateArgsSchema - places and repository roots', () => {
  it('accepts a place alone and refuses it with a path or a mode', () => {
    expect(browserNavigateArgsSchema.safeParse({ place: 'package_manager' }).success).toBe(true);
    expect(
      browserNavigateArgsSchema.safeParse({ place: 'crxde', path: '/content/x' }).success,
    ).toBe(false);
    expect(browserNavigateArgsSchema.safeParse({ place: 'crxde', mode: 'sites' }).success).toBe(
      false,
    );
  });

  it('requires a path or a place', () => {
    expect(browserNavigateArgsSchema.safeParse({}).success).toBe(false);
    expect(browserNavigateArgsSchema.safeParse({ host: 'HPE DEV' }).success).toBe(false);
  });

  it('refuses a mode on a path outside the repository roots, pointing at place', () => {
    for (const path of ['/system/console', '/crx/de/index.jsp', '/sites.html']) {
      const parsed = browserNavigateArgsSchema.safeParse({ mode: 'sites', path });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0]?.message).toBeTruthy();
    }
  });

  it('accepts the admin alias', () => {
    expect(
      browserNavigateArgsSchema.safeParse({ mode: 'admin', path: '/content/wknd' }).success,
    ).toBe(true);
    expect(shapeModeBrowserPath('admin', '/content/wknd/us/en')).toBe(
      '/sites.html/content/wknd/us/en',
    );
  });
});

describe('resolveNavigateHost - tolerant host forms', () => {
  const LOCAL: ConfiguredHostInfo = {
    ...HPE_DEV,
    serverId: newServerId(ids),
    label: 'HPE Local',
    origin: 'http://cloud.localhost.hpe.com:4502',
  };
  const PLAIN: ConfiguredHostInfo = {
    ...HPE_DEV,
    serverId: newServerId(ids),
    label: 'Localhost',
    origin: 'http://localhost:4502',
  };
  const hosts = [LOCAL, PLAIN, HPE_DEV];

  it('accepts the whole origin the page context shows (the 2026-10-14 live failure)', () => {
    const result = resolveNavigateHost(
      { host: 'http://cloud.localhost.hpe.com:4502', path: '/x' },
      hosts,
      undefined,
    );
    expect(result).toEqual({ ok: true, value: LOCAL });
  });

  it('accepts host:port and a bare hostname, and prefers a label over a hostname', () => {
    expect(
      resolveNavigateHost({ host: 'cloud.localhost.hpe.com:4502', path: '/x' }, hosts, undefined),
    ).toEqual({ ok: true, value: LOCAL });
    expect(resolveNavigateHost({ host: 'author.example', path: '/x' }, hosts, undefined)).toEqual({
      ok: true,
      value: HPE_DEV,
    });
    expect(resolveNavigateHost({ host: 'localhost', path: '/x' }, hosts, undefined)).toEqual({
      ok: true,
      value: PLAIN,
    });
  });
});

describe('createBrowserNavigateExecutor - places', () => {
  it('opens the application-owned path of a place', async () => {
    const onOpen = vi.fn();
    const host = makeHost({ onOpen });
    const result = await createBrowserNavigateExecutor(host)(
      { host: 'HPE DEV', place: 'package_manager' },
      callContext,
    );
    expect(onOpen).toHaveBeenCalledWith({
      serverId: HPE_DEV.serverId,
      path: '/crx/packmgr/index.jsp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as Readonly<Record<string, unknown>>)['place']).toBe('package_manager');
  });

  it('knows a path for every place', () => {
    for (const path of Object.values(BROWSER_NAVIGATE_PLACE_PATHS)) {
      expect(path.startsWith('/')).toBe(true);
    }
  });
});
