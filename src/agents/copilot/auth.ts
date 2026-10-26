import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CLI_CACHE_DIRECTORY } from './cli/cache';
import type { ProxyEnvOverrides } from './copilotClient';

/**
 * Environment variables that short-circuit `copilot login` (the CLI reads
 * them before attempting the interactive web flow, in this precedence
 * order). They must be stripped from the login child's environment so a
 * developer's/CI's ambient token cannot silently substitute for the flow we
 * are trying to test, and so a stale token cannot make `login` appear to
 * succeed without ever exercising the real OAuth path.
 */
const LOGIN_SHORT_CIRCUIT_ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * How long to wait for the web flow before giving up. A denied authorization
 * never terminates the CLI on its own (see `startWebFlowLogin`), so without
 * this the app would wait forever.
 */
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;

export interface LoginEnvOptions {
  /** App-owned COPILOT_HOME the login writes its result into. */
  readonly copilotHomeDir: string;
  readonly proxy?: ProxyEnvOverrides;
  /** Override for `process.env`, used by tests. */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Builds the environment for the `copilot login` child process: spreads the
 * base environment (never starts from an empty object - see
 * `copilotClient.ts`'s `buildRuntimeChildEnv` for why), deletes the three
 * short-circuiting token variables, and points `COPILOT_HOME` at our
 * app-owned directory. `COPILOT_DISABLE_KEYTAR` is never set here - doing so
 * would push a successful login toward the plaintext fallback the
 * requirements forbid (see `toolPolicy.ts`/`copilotClient.ts` for the
 * `mode: "empty"` finding this mirrors).
 */
export function buildLoginChildEnv(options: LoginEnvOptions): Record<string, string> {
  const base = options.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const varName of LOGIN_SHORT_CIRCUIT_ENV_VARS) {
    delete env[varName];
  }
  env['COPILOT_HOME'] = options.copilotHomeDir;
  if (options.proxy?.httpsProxy !== undefined) env['HTTPS_PROXY'] = options.proxy.httpsProxy;
  if (options.proxy?.httpProxy !== undefined) env['HTTP_PROXY'] = options.proxy.httpProxy;
  if (options.proxy?.noProxy !== undefined) env['NO_PROXY'] = options.proxy.noProxy;
  if (options.proxy?.nodeExtraCaCerts !== undefined) {
    env['NODE_EXTRA_CA_CERTS'] = options.proxy.nodeExtraCaCerts;
  }
  return env;
}

export type LoginOutcome =
  | { readonly status: 'success' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };

export interface LoginProcessHandle {
  /** Resolves once the login process exits. Never rejects. */
  readonly outcome: Promise<LoginOutcome>;
  /** Terminates the login process (e.g. user clicked Cancel). */
  cancel(): void;
}

/** Injectable for tests; defaults to the real `child_process.spawn`. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; windowsHide: boolean },
) => ChildProcess;

/**
 * Spawns `copilot.exe login --web-flow`, which opens the user's default
 * browser and runs GitHub's own official Copilot CLI OAuth app (PKCE S256,
 * loopback callback) - never a custom or borrowed OAuth app. Never builds a
 * shell command string from user input: `shell: false` and an argv array are
 * used unconditionally, and the only argv values are this function's own
 * literals plus `options.host`.
 *
 * DENIAL BEHAVIOUR (verified live, upstream defect we must defend against):
 * the CLI binds a random loopback port and sets
 * `redirect_uri=http://127.0.0.1:<randomPort>/callback`, but when the user
 * clicks "Cancel" on GitHub's authorization page, GitHub redirects to the
 * OAuth app's *registered* callback `http://127.0.0.1/callback` - with no
 * port. Nothing is listening there, so the browser shows "127.0.0.1 refused
 * to connect" and the CLI keeps waiting on its random port forever. A denied
 * login therefore never exits on its own and is indistinguishable, from the
 * outside, from a login the user simply abandoned. `timeoutMs` exists so the
 * app surfaces an actionable failure instead of hanging indefinitely.
 */
export function startWebFlowLogin(
  cliExePath: string,
  options: LoginEnvOptions & { readonly host?: string; readonly timeoutMs?: number },
  spawnFn: SpawnFn = spawn,
): LoginProcessHandle {
  const args = ['login', '--web-flow', ...(options.host ? ['--host', options.host] : [])];
  const env = buildLoginChildEnv(options);
  const child = spawnFn(cliExePath, args, { env, windowsHide: true });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  const outcome = new Promise<LoginOutcome>((resolve) => {
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'failed', message: error.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          status: 'failed',
          message:
            'Sign-in was not completed in time. If you denied access on the GitHub page, ' +
            'your browser may have shown \u201C127.0.0.1 refused to connect\u201D - that is ' +
            'expected, and sign-in was not completed. Please try again and choose ' +
            '\u201CAuthorize\u201D to continue',
        });
        return;
      }
      if (signal) {
        resolve({ status: 'cancelled' });
        return;
      }
      if (code === 0) {
        resolve({ status: 'success' });
        return;
      }
      const message =
        stderr.trim() || stdout.trim() || `copilot login exited with code ${String(code)}`;
      resolve({ status: 'failed', message });
    });
  });

  return {
    outcome,
    cancel: () => {
      clearTimeout(timer);
      child.kill();
    },
  };
}

const PLAINTEXT_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgho_[A-Za-z0-9]+/,
  /\bghu_[A-Za-z0-9]+/,
  /\bghp_[A-Za-z0-9]+/,
  /\bgithub_pat_[A-Za-z0-9_]+/,
  /access_token/i,
];

/**
 * Fails closed: scans every file under the app-owned `COPILOT_HOME` for
 * GitHub token-shaped substrings. A confirmed passing state after login is
 * `config.json` containing only `lastLoggedInUser`/`loggedInUsers` plus a
 * `logs/` directory, with the actual secret in the OS-backed credential
 * vault. Any plaintext token material anywhere under this directory is
 * treated as a hard failure, not a warning.
 *
 * The CLI cache (`<home>/cli`, see `./cli/cache.ts`) is skipped: those are
 * digest-verified binaries this agent downloaded, not text the CLI wrote, and
 * reading a 140 MB executable as UTF-8 on every sign-in is both slow and prone
 * to matching token-shaped bytes inside a binary.
 */
export async function assertNoPlaintextCredentials(copilotHomeDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(copilotHomeDir, { recursive: true });
  } catch {
    // Directory does not exist yet (e.g. before first login) - nothing to scan.
    return;
  }

  for (const entry of entries) {
    if (entry.split(path.sep)[0] === CLI_CACHE_DIRECTORY) continue;
    const fullPath = path.join(copilotHomeDir, entry);
    let content: string;
    try {
      content = await readFile(fullPath, 'utf8');
    } catch {
      // Not a readable regular text file (directory, binary, permissions) - skip.
      continue;
    }
    for (const pattern of PLAINTEXT_TOKEN_PATTERNS) {
      if (pattern.test(content)) {
        throw new Error(
          `Potential plaintext GitHub credential detected in "${fullPath}" ` +
            `(matched ${pattern.toString()}). Failing closed`,
        );
      }
    }
  }
}

/**
 * Local sign-out only. This intentionally does NOT call the SDK's
 * `client.rpc.account.logout()` RPC.
 *
 * Vault entries are keyed `copilot-cli/<host>:<login>` - by GitHub account,
 * shared machine-wide, and NOT scoped by `COPILOT_HOME` (verified live: a
 * developer machine already had vault entries for two other accounts before
 * this app's first login). `COPILOT_HOME` only isolates *which account is
 * active* for this app (via `config.json`), not the vault entry itself. A
 * real account-logout RPC targets the vault entry for the currently active
 * account, which may be the *same* account another Copilot installation
 * (e.g. the user's personal `~/.copilot`) is relying on - deleting it there
 * would silently sign that other installation out too.
 *
 * So "logout" here means: delete only this app's own `config.json` (the
 * active-account pointer inside our own `COPILOT_HOME`), leaving the shared
 * vault entry untouched. The caller-facing warning must always be shown
 * verbatim so the user understands the shared credential still exists.
 */
export async function localSignOut(copilotHomeDir: string): Promise<{ warning: string }> {
  const configPath = path.join(copilotHomeDir, 'config.json');
  await rm(configPath, { force: true });
  return {
    warning:
      'Signed out of EToolbox Daisy only. The GitHub credential itself remains in the ' +
      'Windows Credential Manager and is shared machine-wide with any other Copilot CLI ' +
      'installation signed in as the same account - it was not revoked. To fully revoke ' +
      'it, sign out from those other installations or remove the entry from Credential ' +
      'Manager directly',
  };
}
