import { z } from 'zod';
import { serverIdSchema } from './contracts/ids';
import { originSchema } from './contracts/origin';
import { tlsExceptionSchema, type TlsException } from './contracts/serverConfig';

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
 */
export const browserNavigationStateSchema = z
  .object({
    url: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    isLoading: z.boolean(),
  })
  .strict();

export type BrowserNavigationState = Readonly<z.infer<typeof browserNavigationStateSchema>>;

export function parseBrowserNavigationState(candidate: unknown): BrowserNavigationState {
  return browserNavigationStateSchema.parse(candidate);
}

/** Pushed on `browser:switch-state-changed`. Tools/navigation must stay disabled while `switching` is true (requirements-decisions.md section 4). */
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
  /** A server switch is already in progress; the request was rejected rather than interleaved. */
  'switch_in_progress',
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

/** `browser:revoke-certificate-exception`. */
export const revokeCertificateExceptionRequestSchema = z
  .object({
    serverId: serverIdSchema,
    origin: originSchema,
  })
  .strict();

export type RevokeCertificateExceptionRequest = Readonly<
  z.infer<typeof revokeCertificateExceptionRequestSchema>
>;
