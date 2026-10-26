import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createCliProbe } from '../../../../../src/agents/copilot/cli/probe';

/**
 * The probe is the one place a file found on the machine is executed, so its
 * contract is narrow: it answers only when the candidate names a version, and
 * it never outlives the sign-in that asked for it.
 */

interface FakeChild extends EventEmitter {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  return child;
}

/**
 * A double cannot implement `ChildProcess` structurally, and spawning a real
 * child would test Node rather than this module - the one cast is the fixture's
 * boundary, not a shortcut around a type error in production code.
 */
function asProcess(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

function probeWith(child: FakeChild, signal?: AbortSignal): Promise<string | undefined> {
  return createCliProbe(() => asProcess(child))('/usr/bin/copilot', signal);
}

describe('createCliProbe', () => {
  it('reads the version the candidate prints', async () => {
    const child = fakeChild();
    const version = probeWith(child);

    child.stdout.emit('data', Buffer.from('GitHub Copilot CLI 1.0.103.\n'));
    child.emit('exit', 0, null);

    await expect(version).resolves.toBe('1.0.103');
  });

  it('answers nothing when the candidate does not name a version', async () => {
    const child = fakeChild();
    const version = probeWith(child);

    child.stdout.emit('data', Buffer.from('bash: command not found\n'));
    child.emit('exit', 127, null);

    await expect(version).resolves.toBeUndefined();
  });

  it('answers nothing when the process cannot be started', async () => {
    const probe = createCliProbe(() => {
      throw new Error('ENOENT');
    });

    await expect(probe('C:\\missing\\copilot.exe')).resolves.toBeUndefined();
  });

  it('kills the child when the sign-in is cancelled', async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const version = probeWith(child, controller.signal);

    controller.abort();

    await expect(version).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalled();
  });

  it('does not start anything when the signal is already aborted', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => asProcess(child));
    const controller = new AbortController();
    controller.abort();

    await expect(
      createCliProbe(spawnFn)('/usr/bin/copilot', controller.signal),
    ).resolves.toBeUndefined();
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
