import { z } from 'zod';

/**
 * Wire protocol for the private bridge (implementation-plan.md step 06).
 *
 * The direction of travel is the security-critical part: the **main process
 * initiates** every request, and the preload only ever answers one it was
 * asked for. The page itself has no way to start, observe, or influence a
 * bridge call - nothing is exposed to its main world - so this protocol is
 * strictly main -> preload -> main.
 *
 * Both payload shapes are validated with zod on the receiving side. That is
 * not ceremony: the reply arrives from a renderer that hosts remote
 * content, and although the page cannot reach `ipcRenderer`, treating
 * anything crossing that boundary as untyped input is the only assumption
 * that stays true if some future change makes it reachable.
 */

/** main -> preload: perform exactly one same-origin fetch (GET or HEAD). */
export const WEBVIEW_BRIDGE_FETCH_CHANNEL = 'webview-bridge:fetch' as const;
/** main -> preload: abandon an in-flight fetch. */
export const WEBVIEW_BRIDGE_CANCEL_CHANNEL = 'webview-bridge:cancel' as const;
/** preload -> main: the outcome of a fetch the main process asked for. */
export const WEBVIEW_BRIDGE_REPLY_CHANNEL = 'webview-bridge:reply' as const;
/**
 * preload -> main: the preload has registered its bridge listeners and is able
 * to answer a fetch.
 *
 * Main uses this to tell "the browser view exists but its preload never loaded"
 * apart from "the view exists and is simply slow". Without it the first case
 * is indistinguishable from a request timeout: the fetch command is delivered to
 * a `WebContents` that has no listener, so nothing ever replies and the broker
 * waits out the whole deadline. The preload file being absent or failing to
 * evaluate (a build/packaging fault) is not a host fault, and must not be
 * reported as one.
 *
 * Carries no payload: its arrival, from the trusted view's main frame, is the
 * entire signal. Re-sent on every document load, because a navigation replaces
 * the preload context that registered the listeners.
 */
export const WEBVIEW_BRIDGE_READY_CHANNEL = 'webview-bridge:ready' as const;
/** main -> preload: read matching elements from the document the pane is showing. */
export const WEBVIEW_BRIDGE_READ_CHANNEL = 'webview-bridge:read' as const;
/**
 * main -> preload: scroll to a CSS selector and highlight it. This is a user
 * interaction (a report's selector link), not an agent tool read, so it is a
 * fire-and-ack command on its own channel rather than a `webviewBridgeRead` -
 * the preload answers on {@link WEBVIEW_BRIDGE_HIGHLIGHT_REPLY_CHANNEL}.
 */
export const WEBVIEW_BRIDGE_HIGHLIGHT_CHANNEL = 'webview-bridge:highlight' as const;
/** preload -> main: whether the selector matched an element on the shown page. */
export const WEBVIEW_BRIDGE_HIGHLIGHT_REPLY_CHANNEL = 'webview-bridge:highlight-reply' as const;

/** main -> preload: one highlight command. The selector is handed to `querySelector` only. */
export const webviewBridgeHighlightCommandSchema = z.object({
  requestId: z.string().min(1),
  selector: z.string().min(1).max(500),
});
export type WebviewBridgeHighlightCommand = z.infer<typeof webviewBridgeHighlightCommandSchema>;

/** preload -> main: the highlight's outcome, correlated by id. */
export const webviewBridgeHighlightReplySchema = z
  .object({ requestId: z.string().min(1), found: z.boolean() })
  .strict();
export type WebviewBridgeHighlightReply = z.infer<typeof webviewBridgeHighlightReplySchema>;

/** Per-item and total character budgets the preload applies to a DOM read. */
export const DOM_READ_TEXT_LIMIT = 2000;
export const DOM_READ_HTML_LIMIT = 20000;
export const DOM_READ_TOTAL_LIMIT = 100000;
export const DOM_READ_MAX_ITEMS = 200;
export const DOM_READ_MAX_ATTRIBUTES = 10;
/** How long the preload may spend collecting one read before it reports a truncation. */
export const DOM_READ_TIME_BUDGET_MS = 1000;
/** What a withheld attribute value reads as, so a reader knows something was there. */
export const DOM_READ_REDACTED_VALUE = '[withheld]';

const attributeNameSchema = z.string().regex(/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/);

/**
 * main -> preload: read the elements a CSS selector matches. Read only: the
 * preload uses `textContent`, `outerHTML` and `getAttribute`, never evaluates
 * anything from the page, and never reaches outside the shown document (an
 * optional same-origin iframe is the only other document it will enter).
 */
export const webviewBridgeReadCommandSchema = z.object({
  requestId: z.string().min(1),
  selector: z.string().min(1).max(500),
  /** What each item carries besides its tag and attributes. Absent means `text`. */
  include: z.enum(['text', 'html']).optional(),
  attributes: z.array(attributeNameSchema).max(DOM_READ_MAX_ATTRIBUTES).optional(),
  limit: z.number().int().min(1).max(DOM_READ_MAX_ITEMS),
  /** A selector of a same-origin `iframe` in the document whose own document is read instead. */
  frame: z.string().min(1).max(500).optional(),
});
export type WebviewBridgeReadCommand = z.infer<typeof webviewBridgeReadCommandSchema>;
/** What a tool asks the broker to read; the broker adds the request id. */
export type DomReadSpec = Omit<WebviewBridgeReadCommand, 'requestId'>;

export const webviewBridgeDomItemSchema = z.object({
  tag: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
});
export type WebviewBridgeDomItem = z.infer<typeof webviewBridgeDomItemSchema>;

export const webviewBridgeDomResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    url: z.string(),
    title: z.string(),
    /** How many elements the selector matched in total. */
    matched: z.number().int().min(0),
    items: z.array(webviewBridgeDomItemSchema),
    /** True when `limit`, a per-item cap or the total budget cut something off. */
    truncated: z.boolean(),
    /**
     * True when at least one value was withheld because it looked like a
     * credential (a token/CSRF/password/auth/nonce attribute, a hidden or
     * password input's `value`, or inline script/style markup).
     */
    redacted: z.boolean().optional(),
  }),
  z.object({ status: z.literal('invalid_selector') }),
  z.object({ status: z.literal('frame_unavailable') }),
]);
export type WebviewBridgeDomResult = z.infer<typeof webviewBridgeDomResultSchema>;

export const webviewBridgeFetchCommandSchema = z.object({
  /**
   * Correlates the reply. The main process generates it; the preload only
   * echoes it back, and main refuses any reply whose id is not currently
   * pending (see the broker's sender validation).
   */
  requestId: z.string().min(1),
  /**
   * The absolute URL built by `buildResourceUrl`. The preload re-checks that
   * it is same-origin with the document before fetching it rather than
   * trusting main, so that a bug on the main side cannot turn the bridge into
   * a general-purpose cross-origin fetcher running with the browser session's
   * cookies.
   */
  url: z.string().min(1),
  /** Absent means `GET`. Only the two non-mutating methods exist; see `http_fetch`. */
  method: z.enum(['GET', 'HEAD']).optional(),
  /** Absent means {@link WEBVIEW_BRIDGE_REQUEST_HEADERS}'s JSON `Accept`. */
  accept: z.string().min(1).max(200).optional(),
});
export type WebviewBridgeFetchCommand = z.infer<typeof webviewBridgeFetchCommandSchema>;

/**
 * The only request headers the bridge ever sets, defined once here so the
 * preload (which issues the fetch) and main (which logs the tool HTTP
 * request) describe the same request rather than two drifting copies.
 *
 * `Accept: application/json` is safe on a same-origin request: it triggers no
 * CORS preflight and gives a well-behaved SSO gateway the chance to answer 401
 * instead of an HTML login page. Nothing else is set: the browser session cookie
 * is attached ambiently by Chromium (`credentials: "same-origin"`) and is a
 * forbidden request-header name, so this code cannot set or read it.
 */
export const WEBVIEW_BRIDGE_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/json',
};

/**
 * One HTTP header, as it crosses the bridge for diagnostics. The preload
 * reports the response's *readable* headers only; `Set-Cookie` and `Cookie`
 * are browser-forbidden names and are therefore never present here (see
 * `bridgeFetch.ts`). This is a diagnostic shape, not something the agent or
 * the tool result ever consumes.
 */
export const webviewBridgeHeaderSchema = z
  .object({
    name: z.string().min(1),
    value: z.string(),
  })
  .strict();
export type WebviewBridgeHeader = z.infer<typeof webviewBridgeHeaderSchema>;

export const webviewBridgeCancelCommandSchema = z.object({
  requestId: z.string().min(1),
});
export type WebviewBridgeCancelCommand = z.infer<typeof webviewBridgeCancelCommandSchema>;

/**
 * Why a fetch was refused or abandoned without ever producing a response.
 *
 * `redirect_blocked` is deliberately distinct from `network_error`: a redirect
 * is the normal shape of "your browser session expired and the IdP wants you to
 * sign in again", and the user-facing story for it is completely different
 * from a connection failure. It carries no target URL, because the fetch is
 * issued with `redirect: "manual"` and the redirect target is therefore
 * genuinely unreadable - which is the desired outcome twice over: the bridge
 * does not follow it, and the IdP URL never reaches the agent's context.
 */
export const webviewBridgeBlockReasonSchema = z.enum([
  'invalid_url',
  'cross_origin',
  'redirect_blocked',
]);
export type WebviewBridgeBlockReason = z.infer<typeof webviewBridgeBlockReasonSchema>;

export const webviewBridgeReplySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('response'),
    requestId: z.string().min(1),
    status: z.number().int().min(100).max(599),
    /** `null` when the response carried no `Content-Type` at all - which is itself meaningful. */
    contentType: z.string().nullable(),
    /**
     * The body as text, never pre-parsed. Parsing happens in main
     * (`classifyAemResponse`) so that exactly one component decides what
     * counts as a usable resource. No byte cap is applied anywhere on this
     * path; the user explicitly rejected one.
     */
    bodyText: z.string(),
    /**
     * The response's readable headers, for the tool HTTP log only. Optional so
     * a reply built before this field existed still validates; the preload
     * always supplies it going forward. Never interpreted - the bridge's
     * classification still reads `contentType` alone.
     */
    headers: z.array(webviewBridgeHeaderSchema).optional(),
  }),
  z.object({
    kind: z.literal('blocked'),
    requestId: z.string().min(1),
    reason: webviewBridgeBlockReasonSchema,
  }),
  z.object({
    kind: z.literal('network_error'),
    requestId: z.string().min(1),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('cancelled'),
    requestId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('dom'),
    requestId: z.string().min(1),
    result: webviewBridgeDomResultSchema,
  }),
]);
export type WebviewBridgeReply = z.infer<typeof webviewBridgeReplySchema>;
