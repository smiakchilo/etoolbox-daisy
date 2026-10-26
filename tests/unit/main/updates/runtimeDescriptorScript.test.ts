import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  describeRuntimePayloadFiles,
  RUNTIME_DESCRIPTOR_FORMAT,
  runtimePayloadHash,
} from '../../../../src/main/updates/runtime';
import { createScratchDirs } from '../../../support/scratchDirs';

/**
 * Two implementations of one algorithm: the application's
 * (`src/main/updates/runtime.ts`) and the release's
 * (`scripts/runtime-descriptor.mjs`, which runs before TypeScript exists in a
 * build). They must agree byte for byte, or every published update would claim a
 * runtime no install has and block itself. The script is plain Node, so it is
 * exercised the way the release runs it - as a process - rather than imported.
 */

const scratch = createScratchDirs('runtime-descriptor-script', 'rds-');
afterEach(() => scratch.cleanup());

const script = path.resolve(__dirname, '../../../../scripts/runtime-descriptor.mjs');

function seed(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function runScript(unpackedDirectory: string, electronVersion: string): unknown {
  const output = execFileSync(
    process.execPath,
    [script, '--describe', unpackedDirectory, '--electron', electronVersion],
    { encoding: 'utf8' },
  );
  return JSON.parse(output);
}

describe('scripts/runtime-descriptor.mjs', () => {
  it('describes a payload exactly as the application does', async () => {
    const unpacked = scratch.create();
    seed(unpacked, {
      'copilot-runtime.exe': 'binary payload',
      'node_modules/@github/copilot-sdk-win32-x64/prebuilds/a.node': 'node addon',
      'nested/deeper/empty.txt': '',
    });

    const fromScript = runScript(unpacked, '44.9.3');

    expect(fromScript).toEqual({
      format: RUNTIME_DESCRIPTOR_FORMAT,
      electron: '44.9.3',
      payload: runtimePayloadHash(await describeRuntimePayloadFiles(unpacked)),
    });
  });

  it('gives an unwritten payload the same identity the application gives it', () => {
    const empty = path.join(scratch.create(), 'absent');

    const fromScript = runScript(empty, '44.9.3');

    expect(fromScript).toMatchObject({ payload: runtimePayloadHash([]) });
  });

  it('moves the payload identity when a packaged file changes size', () => {
    const before = scratch.create();
    const after = scratch.create();
    seed(before, { 'copilot-runtime.exe': 'small' });
    seed(after, { 'copilot-runtime.exe': 'a much larger binary' });

    const first = runScript(before, '44.9.3') as { payload: string };
    const second = runScript(after, '44.9.3') as { payload: string };

    expect(first.payload).not.toBe(second.payload);
  });
});
