import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import type {
  CopilotClientOptions,
  GetAuthStatusResponse,
  GetStatusResponse,
} from '@github/copilot-sdk';
import { getCopilotHomeDir } from './copilotHome';
import { resolveSdkRuntimeExePath, type RuntimePathsEnv } from './runtimePaths';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds `RuntimePathsEnv` from the live Electron process. Kept separate from
 * `runtimePaths.ts` so that module stays Electron-free and unit-testable with
 * a plain object; this is the one place that touches real `app`/`process`
 * state for it.
 */
export function resolveDefaultRuntimePathsEnv(): RuntimePathsEnv {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // This module is bundled by electron-vite into a single out/main/index.js
    // in both dev and packaged builds, so "two levels up from the bundle" is
    // always the project root in dev. In packaged builds this value is
    // unused (the packaged branch resolves from resourcesPath instead).
    devRootDir: path.resolve(currentDir, '..', '..'),
  };
}

/**
 * Proxy/TLS overrides for the runtime child process, applied by
 * `buildRuntimeChildEnv()`. Verified end-to-end (unauthenticated/
 * authenticated proxy, wrong-password 407, unreachable proxy, trusted and
 * untrusted corporate CA) in `tests/integration/proxy-runtime.test.ts`.
 */
export interface ProxyEnvOverrides {
  readonly httpsProxy?: string;
  readonly httpProxy?: string;
  readonly noProxy?: string;
  readonly nodeExtraCaCerts?: string;
}

/**
 * Ambient credential variables the runtime resolves *before* the app-owned
 * `COPILOT_HOME`/vault entry, in this precedence order. They are always
 * stripped from the child environment.
 *
 * Inheriting them would be a hidden credential fallback from the user's
 * ordinary shell/CLI setup, which docs/implementation-plan.md step 02
 * explicitly forbids ("Do not read its workspace, instructions, MCP
 * configuration, or credentials as a hidden fallback"). It was observed for
 * real in an installed build before this strip existed: the app reported
 * `authType: "env"` / `"(via GH_TOKEN)"` and was authenticated as an account
 * it had never signed into, which would also have made logout meaningless
 * (signing out cannot revoke an environment variable).
 *
 * A token may still be used - but only when the user supplies one explicitly
 * via `CreateHardenedClientOptions.githubToken` (the Settings token field),
 * never by silent inheritance.
 */
const AMBIENT_CREDENTIAL_ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * The single seam that builds the runtime child process's environment.
 *
 * `base` (`process.env` by default) is always spread first: the SDK
 * *replaces*, not merges, `process.env` once `CopilotClientOptions.env` is
 * set (verified in `dist/cjs/client.js`: `effectiveEnv = connEnv ?? options.env
 * ?? process.env`), so a child given only `{ COPILOT_HOME }` would be missing
 * `PATH`/`SystemRoot`/etc. Ambient credentials are then stripped, and proxy
 * overrides applied on top, only for keys actually supplied.
 */
export function buildRuntimeChildEnv(
  base: NodeJS.ProcessEnv,
  proxy: ProxyEnvOverrides = {},
  githubToken?: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const varName of AMBIENT_CREDENTIAL_ENV_VARS) {
    delete env[varName];
  }
  if (githubToken !== undefined && githubToken !== '') {
    env['COPILOT_GITHUB_TOKEN'] = githubToken;
  }
  if (proxy.httpsProxy !== undefined) env['HTTPS_PROXY'] = proxy.httpsProxy;
  if (proxy.httpProxy !== undefined) env['HTTP_PROXY'] = proxy.httpProxy;
  if (proxy.noProxy !== undefined) env['NO_PROXY'] = proxy.noProxy;
  if (proxy.nodeExtraCaCerts !== undefined) env['NODE_EXTRA_CA_CERTS'] = proxy.nodeExtraCaCerts;
  return env;
}

export interface CreateHardenedClientOptions {
  /** Overrides the app-owned COPILOT_HOME dir; tests use a scratch directory. */
  readonly copilotHomeDir?: string;
  /** Overrides the resolved runtime exe path; tests use a stub. */
  readonly runtimeExePath?: string;
  readonly proxy?: ProxyEnvOverrides;
  readonly logLevel?: CopilotClientOptions['logLevel'];
  readonly baseEnv?: NodeJS.ProcessEnv;
  /**
   * An explicitly user-supplied GitHub token (Settings field). Ambient
   * `GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN` are always stripped;
   * only a token passed here is honoured.
   */
  readonly githubToken?: string;
}

/**
 * Constructs (but does not start) a `CopilotClient` hardened per the
 * pre-verified facts this step is built on:
 *
 * - `RuntimeConnection.forStdio({ path })` with an **explicit absolute path**
 *   to `copilot-runtime.exe`, so the SDK's `resolvedCliPath ??=
 *   getBundledRuntimePath()` short-circuit never runs `ensureRuntimeBundle()`
 *   (no ASAR `require.resolve`, no cache materialization).
 * - `env` set only at the client level via the single seam above - never on
 *   the connection object, which throws if both are set.
 * - `baseDirectory` set to the app-owned `COPILOT_HOME`.
 * - No `mode: "empty"` (see `toolPolicy.ts` for the full reasoning).
 */
export function createHardenedCopilotClient(
  options: CreateHardenedClientOptions = {},
): CopilotClient {
  const runtimeExePath =
    options.runtimeExePath ?? resolveSdkRuntimeExePath(resolveDefaultRuntimePathsEnv());
  const copilotHomeDir = options.copilotHomeDir ?? getCopilotHomeDir();
  const env = buildRuntimeChildEnv(
    options.baseEnv ?? process.env,
    options.proxy,
    options.githubToken,
  );

  return new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: runtimeExePath }),
    baseDirectory: copilotHomeDir,
    env,
    logLevel: options.logLevel ?? 'warning',
  });
}

export async function getAuthStatus(client: CopilotClient): Promise<GetAuthStatusResponse> {
  return client.getAuthStatus();
}

export async function getRuntimeStatus(client: CopilotClient): Promise<GetStatusResponse> {
  return client.getStatus();
}

export type { CopilotClient };
