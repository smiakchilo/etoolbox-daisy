import { spawn, type ChildProcess } from 'node:child_process';
import { parseCliVersion } from './version';

/**
 * Reads a candidate's own version by running `copilot --version`.
 *
 * This is the only thing this agent asks of a binary it did not download:
 * it must answer, and the answer must name a version. A launcher script, an
 * unrelated executable that happens to sit on `PATH`, and a corrupt download
 * all fail here, so nothing is ever spawned for a sign-in that we have not
 * first seen start.
 *
 * `--version` is also the CLI's own update check (it may refresh a cached build
 * before answering), which is exactly why the reported version - not the file
 * name - is what the resolver records.
 */

const PROBE_TIMEOUT_MS = 15_000;
const MAX_PROBE_OUTPUT = 8 * 1024;

export type CliProbe = (
  executablePath: string,
  signal?: AbortSignal,
) => Promise<string | undefined>;

export type ProbeSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; windowsHide: boolean },
) => ChildProcess;

export function createCliProbe(spawnFn: ProbeSpawn = spawn): CliProbe {
  return (executablePath, signal) =>
    new Promise<string | undefined>((resolve) => {
      let settled = false;
      let output = '';
      let child: ChildProcess | undefined;

      function finish(version: string | undefined): void {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(version);
      }

      // A cancel during the probe stops the child instead of waiting out the
      // timeout: a candidate can be a 140 MB executable that takes a second to
      // answer, and the user already dismissed the sign-in.
      function onAbort(): void {
        child?.kill();
        finish(undefined);
      }

      if (signal?.aborted === true) {
        finish(undefined);
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        child = spawnFn(executablePath, ['--version'], {
          env: process.env,
          windowsHide: true,
        });
      } catch {
        finish(undefined);
        return;
      }

      const collect = (chunk: Buffer): void => {
        if (output.length >= MAX_PROBE_OUTPUT) return;
        output += chunk.toString('utf8').slice(0, MAX_PROBE_OUTPUT - output.length);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);

      const timer = setTimeout(() => {
        child?.kill();
        finish(undefined);
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();

      child.on('error', () => {
        clearTimeout(timer);
        finish(undefined);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        finish(parseCliVersion(output));
      });
    });
}
