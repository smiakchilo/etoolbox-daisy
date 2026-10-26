import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentFetch } from '../../../shared';
import { CLI_CACHE_DIRECTORY } from './cache';
import { discoverLocalClis, type DiscoveryFileSystem } from './discovery';
import { createCliProbe, type CliProbe } from './probe';
import { createCopilotCliResolver, type CopilotCliResolver } from './resolver';

/**
 * The Copilot CLI this agent signs in with.
 *
 * Copilot-only by construction: the binary comes from GitHub's Copilot CLI
 * release channel, it is spoken to with `copilot login --web-flow`, and the
 * floor is the oldest CLI this agent was verified against. Nothing about it
 * belongs to the application, so nothing about it lives outside this folder -
 * the agent supplies its own state directory and the host's proxy fetch, and
 * the rest (discovery, download, verification, cache) is here.
 */

/** The real filesystem answers discovery needs, in one place. */
const nodeFileSystem: DiscoveryFileSystem = {
  isFile: (candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
  isDirectory: (candidate) => {
    try {
      return statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  },
  realpath: (candidate) => realpathSync(candidate),
};

export interface CopilotCliOptions {
  /** `AgentHost.stateDirectory` - holds the CLI cache at `<state>/cli/<version>/`. */
  readonly stateDirectory: string;
  /** `AgentHost.createProxyFetch(connection)`; the resolver never makes a direct call. */
  readonly fetch: AgentFetch;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Injected for tests; defaults to this process's. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly probe?: CliProbe;
}

/** `<state>/cli` - the cache, and the one subtree `auth.ts` must not token-scan. */
export function cliCacheRoot(stateDirectory: string): string {
  return path.join(stateDirectory, CLI_CACHE_DIRECTORY);
}

export function createCopilotCli(options: CopilotCliOptions): CopilotCliResolver {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const environment = options.environment ?? process.env;
  const homeDir = options.homeDir ?? homedir();

  return createCopilotCliResolver({
    cacheRoot: cliCacheRoot(options.stateDirectory),
    platform,
    platformKey: `${platform}-${arch}`,
    discover: () =>
      discoverLocalClis({ platform, arch, env: environment, homeDir }, nodeFileSystem),
    probe: options.probe ?? createCliProbe(),
    fetch: () => Promise.resolve(options.fetch),
  });
}
