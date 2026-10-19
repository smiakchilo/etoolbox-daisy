import { z } from 'zod';
import { type ProjectId, projectIdSchema, proxyIdSchema, serverIdSchema } from './ids';
import { originSchema } from './origin';

/**
 * A configured host entry (implementation-plan.md step 03,
 * requirements-decisions.md sections 3 and 4).
 *
 * Every field here is what the application needs to decide *where* and *how*
 * to reach one host. It deliberately excludes anything that would let
 * this double as a login-form URL or a credential store - those are the
 * mistakes requirements-decisions.md section 3 and 8 call out by name.
 */

const SERVER_LABEL_MAX_LENGTH = 100;

/**
 * Mirrors the non-empty/bounded/no-surrounding-whitespace shape used for
 * identifiers in `ids.ts`. A label is user-facing text, not an id, but the
 * same defect - accepting `" Prod "` and silently trimming it - would let a
 * saved label drift from what the user typed without them noticing.
 */
export const serverLabelSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(SERVER_LABEL_MAX_LENGTH, `must be at most ${String(SERVER_LABEL_MAX_LENGTH)} characters`)
  .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace');

/**
 * A closed set of named accents, aligned with Adobe Spectrum's semantic
 * colour tokens (the UI is built with Spectrum Web Components). Closed so the
 * UI can render a fixed swatch picker; `custom` below is the escape hatch for
 * the one user who wants a colour that is not on the list.
 */
export const SERVER_SWATCHES = [
  'red',
  'orange',
  'yellow',
  'green',
  'seafoam',
  'blue',
  'indigo',
  'purple',
  'fuchsia',
  'magenta',
] as const;

export type ServerSwatch = (typeof SERVER_SWATCHES)[number];

export const serverSwatchSchema = z.enum(SERVER_SWATCHES);

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * Accepts only `#` followed by exactly six hex digits, normalized to
 * lowercase. Three-digit shorthand and eight-digit (alpha) forms are rejected
 * rather than expanded/truncated: guessing what the user meant by a shorthand
 * risks picking a different colour than the one they saw in whatever picker
 * they copied it from.
 */
export const customHexColorSchema = z.string().transform((value, ctx) => {
  if (!HEX_COLOR_PATTERN.test(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be `#` followed by exactly 6 hex digits',
    });
    return z.NEVER;
  }
  return value.toLowerCase();
});

/**
 * Discriminated union rather than "swatch name or hex, whichever is set": a
 * `kind` tag makes "which one applies" a compile-time-checked question
 * instead of a runtime convention (e.g. "hex wins if both are present").
 */
export const serverColorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('swatch'), swatch: serverSwatchSchema }).strict(),
  z.object({ kind: z.literal('custom'), hex: customHexColorSchema }).strict(),
]);

export type ServerColor = z.infer<typeof serverColorSchema>;

/**
 * A username plus a *reference* to a secret held in OS-backed secure storage
 * (implementation-plan.md step 04) - never the secret itself. This schema has
 * no `password` field to strip: an object carrying one is rejected by the
 * enclosing `.strict()` schema instead of being silently dropped, so a bug
 * that tries to persist a plaintext password fails loudly.
 */
export const proxyCredentialsSchema = z
  .object({
    username: z.string().min(1).max(200),
    secretRef: z.string().min(1).max(200),
  })
  .strict();

export type ProxyCredentials = Readonly<z.infer<typeof proxyCredentialsSchema>>;

const HEX64_PATTERN = /^[0-9a-f]{64}$/i;
const COLON_HEX_PATTERN = /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i;

/**
 * A SHA-256 certificate fingerprint, accepted either as 64 bare hex digits or
 * as 32 colon-separated hex pairs (the two shapes a user is likely to copy
 * from a certificate viewer), normalized to the bare-hex form. One canonical
 * stored shape means two exceptions for the same certificate always compare
 * equal as strings, and it matches the format `crypto.createHash("sha256")`
 * produces, so main can compare a computed fingerprint without reformatting.
 */
export const sha256FingerprintSchema = z.string().transform((value, ctx) => {
  const trimmed = value.trim();
  if (HEX64_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (COLON_HEX_PATTERN.test(trimmed)) {
    return trimmed.replace(/:/g, '').toLowerCase();
  }
  ctx.addIssue({
    code: 'custom',
    message: 'must be a SHA-256 fingerprint: 64 hex digits, or 32 colon-separated hex-digit pairs',
  });
  return z.NEVER;
});

/**
 * A certificate exception bound to the exact origin it applies to, the
 * certificate's fingerprint, AND the class of validation failure that was
 * approved (e.g. `net::ERR_CERT_AUTHORITY_INVALID`). An origin-only
 * exception would silently keep trusting *whatever certificate that host
 * presents later* - including one substituted by an attacker - which
 * defeats the point of asking the user to approve one specific self-signed
 * certificate (requirements-decisions.md section 4).
 *
 * This lives on `ServerConfig` itself, as a sibling of `proxyId`, rather than
 * nested inside it: a self-signed certificate is a property of that host's
 * own origin and applies to a direct HTTPS connection just as much
 * as a proxied one, so it must stay expressible with no proxy configured at
 * all. Carrying its own `origin` (rather than implicitly reusing the
 * server's) is defence in depth against ever matching the wrong origin, but
 * it is not what clears an exception when the server's origin changes: while
 * the origin stays changed the mismatch alone would suppress it, but if the
 * origin is later reverted the old exception would match again and silently
 * restore a previously-abandoned trust decision. {@link bumpRevision}
 * therefore actively deletes `tlsException` on an origin change rather than
 * relying on this field to make it stop applying on its own.
 *
 * `errorClass` exists for the same "defence in depth against silently
 * resurrecting an abandoned trust decision" reason, but against a threat
 * origin+fingerprint alone cannot see: a certificate can be **revoked or
 * expired** without its origin or its bytes (and therefore its fingerprint)
 * ever changing. A user who approved a self-signed certificate approved
 * exactly *that* validation failure, at that moment - not "trust this
 * certificate under any future circumstance", which is what an
 * origin+fingerprint-only match would actually enforce. Pinning the error
 * class means a certificate that later expires or is revoked presents a
 * *different* error to Chromium (`net::ERR_CERT_DATE_INVALID`,
 * `net::ERR_CERT_REVOKED`, ...) and is correctly treated as a fresh decision
 * the user has not yet made, rather than being silently covered by an old
 * approval that was never actually about that failure.
 */
export const tlsExceptionSchema = z
  .object({
    origin: originSchema,
    certificateSha256Fingerprint: sha256FingerprintSchema,
    errorClass: z.string().min(1, 'must not be empty'),
  })
  .strict();

export type TlsException = Readonly<z.infer<typeof tlsExceptionSchema>>;

/**
 * The literal a host's `proxyId` carries to mean "explicitly no proxy" -
 * overriding any `browser.proxy` default. A host whose `proxyId` is *absent*
 * inherits the default proxy; a host whose `proxyId` is `"none"` connects
 * directly. `"none"` is a reserved value, never a proxy-library id (ids are
 * generated uuids), so it can never collide with a real entry.
 *
 * This is the one non-id value `proxyId` accepts; see
 * {@link hostProxyIdSchema}. The name is deliberately not `null`: with
 * `exactOptionalPropertyTypes` an optional property cannot be set to
 * `undefined`, and a JSON `null` would read as "absent" to a hand-editor, so a
 * distinct sentinel string is what makes the three states unambiguous in the
 * persisted document.
 */
export const HOST_PROXY_NONE = 'none' as const;

/**
 * A host's proxy selection as persisted: a proxy-library entry id, or the
 * {@link HOST_PROXY_NONE} sentinel for "No proxy". Absence of the whole
 * `proxyId` key means "(Default)" - inherit `browser.proxy`.
 */
export const hostProxyIdSchema = z.union([proxyIdSchema, z.literal(HOST_PROXY_NONE)]);

export type HostProxyId = z.infer<typeof hostProxyIdSchema>;

/** Non-negative: a fresh server entry starts at revision 0. */
export const serverRevisionSchema = z.number().int().nonnegative();

export const serverConfigSchema = z
  .object({
    id: serverIdSchema,
    label: serverLabelSchema,
    origin: originSchema,
    color: serverColorSchema,
    /**
     * Which entry of the settings `proxies` library this host reaches its origin
     * through, by id (the Settings "Hosts" multifield's Proxy combobox stores
     * this; the label is only ever a display concern). The three states are:
     *
     *  - **absent** - "(Default)": inherit `browser.proxy` (the default proxy);
     *  - {@link HOST_PROXY_NONE} - "No proxy": connect directly, overriding any
     *    `browser.proxy` default (useful for e.g. localhost);
     *  - a {@link proxyIdSchema} id - that library entry.
     *
     * A library entry owns its credentials; the host carries none of its own.
     * Referential integrity (a real id naming a configured proxy) is enforced
     * by `appSettingsSchema`, not here, because only the whole document can see
     * the library.
     */
    proxyId: hostProxyIdSchema.optional(),
    tlsException: tlsExceptionSchema.optional(),
    /**
     * Which entry of the settings `projects` library describes this host's
     * data layout (content/component roots), by id; the label is only ever a
     * display concern. Absent means "(Default)" - no project, so the agent is
     * told only the `/content`/`/apps` defaults. Referential integrity (a real
     * id naming a configured project) is enforced by `appSettingsSchema`, not
     * here, because only the whole document can see the library.
     *
     * Presentation, not targeting: it steers what the agent is told about the
     * host's layout, not how a request reaches the host, so changing it never bumps
     * `revision` (the per-turn context block re-reads it).
     */
    projectId: projectIdSchema.optional(),
    revision: serverRevisionSchema,
  })
  .strict();

export type ServerConfig = Readonly<z.infer<typeof serverConfigSchema>>;

/**
 * Fields a caller may change without affecting where or how requests reach
 * the server. implementation-plan.md line 254 requires renaming/recolouring
 * a server to work "without interrupting the conversation", so this type is
 * kept structurally separate from {@link ServerTargetingChanges} rather than
 * merged with an `if (isPresentationOnly(...))` check inside one function:
 * the type checker, not a runtime branch, is what stops a future caller from
 * passing a rename through the revision-bumping path by mistake - `label`/
 * `color`/`projectId` simply are not assignable to {@link ServerTargetingChanges}.
 *
 * The project reference is presentation rather than targeting: it steers what
 * the agent is told about the host's content and component layout, not how a
 * request reaches the host, and the per-turn context block re-reads it, so changing
 * it must not invalidate an in-flight bridge request.
 */
export interface ServerPresentationChanges {
  readonly label?: ServerConfig['label'];
  readonly color?: ServerConfig['color'];
  /**
   * Which entry of the settings `projects` library describes this host's data
   * layout, or `null` to reset it to "(Default)" (no project). Omitting the
   * key leaves it unchanged - the same three-state convention
   * {@link ServerTargetingChanges.proxyId} uses, for the same reason
   * (`exactOptionalPropertyTypes` cannot distinguish an absent key from one
   * set to `undefined`).
   */
  readonly projectId?: ProjectId | null;
}

/**
 * Updates the presentation-only fields (label/colour/project). `revision` is
 * left untouched on purpose: it exists solely so an in-flight request can
 * detect that its *targeting* information (origin/proxy/TLS trust) is stale,
 * and none of these changes that. The project reference is presentation too -
 * it steers what the agent is told about the host's content/component layout,
 * and the per-turn context block re-reads it, so changing it must not
 * invalidate an in-flight bridge request.
 */
export function updatePresentation(
  config: ServerConfig,
  changes: ServerPresentationChanges,
): ServerConfig {
  const next: Record<string, unknown> = { ...config };
  if ('projectId' in changes) {
    if (changes.projectId === null) {
      delete next['projectId'];
    } else {
      next['projectId'] = changes.projectId;
    }
  }
  if (changes.label !== undefined) next['label'] = changes.label;
  if (changes.color !== undefined) next['color'] = changes.color;
  return serverConfigSchema.parse(next);
}

/**
 * Changes that affect *where or how* requests reach the server. `id` cannot
 * be changed (a server's identity is permanent) and `revision` is never set
 * directly - {@link bumpRevision} owns incrementing it.
 *
 * `proxyId` and `tlsException` are `T | null`, not `Partial`'s usual "omit to
 * leave unchanged": with `exactOptionalPropertyTypes`, an optional property
 * cannot be explicitly set to `undefined`, so `undefined` is unavailable as a
 * "remove this" signal. Omitting the key means "leave as-is"; `null` means
 * "remove it"; a value means "replace it with this" - three states that a
 * plain `Partial<Pick<ServerConfig, "proxyId" | "tlsException">>` cannot tell
 * apart (it can only express "unchanged" or "replace").
 */
export interface ServerTargetingChanges {
  readonly origin?: ServerConfig['origin'];
  /**
   * Which proxy-library entry to use, `HOST_PROXY_NONE` for "No proxy", or
   * `null` to reset to "(Default)" (inherit `browser.proxy`); omitting leaves
   * it unchanged.
   */
  readonly proxyId?: ServerConfig['proxyId'] | null;
  readonly tlsException?: TlsException | null;
}

/**
 * Applies a targeting change and increments `revision`. An in-flight tool
 * call reads `serverRevision` once at request time; bumping it here is what
 * lets that captured value be recognised as out of date when the result comes
 * back (requirements-decisions.md section 7).
 *
 * The in-flight check is `classifyStaleness` in `toolContracts.ts`, not
 * {@link isStaleRevision} below - see that function's note for why the two
 * use different comparisons on purpose.
 *
 * An actual origin change also clears any existing `tlsException` unless this
 * same call supplies a replacement. An exception is only meaningful evidence
 * about the specific origin it was recorded for; leaving a stale one in place
 * after the origin moves away and is later moved *back* would silently
 * resurrect a previously-abandoned TLS trust decision with no new user
 * confirmation - exactly what requirements-decisions.md section 4 ("a changed
 * certificate requires a new user decision") and implementation-plan.md lines
 * 450-451 ("resets the old TLS-exception mapping") forbid. Relying only on
 * the exception's own `origin` field to stop it from matching is not enough:
 * that only protects while the origin stays changed, not across a later
 * revert.
 */
export function bumpRevision(
  config: ServerConfig,
  changes: ServerTargetingChanges = {},
): ServerConfig {
  const nextOrigin = changes.origin ?? config.origin;
  const originChanged = nextOrigin !== config.origin;

  // The proxy *reference* is independent of the origin: a host that moves
  // address keeps using the same library entry, and only an explicit
  // `proxyId: null` resets it to "(Default)".
  const nextProxyId =
    'proxyId' in changes
      ? changes.proxyId === null
        ? undefined
        : changes.proxyId
      : config.proxyId;

  const nextTlsException =
    'tlsException' in changes
      ? changes.tlsException === null
        ? undefined
        : changes.tlsException
      : originChanged
        ? undefined
        : config.tlsException;

  const next: Record<string, unknown> = {
    id: config.id,
    label: config.label,
    origin: nextOrigin,
    color: config.color,
    revision: config.revision + 1,
  };
  if (nextProxyId !== undefined) {
    next.proxyId = nextProxyId;
  }
  if (nextTlsException !== undefined) {
    next.tlsException = nextTlsException;
  }
  return serverConfigSchema.parse(next);
}

/**
 * True when `observedRevision` was captured before `currentRevision` was
 * reached, i.e. the caller is holding stale targeting information. Equal
 * revisions are not stale; a caller can never observe a revision greater than
 * the current one, but this is not treated as an error here - it is simply
 * not staleness.
 *
 * This directional check is for advisory questions such as "does this
 * persisted chat need to re-observe the server before it is used again?"
 * (`isChatServerRevisionStale`). It is deliberately *not* the check used to
 * decide whether an in-flight tool call's result may still be handed to the
 * model: that is `classifyStaleness` in `toolContracts.ts`, which compares
 * with a symmetric `!==` precisely so that a revision moving *backwards* -
 * the anomaly this function's "can never observe" assumption would treat as
 * fresh - is caught rather than trusted. Do not converge the two without
 * reading both rationales.
 */
export function isStaleRevision(observedRevision: number, currentRevision: number): boolean {
  return observedRevision < currentRevision;
}
