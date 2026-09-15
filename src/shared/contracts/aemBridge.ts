import { z } from 'zod';

/**
 * Wire protocol for the private AEM bridge (implementation-plan.md step 06).
 *
 * The direction of travel is the security-critical part: the **main process
 * initiates** every request, and the preload only ever answers one it was
 * asked for. The page itself has no way to start, observe, or influence a
 * bridge call - nothing is exposed to its main world - so this protocol is
 * strictly main -> preload -> main.
 *
 * Both payload shapes are validated with zod on the receiving side. That is
 * not ceremony: the reply arrives from a renderer that hosts remote AEM
 * content, and although the page cannot reach `ipcRenderer`, treating
 * anything crossing that boundary as untyped input is the only assumption
 * that stays true if some future change makes it reachable.
 */

/** main -> preload: perform exactly one same-origin JSON fetch. */
export const AEM_BRIDGE_FETCH_CHANNEL = 'aem-bridge:fetch' as const;
/** main -> preload: abandon an in-flight fetch. */
export const AEM_BRIDGE_CANCEL_CHANNEL = 'aem-bridge:cancel' as const;
/** preload -> main: the outcome of a fetch the main process asked for. */
export const AEM_BRIDGE_REPLY_CHANNEL = 'aem-bridge:reply' as const;

export const aemBridgeFetchCommandSchema = z.object({
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
   * a general-purpose cross-origin fetcher running with the AEM session's
   * cookies.
   */
  url: z.string().min(1),
});
export type AemBridgeFetchCommand = z.infer<typeof aemBridgeFetchCommandSchema>;

export const aemBridgeCancelCommandSchema = z.object({
  requestId: z.string().min(1),
});
export type AemBridgeCancelCommand = z.infer<typeof aemBridgeCancelCommandSchema>;

/**
 * Why a fetch was refused or abandoned without ever producing a response.
 *
 * `redirect_blocked` is deliberately distinct from `network_error`: a redirect
 * is the normal shape of "your AEM session expired and the IdP wants you to
 * sign in again", and the user-facing story for it is completely different
 * from a connection failure. It carries no target URL, because the fetch is
 * issued with `redirect: "manual"` and the redirect target is therefore
 * genuinely unreadable - which is the desired outcome twice over: the bridge
 * does not follow it, and the IdP URL never reaches the agent's context.
 */
export const aemBridgeBlockReasonSchema = z.enum([
  'invalid_url',
  'cross_origin',
  'redirect_blocked',
]);
export type AemBridgeBlockReason = z.infer<typeof aemBridgeBlockReasonSchema>;

export const aemBridgeReplySchema = z.discriminatedUnion('kind', [
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
  }),
  z.object({
    kind: z.literal('blocked'),
    requestId: z.string().min(1),
    reason: aemBridgeBlockReasonSchema,
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
]);
export type AemBridgeReply = z.infer<typeof aemBridgeReplySchema>;
