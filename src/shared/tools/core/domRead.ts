/**
 * What a tool may know of the browser pane's DOM read: the limits it can ask
 * for and the shape the application answers with. The bridge protocol itself
 * stays in `contracts/webviewBridge.ts`; this is the tool-kit's window onto it.
 */
export {
  DOM_READ_MAX_ATTRIBUTES,
  DOM_READ_MAX_ITEMS,
  webviewBridgeDomResultSchema as domReadResultSchema,
  type DomReadSpec,
  type WebviewBridgeDomItem as DomReadItem,
  type WebviewBridgeDomResult as DomReadResult,
} from '../../contracts/webviewBridge';
