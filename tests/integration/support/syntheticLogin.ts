import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  startWebFlowLogin,
  type LoginEnvOptions,
  type LoginOutcome,
  type SpawnFn,
} from '../../../src/agent';

const AUTHORIZE_URL_PATTERN = /https:\/\/github\.com\/login\/oauth\/authorize\?\S+/;

let noopBrowserPath: string | undefined;

/**
 * Absolute path to a do-nothing executable used as the child's `$BROWSER`.
 *
 * `copilot.exe login --web-flow` opens the authorize URL in the system browser
 * before it ever reaches the loopback callback this helper drives. That tab is
 * pure side effect for these tests - nothing here needs a browser - but it is
 * not harmless: it loads GitHub's OAuth authorize page in the developer's own
 * signed-in browser, once per test case, on every run.
 *
 * The CLI honours the conventional `BROWSER` variable (verified empirically:
 * with `BROWSER` set, the URL is handed to that command and no real browser
 * opens), so pointing it at a no-op keeps these cases completely offline. The
 * CLI still prints the authorize URL to stdout, which is the only part this
 * helper actually consumes.
 *
 * This is deliberately confined to the test helper. Production login *should*
 * open the user's real browser, so `buildLoginChildEnv()` is left untouched.
 */
function resolveNoopBrowser(): string {
  if (noopBrowserPath !== undefined) return noopBrowserPath;
  const dir = path.join(tmpdir(), 'daisy-noop-browser');
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(dir, 'noop-browser.cmd');
    writeFileSync(file, '@exit /b 0\r\n');
    noopBrowserPath = file;
  } else {
    const file = path.join(dir, 'noop-browser.sh');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
    noopBrowserPath = file;
  }
  return noopBrowserPath;
}

export interface SyntheticLoginResult {
  readonly outcome: LoginOutcome;
  readonly authorizeUrl: string;
  /** Wall-clock time between firing the synthetic callback and the CLI exiting. */
  readonly elapsedMsSinceCallback: number;
}

/**
 * Drives the real `startWebFlowLogin()`/`buildLoginChildEnv()` production
 * seam end-to-end without a real browser or a real GitHub account.
 *
 * `copilot.exe login --web-flow` prints an authorize URL and opens it in the
 * system browser, then waits on a random loopback port for GitHub's redirect
 * - a step this repo's hard requirements explicitly say we must NOT try to
 * make "proxy-aware" (the system browser has its own network configuration).
 * This helper does not touch that step's networking at all: it only reads
 * the URL the CLI printed (via a stdout-tapping `spawnFn` that changes
 * nothing else about the real `spawn` call) and then makes the exact HTTP
 * GET request a browser redirect would make to the CLI's own loopback
 * callback server, with a synthetic (deliberately invalid) authorization
 * code.
 *
 * Everything that follows - the OAuth token exchange
 * (`POST https://github.com/login/oauth/access_token`) and the Copilot user
 * lookup (`GET https://api.github.com/copilot_internal/user`) - is made by
 * the real `copilot.exe` child process's own HTTP client, honouring whatever
 * `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_EXTRA_CA_CERTS` its environment carries
 * (built by the real `buildLoginChildEnv()`, never bypassed). This is the
 * portion of the login flow the proxy/TLS matrix actually needs to prove,
 * and it is exercised for real - verified empirically while building this
 * suite (see `proxy-login.test.ts`'s top-of-file doc comment).
 */
export async function runSyntheticWebFlowLogin(
  cliExePath: string,
  options: LoginEnvOptions & { readonly timeoutMs?: number },
  fakeAuthCode = 'daisy-synthetic-auth-code',
): Promise<SyntheticLoginResult> {
  let stdoutBuffer = '';
  const stdoutTappingSpawn: SpawnFn = (
    command: string,
    args: readonly string[],
    spawnOptions: { env: Record<string, string>; windowsHide: boolean },
  ) => {
    // Suppress the system-browser tab the CLI would otherwise open. Applied
    // here rather than in `buildLoginChildEnv()` so the production login path
    // keeps opening the user's real browser.
    const child = spawn(command, [...args], {
      ...spawnOptions,
      env: { ...spawnOptions.env, BROWSER: resolveNoopBrowser() },
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
    });
    return child;
  };

  const handle = startWebFlowLogin(cliExePath, options, stdoutTappingSpawn);

  const authorizeUrl = await waitFor(() => AUTHORIZE_URL_PATTERN.exec(stdoutBuffer)?.[0], 8_000);
  if (authorizeUrl === undefined) {
    handle.cancel();
    throw new Error(
      `copilot login did not print an authorize URL within 8s. stdout so far:\n${stdoutBuffer}`,
    );
  }

  const parsedAuthorize = new URL(authorizeUrl);
  const redirectUri = new URL(parsedAuthorize.searchParams.get('redirect_uri') ?? '');
  const state = parsedAuthorize.searchParams.get('state') ?? '';
  const callbackUrl = new URL(redirectUri.toString());
  callbackUrl.searchParams.set('code', fakeAuthCode);
  callbackUrl.searchParams.set('state', state);

  const callbackStart = Date.now();
  await new Promise<void>((resolve) => {
    http
      .get(callbackUrl, (res) => {
        res.resume();
        res.on('end', resolve);
      })
      .on('error', () => resolve());
  });

  const outcome = await handle.outcome;
  return { outcome, authorizeUrl, elapsedMsSinceCallback: Date.now() - callbackStart };
}

async function waitFor<T>(check: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/**
 * Best-effort cleanup of the OS-backed vault entry a successful synthetic
 * login creates (`copilot-cli/<host>:<login>`, shared machine-wide - see
 * `auth.ts`'s `localSignOut` doc comment). These tests use a synthetic login
 * name that will never collide with a real account, but leaving Windows
 * Credential Manager entries behind on the developer's/CI's real machine
 * across dozens of test runs is still worth avoiding. Failure here (e.g. on
 * a non-Windows host, or if the entry was never created) is intentionally
 * swallowed - this is hygiene, not correctness.
 */
export async function cleanupVaultEntry(login: string, host = 'https://github.com'): Promise<void> {
  if (process.platform !== 'win32') return;
  await new Promise<void>((resolve) => {
    const child = spawn('cmdkey', [`/delete:${host}:${login}.copilot-cli`], { windowsHide: true });
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}
