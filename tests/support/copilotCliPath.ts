import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The Copilot CLI executable an integration test spawns.
 *
 * In the application the CLI is **resolved at sign-in time** by the agent itself
 * (`src/agents/copilot/cli/`: an installed copy, its own cache, or the latest
 * verified GitHub release), so production code no longer resolves it from
 * `node_modules`. A test run is a development checkout with `@github/copilot`
 * installed as a devDependency, and spawning the real CLI is the point of these
 * integration tests, so they resolve it here.
 */
export function resolveCopilotCliExe(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  root: string = process.cwd(),
): string {
  const packageDirectory = path.join(
    root,
    'node_modules',
    '@github',
    `copilot-${platform}-${arch}`,
  );
  const exe = path.join(packageDirectory, platform === 'win32' ? 'copilot.exe' : 'copilot');
  if (!existsSync(exe)) {
    throw new Error(
      `Expected the Copilot CLI at "${exe}". It is a devDependency (@github/copilot) ` +
        'that ships the platform package these integration tests spawn.',
    );
  }
  return exe;
}
