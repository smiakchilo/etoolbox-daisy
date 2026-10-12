/**
 * Barrel for the shared contract layer (implementation-plan.md step 03).
 *
 * These modules are the single source of truth for every DTO, tool argument,
 * tool result, agent event, and session-state transition that crosses a
 * process boundary. They are deliberately dependency-free apart from zod and
 * each other: `eslint.config.mjs` forbids Node and browser globals under
 * `src/shared/**` so the same code can run in main, preload and renderer
 * without a second, drifting copy.
 *
 * Ordered foundation-first. `ids`, `errors` and `origin` define the branded
 * primitives the rest build on.
 */
export * from './ids';
export * from './errors';
export * from './origin';
export * from './userInput';
export * from './agents';
export * from './serverConfig';
export * from './projectConfig';
export * from './appSettings';
export * from './modelCatalog';
export * from './settingsSnapshot';
export * from './chatMetadata';
export * from './chatJournal';
export * from './agentEvents';
export * from './sessionState';
