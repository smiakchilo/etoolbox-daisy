/**
 * Barrel for the network layer for the browser pane (implementation-plan.md step 05). Only
 * re-exports - no logic lives here - so `windows.ts`/`index.ts` (owned by
 * other agents) can import one path instead of four.
 */
export * from './certificateExceptions';
export * from './proxyPolicy';
export * from './proxyAuth';
export * from './proxyResolution';
export * from './responseHeaderFilter';
export * from './session';
export * from './sessionCookiePersistence';
