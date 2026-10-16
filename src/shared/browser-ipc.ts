import { z } from 'zod';
import { serverIdSchema } from './contracts';
import { originSchema } from './contracts';
import { tlsExceptionSchema, type TlsException } from './contracts';

/**
 * Wire contracts for the browser-shell IPC surface (implementation-plan.md
 * step 05). Mirrors `settings-ipc.ts`'s placement and shape: request/response
 * DTOs for one IPC surface live directly under `src/shared`, separate from
 * the domain contracts in `src/shared/contracts`.
 *
 * This surface exists to satisfy exactly the `reportNotWired` call sites in
 * `src/renderer/src/shell/*` (grepped, not guessed): back/forward/reload/
 * navigate/set-view-bounds/switch-server, plus the certificate-exception and
 * settings-window affordances requirements-decisions.md sections 4 and 8
 * require. It carries no chat/agent-session channels - those belong to a
 * later step.
 */

// ---------------------------------------------------------------------------
// Reserved-region bounds (`browser:set-view-bounds`)
// ---------------------------------------------------------------------------

/**
 * Mirrors the renderer's own `ReservedRegionBounds`
 * (`src/renderer/src/shell/viewModel.ts`) structurally - that module cannot
 * be imported from `src/shared` (it is renderer-only, DOM-dependent code),
 * so this is an independent, intentionally identical shape validated at the
 * IPC boundary rather than shared by reference.
 */
export const viewBoundsSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  })
  .strict();

export type ViewBounds = Readonly<z.infer<typeof viewBoundsSchema>>;

// ---------------------------------------------------------------------------
// Navigation / switch push state (main -> renderer)
// ---------------------------------------------------------------------------

/**
 * Pushed on `browser:state-changed` whenever the AEM view's navigation state
 * changes. `url` is the live navigated URL - the renderer's own
 * `computeAddressBarValue` doc comment (`viewModel.ts`) explicitly describes
 * waiting for exactly this event before it can show anything but an empty
 * address bar.
 *
 * `hasDocument` is whether the view currently holds a *committed* document
 * (main-frame `did-navigate`/`did-navigate-in-page` observed), as opposed to a
 * pending or failed navigation. It is the one honest signal for "there is a
 * page to show" that a `url` cannot provide: a failed load leaves a non-empty
 * `url` behind, so the home screen must key on this, never on `url`. False
 * until the first commit, and monotonic-true within a session (a committed
 * document is never discarded by a later failed navigation).
 */
export const browserNavigationStateSchema = z
  .object({
    url: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    isLoading: z.boolean(),
    hasDocument: z.boolean(),
  })
  .strict();

export type BrowserNavigationState = Readonly<z.infer<typeof browserNavigationStateSchema>>;

export function parseBrowserNavigationState(candidate: unknown): BrowserNavigationState {
  return browserNavigationStateSchema.parse(candidate);
}

/** Pushed on `browser:switch-state-changed`. The toolbar keeps its loading presentation (and Stop) up while `switching` is true; a new navigation requested during the window supersedes the in-flight switch instead of being rejected (`serverSwitch.ts`). */
export const browserSwitchStateSchema = z.object({ switching: z.boolean() }).strict();

export type BrowserSwitchState = Readonly<z.infer<typeof browserSwitchStateSchema>>;

export function parseBrowserSwitchState(candidate: unknown): BrowserSwitchState {
  return browserSwitchStateSchema.parse(candidate);
}

/**
 * Pushed on `browser:certificate-blocked` whenever the observational
 * certificate-error tap (`src/main/browser/certificatePrompt.ts`) sees a
 * failure with no matching exception. Same shape as a persisted
 * `TlsException`: the UI needs exactly these three fields - origin,
 * fingerprint, error class - to let a human inspect and approve one specific
 * certificate, never more and never less.
 */
export const certificateBlockedInfoSchema = tlsExceptionSchema;
export type CertificateBlockedInfo = TlsException;

export function parseCertificateBlockedInfo(candidate: unknown): CertificateBlockedInfo {
  return certificateBlockedInfoSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Find-in-page (`browser:find` / `browser:stop-find` / `browser:find-result`)
// ---------------------------------------------------------------------------

/**
 * Which document a find request targets. Both are `WebContents` main owns: the
 * AEM pane's view, or the app shell's own document (which is where the chat
 * transcript lives). The renderer cannot address a `WebContents` directly, so
 * it names the logical target and main resolves it.
 */
export const FIND_TARGETS = ['browser', 'chat'] as const;
export const findTargetSchema = z.enum(FIND_TARGETS);
export type FindTarget = (typeof FIND_TARGETS)[number];

const FIND_TEXT_MAX_LENGTH = 1000;

/**
 * `browser:find` - one `findInPage` request. `forward` selects the direction of
 * a step (Enter advances, Shift+Enter goes back); a request whose text differs
 * from the target's current session restarts at the first match, which is how a
 * fresh query and a step share the one request shape. There is deliberately no
 * `findNext` flag: Electron 44 only emits `found-in-page` for a request carrying
 * `findNext: true`, so main always sends that (see `browserController.find`).
 */
export const findRequestSchema = z
  .object({
    target: findTargetSchema,
    text: z.string().min(1).max(FIND_TEXT_MAX_LENGTH),
    forward: z.boolean(),
  })
  .strict();

export type FindRequest = Readonly<z.infer<typeof findRequestSchema>>;

/** `browser:stop-find` - ends the target's session and clears its highlight. */
export const stopFindRequestSchema = z.object({ target: findTargetSchema }).strict();
export type StopFindRequest = Readonly<z.infer<typeof stopFindRequestSchema>>;

/**
 * Pushed on `browser:find-result` from the target's `found-in-page` event. The
 * `target` lets each pane's find bar ignore the other's results.
 */
export const findResultSchema = z
  .object({
    target: findTargetSchema,
    matches: z.number().int().nonnegative(),
    activeMatchOrdinal: z.number().int().nonnegative(),
  })
  .strict();

export type FindResult = Readonly<z.infer<typeof findResultSchema>>;

export function parseFindResult(candidate: unknown): FindResult {
  return findResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Errors / void result
// ---------------------------------------------------------------------------

export const BROWSER_IPC_ERROR_CODES = [
  /** The request payload failed schema validation. */
  'invalid_payload',
  /** The request did not come from the local app's own renderer. */
  'untrusted_sender',
  /** The typed address is not a valid http(s) origin. */
  'invalid_address',
  /**
   * The typed address is a valid origin, but does not match any configured
   * server. Requirements-decisions.md section 3: this must prompt the user
   * to add a server, and must never silently navigate or auto-create one.
   */
  'unknown_origin',
  /** There is no AEM `WebContentsView` to act on right now. */
  'no_active_view',
  /** No configured server has the given id. */
  'server_not_found',
  /**
   * The proxy switch or the subsequent page load rejected with a Chromium
   * network error (a down server, a mistyped address, a bad proxy, an
   * untrusted certificate, ...) - implementation-plan.md step 05's "network
   * errors are explicit". `errorCode` below carries the underlying
   * `ERR_*` code.
   */
  'network_error',
  /** Reading or writing the settings file failed. */
  'storage_error',
  /**
   * Handing a validated http(s) URL to the OS default browser failed (no
   * registered handler, or the OS rejected it). Only `browser:open-external`
   * produces this.
   */
  'open_external_failed',
] as const;

export type BrowserIpcErrorCode = (typeof BROWSER_IPC_ERROR_CODES)[number];

export const browserIpcErrorSchema = z
  .object({
    code: z.enum(BROWSER_IPC_ERROR_CODES),
    message: z.string().min(1).max(500),
    /** Present only for `"unknown_origin"` - the canonical origin the user typed, for an "add server" prompt to prefill. */
    origin: originSchema.optional(),
    /** Present only for `"network_error"` - the Chromium `ERR_*` code extracted from the underlying rejection, e.g. `ERR_CERT_AUTHORITY_INVALID`. */
    errorCode: z.string().min(1).max(100).optional(),
  })
  .strict();

export type BrowserIpcError = Readonly<z.infer<typeof browserIpcErrorSchema>>;

export const browserIpcVoidResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: browserIpcErrorSchema }).strict(),
]);

export type BrowserIpcVoidResult = Readonly<z.infer<typeof browserIpcVoidResultSchema>>;

export function parseBrowserIpcVoidResult(candidate: unknown): BrowserIpcVoidResult {
  return browserIpcVoidResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const ADDRESS_MAX_LENGTH = 2000;

/** `browser:navigate` - the raw address-bar text, not yet parsed as an origin. */
export const navigateRequestSchema = z
  .object({ value: z.string().min(1).max(ADDRESS_MAX_LENGTH) })
  .strict();

export type NavigateRequest = Readonly<z.infer<typeof navigateRequestSchema>>;

/** `browser:switch-server`. */
export const switchServerRequestSchema = z.object({ serverId: serverIdSchema }).strict();
export type SwitchServerRequest = Readonly<z.infer<typeof switchServerRequestSchema>>;

/**
 * `browser:open-external` - an absolute URL a transcript link asked to open in
 * the system browser. Carries the raw string; main re-validates it is http(s)
 * (no userinfo) with the same `parseNavigationTarget` the address bar uses
 * before it reaches `shell.openExternal`.
 */
export const openExternalRequestSchema = z
  .object({ url: z.string().min(1).max(ADDRESS_MAX_LENGTH) })
  .strict();
export type OpenExternalRequest = Readonly<z.infer<typeof openExternalRequestSchema>>;

/**
 * `browser:approve-certificate-exception`. Carries `serverId` (which
 * persisted server entry to attach the exception to, via
 * `applyServerTargetingChange`) alongside the exact `exception` a human
 * reviewed via `browser:certificate-blocked` - never re-derived, so what is
 * approved is exactly what was shown.
 */
export const approveCertificateExceptionRequestSchema = z
  .object({
    serverId: serverIdSchema,
    exception: tlsExceptionSchema,
  })
  .strict();

export type ApproveCertificateExceptionRequest = Readonly<
  z.infer<typeof approveCertificateExceptionRequestSchema>
>;
