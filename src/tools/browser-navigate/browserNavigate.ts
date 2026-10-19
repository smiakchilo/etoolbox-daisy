import { z } from 'zod';
import {
  type ToolExecutor,
  type ConfiguredHostInfo,
  type JsonValue,
  type OpenPageOutcome,
  type RequestId,
  type Result,
  type ToolDescriptor,
  type ToolError,
  type ToolErrorCode,
  type ToolHost,
  createToolError,
  encodeAemPathname,
  err,
  newRequestId,
  ok,
  originsMatch,
  requestIdSchema,
  validateBrowserPath,
} from '../../shared';

/**
 * The `browser_navigate` tool, self-contained.
 *
 * Opens a page in the browser pane on a configured AEM host. The model supplies
 * a host *label* (or omits it for the host the pane is on), a repository or
 * browser path, and optionally a *display mode*; the application resolves the
 * label to a configured host, builds the browser path (with a mode, entirely -
 * every `.html` rule included) and joins it to that host's own origin, so no
 * scheme, port, origin or URL shape can reach the pane from a tool argument.
 *
 * Hand-rolled rather than built on `createToolExecutor`: it must work with no
 * active AEM server (an explicit host is enough), and it performs no AEM read.
 *
 * No `aem_` prefix: navigating a browser pane is not AEM-specific
 * (AGENTS.md section 5).
 */

export const BROWSER_NAVIGATE_TOOL_NAME = 'browser_navigate';
export const BROWSER_NAVIGATE_ALLOWLIST_ENTRY = 'custom:browser_navigate';

/**
 * The display modes a repository path can be opened in (owner decision,
 * 2026-10-14). With a `mode` the model passes a **raw repository path** (a
 * `jcr:path` copied from an `aem_query` result) and the *application* builds
 * the browser URL - so every `.html`-suffix rule is the application's and
 * cannot be dropped or doubled by the model (a reported live failure: a page
 * opened without its `.html`, and the Sites console form must carry none).
 *
 * The URL forms mirror the ones the transcript's linkifier already serves
 * (`linkTargets.ts`): the rendered page, `/editor.html` and the page's
 * `.html`, the consoles' `/sites.html`/`/assets.html` prefixes with **no**
 * `.html`, CRX/DE Lite's `#fragment` form, the DAM `assetdetails` editor, and
 * the page-properties console (`docs/compatibility.md` section 11.5).
 */
export const BROWSER_NAVIGATE_MODES = [
  'view',
  'edit',
  'sites',
  'admin',
  'assets',
  'crxde',
  'asset_details',
  'properties',
] as const;

export type BrowserNavigateMode = (typeof BROWSER_NAVIGATE_MODES)[number];

/** The one-line name each mode reads as in the transcript's Mode row. */
export const BROWSER_NAVIGATE_MODE_LABELS: Readonly<Record<BrowserNavigateMode, string>> = {
  view: 'View',
  edit: 'Edit',
  sites: 'Sites console',
  admin: 'Sites console',
  assets: 'Assets console',
  crxde: 'CRX/DE',
  asset_details: 'Asset details',
  properties: 'Page properties',
};

/**
 * Standard AEM places that need no page: the application owns their paths, so
 * a model never has to remember (or invent) /crx/packmgr/index.jsp.
 */
export const BROWSER_NAVIGATE_PLACES = [
  'crxde',
  'package_manager',
  'sites',
  'assets',
  'system_console',
  'config_manager',
  'bundles',
  'osgi_components',
  'sling_logs',
  'jmx',
] as const;

export type BrowserNavigatePlace = (typeof BROWSER_NAVIGATE_PLACES)[number];

export const BROWSER_NAVIGATE_PLACE_PATHS: Readonly<Record<BrowserNavigatePlace, string>> = {
  crxde: '/crx/de/',
  package_manager: '/crx/packmgr/index.jsp',
  sites: '/sites.html/content',
  assets: '/assets.html/content/dam',
  system_console: '/system/console',
  config_manager: '/system/console/configMgr',
  bundles: '/system/console/bundles',
  osgi_components: '/system/console/components',
  sling_logs: '/system/console/slinglog',
  jmx: '/system/console/jmx',
};

export const BROWSER_NAVIGATE_PLACE_LABELS: Readonly<Record<BrowserNavigatePlace, string>> = {
  crxde: 'CRX/DE',
  package_manager: 'Package Manager',
  sites: 'Sites console',
  assets: 'Assets console',
  system_console: 'System console',
  config_manager: 'Config Manager',
  bundles: 'OSGi bundles',
  osgi_components: 'OSGi components',
  sling_logs: 'Sling logs',
  jmx: 'JMX console',
};

/** The repository roots a display mode may open; anything else is a browser path or a place. */
const MODE_REPOSITORY_ROOTS: readonly string[] = [
  '/content',
  '/conf',
  '/etc',
  '/var',
  '/apps',
  '/libs',
  '/home',
];

/** The browser-URL prefixes a shaped path begins with - a mode never receives one. */
const MODE_BROWSER_PATH_PREFIXES: readonly string[] = [
  '/editor.html/',
  '/sites.html/',
  '/assets.html/',
  '/assetdetails.html/',
  '/crx/',
  '/mnt/overlay/',
];

const TRAILING_HTML_EXTENSION = /\.html$/i;
const LAST_SEGMENT_EXTENSION = /\.[A-Za-z0-9]+$/;

function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function withoutHtmlExtension(pathname: string): string {
  return pathname.replace(TRAILING_HTML_EXTENSION, '');
}

/** True for `/content/dam` and anything under it - the `/content` subtree that is not a page. */
function isDamPath(pathname: string): boolean {
  return pathname === '/content/dam' || pathname.startsWith('/content/dam/');
}

/**
 * The rendered form of a repository path: an extensionless path (a page)
 * gains `.html`; a path with its own extension (a DAM asset) is kept raw -
 * the same rule the transcript's linkifier applies to a content view.
 */
function renderedPath(pathname: string): string {
  const encoded = encodeAemPathname(pathname);
  return LAST_SEGMENT_EXTENSION.test(pathname) ? encoded : `${encoded}.html`;
}

/**
 * Builds the browser path a `mode` opens a raw repository path in. Every
 * form is application-owned: the model never appends or strips `.html`, never
 * adds a console prefix, and never percent-encodes - it passes the `jcr:path`
 * verbatim and this function shapes it.
 */
export function shapeModeBrowserPath(mode: BrowserNavigateMode, jcrPath: string): string {
  const path = withoutHtmlExtension(withoutTrailingSlash(jcrPath));
  switch (mode) {
    case 'view':
      return renderedPath(path);
    case 'edit':
      return `/editor.html${renderedPath(path)}`;
    case 'sites':
    case 'admin':
      // The Sites console carries its content path with NO `.html`
      // (e.g. `http://localhost:4502/sites.html/content/hpe/languages/jp-apj/home`).
      return `/sites.html${encodeAemPathname(path)}`;
    case 'assets':
      return `/assets.html${encodeAemPathname(path)}`;
    case 'crxde':
      return `/crx/de/index.jsp#${encodeAemPathname(path)}`;
    case 'asset_details':
      return `/assetdetails.html${encodeAemPathname(path)}`;
    case 'properties':
      return `/mnt/overlay/wcm/core/content/sites/properties.html?item=${encodeAemPathname(path)}`;
  }
}

/**
 * Completes a mode-less verbatim path: an extensionless **page** path under
 * `/content` (or the remainder of an `/editor.html/...` path) gains `.html`,
 * the suffix AEM's page rendering needs - the reported live failure was a
 * page opened without it.
 *
 * Deliberately narrow, mirroring the transcript's linkifier: a bare `/content`
 * root is left alone (it is a scope, not a page), `/content/dam/**` is left
 * alone (the DAM subtree is assets, not pages), any path with its own
 * extension is left alone, and a path carrying `?` or `#` is a URL form the
 * caller built deliberately - never completed around its own query.
 */
export function completeBrowserPath(rawPath: string): string {
  if (rawPath.includes('?') || rawPath.includes('#')) return rawPath;
  const path = withoutTrailingSlash(rawPath);
  const remainder = path.startsWith('/editor.html/') ? path.slice('/editor.html'.length) : path;
  if (!remainder.startsWith('/content/') || isDamPath(remainder)) return rawPath;
  return LAST_SEGMENT_EXTENSION.test(remainder) ? rawPath : `${path}.html`;
}

export const browserNavigateArgsObjectSchema = z
  .object({
    /**
     * A configured host's label (e.g. "HPE DEV"). Omit it to target the host
     * the browser pane is currently on.
     */
    host: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'A configured host\'s label, e.g. "HPE DEV" - a label from environment_facts, NOT a URL ' +
          '(the "Host origin" line of the page context is an origin, not a label; an origin or ' +
          'host:port is also tolerated). Omit it to use the host the browser pane is on.',
      )
      .optional(),
    /** A raw repository path (with `mode`) or a verbatim browser path (without one). */
    path: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        'A page or asset: the raw repository path (a jcr:path aem_query returned in this same ' +
          "turn) - normally together with 'mode'. Never a path you construct from a page's name " +
          "(a request for 'the home page' is not '/content/<site>/us/en'). Without 'mode' it is " +
          "a verbatim browser path beginning with '/' that the user wrote. Omit it when using " +
          "'place'.",
      )
      .optional(),
    /**
     * A standard AEM place that needs no page. The application owns its path.
     */
    place: z
      .enum(BROWSER_NAVIGATE_PLACES)
      .describe(
        'A standard AEM place to open instead of a page, ONLY when the user names the tool or ' +
          'console itself - a page name (media-library, components) is never a place. The ' +
          'application knows its path, so ' +
          'never type one: "crxde" (CRX/DE), "package_manager", "sites" (Sites console), ' +
          '"assets" (Assets console), "system_console" (OSGi/Felix console), "config_manager", ' +
          '"bundles", "osgi_components", "sling_logs", "jmx". Use it alone - no path, no mode.',
      )
      .optional(),
    /**
     * The display mode to open the repository path in. With a mode, `path` is
     * the raw repository path and the application builds the browser URL
     * (including every `.html` rule).
     */
    mode: z
      .enum(BROWSER_NAVIGATE_MODES)
      .describe(
        'How to display the page or asset in "path": "view" (the rendered page), "edit" (the ' +
          'page editor), "sites" or "admin" (the Sites console - "admin" means the same), ' +
          '"assets" (the Assets console), "crxde" (CRX/DE Lite, node selected), "asset_details" ' +
          '(the DAM asset editor), "properties" (the page properties console). Only with a ' +
          'repository path - never with "place". The application builds the URL and owns every ' +
          '.html rule.',
      )
      .optional(),
  })
  .strict();

export type BrowserNavigateArgs = z.infer<typeof browserNavigateArgsObjectSchema>;

const PATH_REJECTION_MESSAGES = {
  empty: 'the path must not be empty',
  not_absolute: "the path must begin with '/'",
  protocol_relative: "the path must not begin with '//'",
  too_long: 'the path is too long',
  unsafe_characters: 'the path must not contain whitespace or control characters',
} as const;

export const browserNavigateArgsSchema = browserNavigateArgsObjectSchema.superRefine(
  (value, ctx) => {
    const issue = (message: string, field: 'path' | 'place' | 'mode' = 'path'): void => {
      ctx.addIssue({ code: 'custom', message, path: [field] });
    };

    if (value.place !== undefined) {
      if (value.path !== undefined || value.mode !== undefined) {
        issue('a place stands alone - pass either place, or path (with an optional mode)', 'place');
      }
      return;
    }
    if (value.path === undefined) {
      issue('pass either a path (a page or asset) or a place (a standard AEM place)');
      return;
    }

    const check = validateBrowserPath(value.path);
    if (!check.ok) issue(PATH_REJECTION_MESSAGES[check.error]);
    if (value.mode === undefined) return;

    // With a mode, `path` is a raw repository path - under a repository root,
    // not an already-shaped browser path (a console or editor prefix), and
    // never a URL with its own query or fragment. Each is refused with the rule
    // stated, so the model's retry carries the right thing.
    if (
      MODE_BROWSER_PATH_PREFIXES.some((prefix) => value.path?.startsWith(prefix) === true) ||
      !MODE_REPOSITORY_ROOTS.some(
        (root) => value.path === root || value.path?.startsWith(`${root}/`) === true,
      )
    ) {
      issue(
        `mode ${value.mode} takes a repository path under ${MODE_REPOSITORY_ROOTS.join(', ')} - ` +
          'pass the jcr:path itself and let the application build the URL. To open a standard ' +
          'place (CRX/DE, package manager, a console, bundles ...) omit mode and path and pass ' +
          '"place" instead',
      );
    }
    if (value.path.includes('?') || value.path.includes('#')) {
      issue(`a raw repository path carries no query or fragment, and mode ${value.mode} takes one`);
    }
  },
);

export const BROWSER_NAVIGATE_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: BROWSER_NAVIGATE_TOOL_NAME,
  description:
    'Opens a page, asset or standard AEM place in the browser pane. For any "open / load / go ' +
    'to / navigate to" request, load the `navigate` skill first - it carries the search and ' +
    'qualifier rules. `host` is a configured host LABEL (from environment_facts), never a URL; ' +
    'omit it to use the host the pane is already on. Then give exactly one of: `place` - a ' +
    'standard place (CRX/DE, package manager, Sites/Assets console, system console, config ' +
    'manager, bundles, OSGi components, Sling logs, JMX), whose path the application knows; or ' +
    '`path` - the raw repository path (`jcr:path`) of a page or asset that `aem_query` returned ' +
    'in this same turn (a path is never constructed from a name), optionally with `mode`. With ' +
    '`mode` the application builds the browser URL and owns every `.html` rule: "view" and ' +
    '"edit" carry `.html`, "sites" (alias "admin") and "assets" consoles carry none, "crxde" ' +
    'selects the node in CRX/DE Lite, "asset_details" opens the DAM asset editor, "properties" ' +
    'the page-properties console. Never include a scheme, host or port.',
  // The base object, not the refined schema: `z.toJSONSchema` cannot describe a
  // `.superRefine` side-constraint, and the path rules are enforced by the
  // executor's validation, not by the model-facing JSON schema.
  parameters: z.toJSONSchema(browserNavigateArgsObjectSchema, { io: 'input' }),
};
export const browserNavigateRequestSchema = z
  .object({
    operation: z.literal('browser_navigate'),
    requestId: requestIdSchema,
    args: browserNavigateArgsObjectSchema,
  })
  .strict();

export type BrowserNavigateRequest = z.infer<typeof browserNavigateRequestSchema>;

export const browserNavigateSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('browser_navigate'),
    requestId: requestIdSchema,
    hostLabel: z.string().min(1),
    origin: z.string().min(1),
    /** The browser path actually opened - the mode-shaped or completed path, not the raw argument. */
    path: z.string().min(1),
    url: z.string().min(1),
    switched: z.boolean(),
    /** The display mode the call carried, when it carried one. */
    mode: z.enum(BROWSER_NAVIGATE_MODES).optional(),
    /** The standard place the call opened, when it named one. */
    place: z.enum(BROWSER_NAVIGATE_PLACES).optional(),
  })
  .strict();

export type BrowserNavigateSuccess = z.infer<typeof browserNavigateSuccessSchema>;

export function renderBrowserNavigateSuccess(result: BrowserNavigateSuccess): string {
  return (
    `Opened ${result.url} on host ${result.hostLabel}` +
    (result.switched ? ' (switched hosts)' : '') +
    '.'
  );
}

function toSuccessPayload(result: BrowserNavigateSuccess): JsonValue {
  // Built field-by-field rather than spread: with `exactOptionalPropertyTypes`
  // a spread of the optional `mode` would widen it to `| undefined`, which
  // `JsonValue` refuses - and a conditional spread inside the literal would
  // keep the field's optionality honest but still not survive the function's
  // return type through the parameter's own optional field.
  const payload: Record<string, JsonValue> = {
    ok: result.ok,
    operation: result.operation,
    requestId: result.requestId,
    hostLabel: result.hostLabel,
    origin: result.origin,
    path: result.path,
    url: result.url,
    switched: result.switched,
    textResultForLlm: renderBrowserNavigateSuccess(result),
    resultType: 'success',
  };
  if (result.mode !== undefined) payload['mode'] = result.mode;
  if (result.place !== undefined) payload['place'] = result.place;
  return payload;
}

const ERROR_MESSAGES = {
  invalid_arguments: 'Invalid browser_navigate arguments',
  no_hosts: 'No AEM host is configured. Add one in Settings, then try again',
  unknown_host: 'No configured host has that label',
  ambiguous_host: 'More than one configured host has that label',
  no_current_host:
    'The browser pane is not on a configured host, so no host could be inferred. Name one, or ' +
    'open a configured host first',
  server_not_found: 'That configured host no longer exists',
  no_view: 'The browser pane is not available, so nothing could be opened',
  invalid_path: 'The page path could not be used to build a URL for that host',
  cancelled: 'The navigation was replaced before it loaded',
  storage_error: 'The application could not read its settings',
  network_error: 'The page could not be loaded',
} as const;

type ErrorMessageKey = keyof typeof ERROR_MESSAGES;

const ERROR_MAPPINGS: Readonly<Record<ErrorMessageKey, ToolErrorCode>> = {
  invalid_arguments: 'INVALID_ARGUMENT',
  no_hosts: 'PRECONDITION_FAILED',
  unknown_host: 'INVALID_ARGUMENT',
  ambiguous_host: 'INVALID_ARGUMENT',
  no_current_host: 'PRECONDITION_FAILED',
  server_not_found: 'PRECONDITION_FAILED',
  no_view: 'PRECONDITION_FAILED',
  invalid_path: 'INVALID_ARGUMENT',
  cancelled: 'CANCELLED',
  storage_error: 'STORAGE_ERROR',
  network_error: 'NETWORK_ERROR',
};

/** Maps a Chromium `ERR_*` code to the narrowest justified tool error code. */
function networkErrorCode(errorCode: string): ToolErrorCode {
  if (/CERT/i.test(errorCode)) return 'TLS_ERROR';
  if (/PROXY/i.test(errorCode)) return 'PROXY_ERROR';
  return 'NETWORK_ERROR';
}

function toolError(
  key: ErrorMessageKey,
  requestId: RequestId,
  message = ERROR_MESSAGES[key],
): Result<JsonValue, ToolError> {
  return err(createToolError(ERROR_MAPPINGS[key], message, requestId));
}

function listLabels(hosts: readonly ConfiguredHostInfo[]): string {
  return hosts.length > 0 ? hosts.map((host) => host.label).join(', ') : '(none)';
}

/**
 * Matches a model-supplied `host` against the configured hosts, most specific
 * first: the label, then the whole origin, then `host:port`, then the bare
 * hostname. The first tier with any match wins, so a label is never shadowed by
 * a hostname. The model is *told* to pass a label, but the page context names
 * an origin and a live run copied it (2026-10-14) - tolerating the other forms
 * removes that whole failure class instead of relying on the model.
 */
function matchHosts(
  requested: string,
  hosts: readonly ConfiguredHostInfo[],
): readonly ConfiguredHostInfo[] {
  const wanted = requested.toLowerCase().replace(/\/+$/, '');
  const stripScheme = (origin: string): string => origin.toLowerCase().replace(/^https?:\/\//, '');
  const hostname = (origin: string): string => stripScheme(origin).replace(/:\d+$/, '');
  const tiers: ((host: ConfiguredHostInfo) => boolean)[] = [
    (host) => host.label.toLowerCase() === wanted,
    (host) => host.origin.toLowerCase() === wanted,
    (host) => stripScheme(host.origin) === wanted,
    (host) => hostname(host.origin) === wanted,
  ];
  for (const tier of tiers) {
    const found = hosts.filter(tier);
    if (found.length > 0) return found;
  }
  return [];
}
/** Resolves the model's `host` label (or the pane's current host) to a configured host. */
export function resolveNavigateHost(
  args: BrowserNavigateArgs,
  hosts: readonly ConfiguredHostInfo[],
  currentOrigin: string | undefined,
): Result<ConfiguredHostInfo, { key: ErrorMessageKey; message?: string }> {
  if (hosts.length === 0) return err({ key: 'no_hosts' });

  const requested = args.host?.trim();
  if (requested !== undefined && requested.length > 0) {
    const matches = matchHosts(requested, hosts);
    if (matches.length === 0) {
      return err({
        key: 'unknown_host',
        message: `No configured host is labelled "${requested}". Configured hosts: ${listLabels(hosts)}`,
      });
    }
    if (matches.length > 1) {
      return err({
        key: 'ambiguous_host',
        message:
          `More than one configured host matches "${requested}". ` +
          `Configured hosts: ${listLabels(hosts)}`,
      });
    }
    return ok(matches[0] as ConfiguredHostInfo);
  }

  if (currentOrigin === undefined) return err({ key: 'no_current_host' });
  const current = hosts.find((host) => originsMatch(host.origin, currentOrigin));
  if (current === undefined) return err({ key: 'no_current_host' });
  return ok(current);
}

function outcomeToResult(
  outcome: OpenPageOutcome,
  host: ConfiguredHostInfo,
  effectivePath: string,
  mode: BrowserNavigateMode | undefined,
  place: BrowserNavigatePlace | undefined,
  requestId: RequestId,
): Result<JsonValue, ToolError> {
  switch (outcome.kind) {
    case 'opened':
      return ok(
        toSuccessPayload({
          ok: true,
          operation: BROWSER_NAVIGATE_TOOL_NAME,
          requestId,
          hostLabel: host.label,
          origin: host.origin,
          path: effectivePath,
          url: outcome.url,
          switched: outcome.switched,
          ...(mode !== undefined ? { mode } : {}),
          ...(place !== undefined ? { place } : {}),
        }),
      );
    case 'network_error':
      return err(
        createToolError(
          networkErrorCode(outcome.errorCode),
          ERROR_MESSAGES.network_error,
          requestId,
        ),
      );
    case 'invalid_path':
      return toolError('invalid_path', requestId);
    case 'server_not_found':
      return toolError('server_not_found', requestId);
    case 'storage_error':
      return toolError('storage_error', requestId);
    case 'no_view':
      return toolError('no_view', requestId);
    case 'cancelled':
      return toolError('cancelled', requestId);
  }
}

export function createBrowserNavigateExecutor(host: ToolHost): ToolExecutor {
  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);

    const parsed = browserNavigateArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? ERROR_MESSAGES.invalid_arguments;
      return toolError('invalid_arguments', requestId, message);
    }
    if (context.signal?.aborted === true) {
      return err(createToolError('CANCELLED', ERROR_MESSAGES.cancelled, requestId));
    }

    const resolved = resolveNavigateHost(
      parsed.data,
      host.configuredHosts(),
      host.environmentFacts()?.origin,
    );
    if (!resolved.ok) {
      return toolError(resolved.error.key, requestId, resolved.error.message);
    }

    // The effective path is what the pane actually opens: a place's path is the
    // application's own; with a mode the application builds the browser path
    // from the raw repository path (every `.html` rule included); otherwise a
    // verbatim path is completed only by the narrow `completeBrowserPath` rule.
    const { mode, path, place } = parsed.data;
    const effectivePath =
      place !== undefined
        ? BROWSER_NAVIGATE_PLACE_PATHS[place]
        : mode !== undefined
          ? shapeModeBrowserPath(mode, path ?? '')
          : completeBrowserPath(path ?? '');

    const outcome = await host.openPage({
      serverId: resolved.value.serverId,
      path: effectivePath,
    });
    return outcomeToResult(outcome, resolved.value, effectivePath, mode, place, requestId);
  };
}
