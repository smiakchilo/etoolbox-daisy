import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type AgentFetch, err, ok, type Result } from '../../shared';

/**
 * The portable Node.js an add-on's first-call build downloads when the machine
 * has none. The version, the hashes and the signers are the install scripts'
 * own pins (`install/install.cmd`, `install/install.command`); a unit test
 * compares the three places, so they cannot drift apart.
 */
export const PINNED_NODE_VERSION = '24.20.0';

export const PINNED_NODE_SHA256 = {
  'win32-x64': '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba',
  'darwin-arm64': '40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8',
  'darwin-x64': '9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4',
} as const;

export const PINNED_NODE_SIGNER = {
  win32: 'OpenJS Foundation',
  darwin: 'Node.js Foundation',
} as const;

export const NODE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** The largest archive accepted; the real ones are a third of this. */
export const NODE_DOWNLOAD_MAX_BYTES = 120 * 1024 * 1024;

const DIST_URL = 'https://nodejs.org/dist';
const MARKER_FILE = `.pinned-${PINNED_NODE_VERSION}`;
const COMMAND_TIMEOUT_MS = 2 * 60_000;

export type NodeDownloadFailureReason =
  'no-node' | 'network' | 'timeout' | 'http-status' | 'insecure' | 'too-large' | 'unexpected';

export interface NodeDownloadFailure {
  readonly reason: NodeDownloadFailureReason;
}

export interface NodeDistribution {
  readonly url: string;
  readonly sha256: string;
  readonly signer: string;
  readonly archive: 'zip' | 'tar.gz';
  /** The folder the archive extracts to. */
  readonly directory: string;
}

/** `undefined` where no pinned distribution exists (nothing is downloaded there). */
export function pinnedNodeDistribution(
  platform: NodeJS.Platform,
  arch: string,
  appleSilicon: boolean,
): NodeDistribution | undefined {
  if (platform === 'win32' && arch === 'x64') {
    const directory = `node-v${PINNED_NODE_VERSION}-win-x64`;
    return {
      url: `${DIST_URL}/v${PINNED_NODE_VERSION}/${directory}.zip`,
      sha256: PINNED_NODE_SHA256['win32-x64'],
      signer: PINNED_NODE_SIGNER.win32,
      archive: 'zip',
      directory,
    };
  }
  if (platform === 'darwin') {
    const suffix = appleSilicon ? 'arm64' : 'x64';
    const directory = `node-v${PINNED_NODE_VERSION}-darwin-${suffix}`;
    return {
      url: `${DIST_URL}/v${PINNED_NODE_VERSION}/${directory}.tar.gz`,
      sha256: PINNED_NODE_SHA256[`darwin-${suffix}`],
      signer: PINNED_NODE_SIGNER.darwin,
      archive: 'tar.gz',
      directory,
    };
  }
  return undefined;
}

export interface CommandResult {
  readonly code: number;
  /** Standard output and standard error together. */
  readonly output: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

export interface NodeDownloaderOptions {
  /** Where the pinned Node.js is kept; the layout `findNodeRuntime` looks for. */
  readonly keptNodeDirectory: string;
  readonly fetch: () => Promise<AgentFetch>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly isAppleSilicon?: () => Promise<boolean>;
  /** Replaces the pinned distribution; a test seam, since the real archive's hash cannot be faked. */
  readonly distribution?: (
    platform: NodeJS.Platform,
    arch: string,
    appleSilicon: boolean,
  ) => NodeDistribution | undefined;
  readonly runCommand?: CommandRunner;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface NodeDownloader {
  /**
   * Makes the pinned Node.js present in the kept folder: downloaded over the
   * configured proxy, its SHA-256 checked before anything is extracted, its
   * signature checked after. Concurrent calls share one download.
   */
  ensure(): Promise<Result<void, NodeDownloadFailure>>;
}

export function createNodeDownloader(options: NodeDownloaderOptions): NodeDownloader {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runCommand = options.runCommand ?? execCommand;
  const isAppleSilicon = options.isAppleSilicon ?? (() => detectAppleSilicon(runCommand));
  const timeoutMs = options.timeoutMs ?? NODE_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? NODE_DOWNLOAD_MAX_BYTES;
  const keptDirectory = options.keptNodeDirectory;
  const workDirectory = path.join(path.dirname(keptDirectory), '.node-download');
  let inFlight: Promise<Result<void, NodeDownloadFailure>> | undefined;

  async function download(): Promise<Result<void, NodeDownloadFailure>> {
    try {
      const distribution = (options.distribution ?? pinnedNodeDistribution)(
        platform,
        arch,
        platform === 'darwin' ? await isAppleSilicon() : false,
      );
      if (distribution === undefined) return fail('no-node');

      const signal = AbortSignal.timeout(timeoutMs);
      let bytes: Buffer;
      try {
        const response = await (await options.fetch())(distribution.url, { signal });
        if (!response.ok) return fail('http-status');
        if (response.url !== '' && !response.url.startsWith('https:')) return fail('insecure');
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) return fail('too-large');
        if (response.body === null) return fail('network');
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          received += chunk.byteLength;
          if (received > maxBytes) return fail('too-large');
          chunks.push(Buffer.from(chunk));
        }
        bytes = Buffer.concat(chunks);
      } catch {
        return fail(signal.aborted ? 'timeout' : 'network');
      }

      // Nothing from the network is written to disk, let alone extracted, unless
      // it is exactly the pinned build.
      const actual = createHash('sha256').update(bytes).digest();
      const expected = Buffer.from(distribution.sha256, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return fail('insecure');
      }

      await rm(workDirectory, { recursive: true, force: true });
      await mkdir(workDirectory, { recursive: true });
      try {
        const archivePath = path.join(workDirectory, `node.${distribution.archive}`);
        await writeFile(archivePath, bytes);
        const extracted = await extract(archivePath, distribution);
        if (!extracted) return fail('unexpected');
        const staged = path.join(workDirectory, 'node');
        await rename(path.join(workDirectory, distribution.directory), staged);
        const executable =
          platform === 'win32' ? path.join(staged, 'node.exe') : path.join(staged, 'bin', 'node');
        if (!(await isSigned(executable, distribution.signer))) return fail('insecure');

        await rm(keptDirectory, { recursive: true, force: true });
        await mkdir(path.dirname(keptDirectory), { recursive: true });
        await rename(staged, keptDirectory);
        // Written last: a copy without the marker is never reused as complete.
        await writeFile(path.join(keptDirectory, MARKER_FILE), '');
        return ok(undefined);
      } finally {
        await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch {
      return fail('unexpected');
    }
  }

  async function extract(archivePath: string, distribution: NodeDistribution): Promise<boolean> {
    const tar =
      platform === 'win32'
        ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
        : '/usr/bin/tar';
    const flags = distribution.archive === 'zip' ? '-xf' : '-xzf';
    const result = await runCommand(tar, [flags, archivePath, '-C', workDirectory], process.env);
    return result.code === 0;
  }

  async function isSigned(executable: string, signer: string): Promise<boolean> {
    if (platform === 'win32') {
      const powershell = path.join(
        process.env['SystemRoot'] ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const script =
        '$s = Get-AuthenticodeSignature -LiteralPath $env:EDAISY_NODE_EXE; ' +
        "if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -like ('*' + $env:EDAISY_NODE_SIGNER + '*')) { exit 0 } else { exit 1 }";
      // A PowerShell 7 parent leaks its module path into Windows PowerShell 5.1, which then
      // cannot load the Security module; an empty value does not help, the variable must be absent.
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'psmodulepath') delete env[key];
      }
      env['EDAISY_NODE_EXE'] = executable;
      env['EDAISY_NODE_SIGNER'] = signer;
      const result = await runCommand(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        env,
      );
      return result.code === 0;
    }
    const codesign = '/usr/bin/codesign';
    const verified = await runCommand(codesign, ['--verify', '--strict', executable], process.env);
    if (verified.code !== 0) return false;
    const details = await runCommand(codesign, ['-dvv', executable], process.env);
    return details.output
      .split('\n')
      .some((line) => line.startsWith(`Authority=Developer ID Application: ${signer}`));
  }

  function fail(reason: NodeDownloadFailureReason): Result<void, NodeDownloadFailure> {
    return err({ reason });
  }

  return {
    ensure() {
      inFlight ??= download().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

function execCommand(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { env, timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

/** The hardware, not the process: a Rosetta-run app still sees an arm64 machine. */
async function detectAppleSilicon(runCommand: CommandRunner): Promise<boolean> {
  const result = await runCommand('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], process.env);
  return result.code === 0 && result.output.trim() === '1';
}
