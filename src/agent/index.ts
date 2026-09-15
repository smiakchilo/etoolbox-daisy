/**
 * Public surface of the Copilot SDK adapter. `src/agent` is the only place
 * allowed to import `@github/copilot-sdk` / `@github/copilot` (enforced by
 * the `no-restricted-imports` ESLint rule in `eslint.config.mjs`); everything
 * outside this directory - including `src/main` - must go through these
 * exports instead of reaching into the SDK directly.
 */
export { getCopilotHomeDir, getAppDataRoot } from './copilotHome';
export {
  resolveSdkRuntimeExePath,
  resolveCliExePath,
  resolvePlatformPackageDir,
  resolveBundledSkillsDir,
  type RuntimePathsEnv,
} from './runtimePaths';
export {
  createHardenedCopilotClient,
  resolveDefaultRuntimePathsEnv,
  buildRuntimeChildEnv,
  getAuthStatus,
  getRuntimeStatus,
  type CopilotClient,
  type CreateHardenedClientOptions,
  type ProxyEnvOverrides,
} from './copilotClient';
export {
  createHardenedSession,
  resumeHardenedSession,
  denyAllPermissions,
  allowlistedToolPermissions,
  type HardenedToolPolicy,
  SKILL_INVOCATION_TOOL,
} from './toolPolicy';
export {
  buildLoginChildEnv,
  startWebFlowLogin,
  assertNoPlaintextCredentials,
  localSignOut,
  type LoginEnvOptions,
  type LoginOutcome,
  type LoginProcessHandle,
  type SpawnFn,
} from './auth';
export {
  loadModelCatalog,
  projectModelCatalog,
  type ModelCatalogError,
  type ModelCatalogErrorKind,
  type ModelCatalogSource,
} from './modelCatalog';
