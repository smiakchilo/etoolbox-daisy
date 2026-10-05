import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCopilotAuthPresence } from '../../../../src/agents/copilot/authPresence';

/**
 * The Copilot presence probe: a cheap, non-starting read of the app-owned
 * `COPILOT_HOME/config.json`. No runtime, no vault.
 */

const roots: string[] = [];

async function scratchHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'copilot-home-'));
  roots.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('getCopilotAuthPresence', () => {
  it('is absent when there is no config file', async () => {
    expect(await getCopilotAuthPresence(await scratchHome())).toEqual({ present: false });
  });

  it('is present when config.json names a last logged-in user', async () => {
    const home = await scratchHome();
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ lastLoggedInUser: 'octocat' }),
    );
    expect(await getCopilotAuthPresence(home)).toEqual({ present: true });
  });

  it('is present when config.json lists logged-in users', async () => {
    const home = await scratchHome();
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ loggedInUsers: ['octocat'] }));
    expect(await getCopilotAuthPresence(home)).toEqual({ present: true });
  });

  it('is absent for invalid JSON or an empty account pointer', async () => {
    const home = await scratchHome();
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'config.json'), 'not json');
    expect(await getCopilotAuthPresence(home)).toEqual({ present: false });

    await writeFile(path.join(home, 'config.json'), JSON.stringify({ lastLoggedInUser: '  ' }));
    expect(await getCopilotAuthPresence(home)).toEqual({ present: false });
  });
});
