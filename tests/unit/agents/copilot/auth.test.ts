import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoPlaintextCredentials,
  buildLoginChildEnv,
  localSignOut,
  startWebFlowLogin,
  type SpawnFn,
} from '../../../../src/agents/copilot/auth';

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'agent-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'auth-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildLoginChildEnv', () => {
  it('spreads the base environment and never starts from an empty object', () => {
    const env = buildLoginChildEnv({
      copilotHomeDir: 'C:\\fake\\home',
      baseEnv: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
    });
    expect(env['PATH']).toBe('C:\\Windows');
    expect(env['SystemRoot']).toBe('C:\\Windows');
  });

  it('strips all three token env vars that would short-circuit the login flow', () => {
    const env = buildLoginChildEnv({
      copilotHomeDir: 'C:\\fake\\home',
      baseEnv: {
        COPILOT_GITHUB_TOKEN: 'gho_should_not_survive',
        GH_TOKEN: 'gho_should_not_survive_either',
        GITHUB_TOKEN: 'gho_nor_this_one',
        UNRELATED: 'kept',
      },
    });
    expect(env['COPILOT_GITHUB_TOKEN']).toBeUndefined();
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['UNRELATED']).toBe('kept');
  });

  it('sets COPILOT_HOME to the app-owned directory', () => {
    const env = buildLoginChildEnv({ copilotHomeDir: 'C:\\fake\\home', baseEnv: {} });
    expect(env['COPILOT_HOME']).toBe('C:\\fake\\home');
  });

  it('applies proxy overrides only when supplied', () => {
    const withoutProxy = buildLoginChildEnv({ copilotHomeDir: 'C:\\fake\\home', baseEnv: {} });
    expect(withoutProxy['HTTPS_PROXY']).toBeUndefined();

    const withProxy = buildLoginChildEnv({
      copilotHomeDir: 'C:\\fake\\home',
      baseEnv: {},
      proxy: { httpsProxy: 'https://proxy.example:8080' },
    });
    expect(withProxy['HTTPS_PROXY']).toBe('https://proxy.example:8080');
    expect(withProxy['HTTP_PROXY']).toBeUndefined();
  });

  it('never sets COPILOT_DISABLE_KEYTAR', () => {
    const env = buildLoginChildEnv({ copilotHomeDir: 'C:\\fake\\home', baseEnv: {} });
    expect(env['COPILOT_DISABLE_KEYTAR']).toBeUndefined();
  });
});

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn();
}

describe('startWebFlowLogin', () => {
  it('spawns with shell:false and an argv array, never a shell string', () => {
    const fakeChild = new FakeChildProcess();
    const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

    startWebFlowLogin('C:\\fake\\copilot.exe', { copilotHomeDir: 'C:\\fake\\home' }, spawnFn);

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, args, options] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      readonly string[],
      { env: unknown },
    ];
    expect(command).toBe('C:\\fake\\copilot.exe');
    expect(args).toEqual(['login', '--web-flow']);
    expect(Array.isArray(args)).toBe(true);
    expect(options).not.toHaveProperty('shell');
  });

  it('resolves to success on a zero exit code', async () => {
    const fakeChild = new FakeChildProcess();
    const spawnFn: SpawnFn = () => fakeChild as never;
    const handle = startWebFlowLogin(
      'C:\\fake\\copilot.exe',
      { copilotHomeDir: 'C:\\fake\\home' },
      spawnFn,
    );
    fakeChild.emit('exit', 0, null);
    await expect(handle.outcome).resolves.toEqual({ status: 'success' });
  });

  it('resolves to cancelled when the process is killed by a signal', async () => {
    const fakeChild = new FakeChildProcess();
    const spawnFn: SpawnFn = () => fakeChild as never;
    const handle = startWebFlowLogin(
      'C:\\fake\\copilot.exe',
      { copilotHomeDir: 'C:\\fake\\home' },
      spawnFn,
    );
    handle.cancel();
    expect(fakeChild.kill).toHaveBeenCalledTimes(1);
    fakeChild.emit('exit', null, 'SIGTERM');
    await expect(handle.outcome).resolves.toEqual({ status: 'cancelled' });
  });

  it('resolves to failed with stderr content on a non-zero exit code', async () => {
    const fakeChild = new FakeChildProcess();
    const spawnFn: SpawnFn = () => fakeChild as never;
    const handle = startWebFlowLogin(
      'C:\\fake\\copilot.exe',
      { copilotHomeDir: 'C:\\fake\\home' },
      spawnFn,
    );
    fakeChild.stderr.emit('data', Buffer.from('something went wrong'));
    fakeChild.emit('exit', 1, null);
    await expect(handle.outcome).resolves.toEqual({
      status: 'failed',
      message: 'something went wrong',
    });
  });
});

describe('assertNoPlaintextCredentials', () => {
  it('passes when COPILOT_HOME does not exist yet', async () => {
    const dir = path.join(createScratchRoot(), 'does-not-exist');
    await expect(assertNoPlaintextCredentials(dir)).resolves.toBeUndefined();
  });

  it('passes for a well-formed post-login config.json (no plaintext credential)', async () => {
    const dir = createScratchRoot();
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ lastLoggedInUser: 'octocat', loggedInUsers: ['octocat'] }),
    );
    await expect(assertNoPlaintextCredentials(dir)).resolves.toBeUndefined();
  });

  it.each(['gho_abc123', 'ghu_abc123', 'ghp_abc123', 'github_pat_abc123', 'access_token'])(
    'fails closed when it finds %s-shaped content',
    async (needle) => {
      const dir = createScratchRoot();
      writeFileSync(path.join(dir, 'config.json'), `{"leak":"${needle}"}`);
      await expect(assertNoPlaintextCredentials(dir)).rejects.toThrow(/plaintext/i);
    },
  );
});

describe('localSignOut', () => {
  it('deletes only config.json and returns the shared-vault blast-radius warning', async () => {
    const dir = createScratchRoot();
    writeFileSync(path.join(dir, 'config.json'), '{}');
    mkdirSync(path.join(dir, 'logs'));
    writeFileSync(path.join(dir, 'logs', 'session.log'), 'unrelated log content');

    const result = await localSignOut(dir);

    expect(result.warning).toMatch(/Credential Manager/i);
    expect(result.warning).toMatch(/shared machine-wide/i);
    // The logs directory (and everything else under COPILOT_HOME) must be untouched.
    expect(existsSync(path.join(dir, 'config.json'))).toBe(false);
    expect(readFileSync(path.join(dir, 'logs', 'session.log'), 'utf8')).toBe(
      'unrelated log content',
    );
  });

  it('is idempotent when config.json does not exist', async () => {
    const dir = createScratchRoot();
    await expect(localSignOut(dir)).resolves.toMatchObject({
      warning: expect.any(String) as string,
    });
  });
});

describe('startWebFlowLogin denial timeout', () => {
  it('turns an indefinitely hanging (denied) login into an actionable failure', async () => {
    // A denied authorization never terminates the CLI: GitHub redirects the
    // browser to the OAuth app's registered callback `http://127.0.0.1/callback`
    // (no port) instead of the CLI's random loopback port, so the CLI keeps
    // waiting and the browser shows "127.0.0.1 refused to connect". Verified
    // live against the real CLI. The timeout is the only thing that turns that
    // hang into a result the UI can act on.
    vi.useFakeTimers();
    try {
      const fakeChild = new FakeChildProcess();
      const spawnFn: SpawnFn = () => fakeChild as never;
      const handle = startWebFlowLogin(
        'C:\\fake\\copilot.exe',
        { copilotHomeDir: 'C:\\fake\\home', timeoutMs: 1_000 },
        spawnFn,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fakeChild.kill).toHaveBeenCalledTimes(1);

      // The kill lands as a signal exit, which must NOT be reported as a plain
      // user cancellation - the user did something different (denied/abandoned).
      fakeChild.emit('exit', null, 'SIGTERM');
      const outcome = await handle.outcome;

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.message).toContain('refused to connect');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the timeout when the login completes normally', async () => {
    vi.useFakeTimers();
    try {
      const fakeChild = new FakeChildProcess();
      const spawnFn: SpawnFn = () => fakeChild as never;
      const handle = startWebFlowLogin(
        'C:\\fake\\copilot.exe',
        { copilotHomeDir: 'C:\\fake\\home', timeoutMs: 1_000 },
        spawnFn,
      );
      fakeChild.emit('exit', 0, null);
      await expect(handle.outcome).resolves.toEqual({ status: 'success' });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fakeChild.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
