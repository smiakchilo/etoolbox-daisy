import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  describeInstalledRuntime,
  describeRuntimeDifferences,
  describeRuntimePayloadFiles,
  resolveRuntimePayloadDirectory,
  RUNTIME_DESCRIPTOR_FORMAT,
  runtimePayloadHash,
  type RuntimeDescriptor,
  type RuntimeFileEntry,
} from '../../../../src/main/updates/runtime';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('updates-runtime', 'runtime-');
afterEach(() => scratch.cleanup());

function descriptor(overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
  return {
    format: RUNTIME_DESCRIPTOR_FORMAT,
    electron: '44.9.3',
    payload: 'a'.repeat(32),
    ...overrides,
  };
}

/** Writes `files` under `root`, creating parent directories. */
function seed(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

describe('runtimePayloadHash', () => {
  const entries: readonly RuntimeFileEntry[] = [
    { path: 'a/copilot-runtime.exe', size: 100 },
    { path: 'a/b.node', size: 20 },
  ];

  it('does not depend on the order the files were walked in', () => {
    expect(runtimePayloadHash(entries)).toBe(runtimePayloadHash([...entries].reverse()));
  });

  it('changes when a file size changes', () => {
    const grown = entries.map((entry) =>
      entry.path.endsWith('.node') ? { ...entry, size: entry.size + 1 } : entry,
    );
    expect(runtimePayloadHash(grown)).not.toBe(runtimePayloadHash(entries));
  });

  it('changes when a path changes', () => {
    const renamed = entries.map((entry) =>
      entry.path.endsWith('.node') ? { ...entry, path: 'a/renamed.node' } : entry,
    );
    expect(runtimePayloadHash(renamed)).not.toBe(runtimePayloadHash(entries));
  });

  it('gives an absent payload a stable identity of its own', () => {
    expect(runtimePayloadHash([])).toBe(runtimePayloadHash([]));
    expect(runtimePayloadHash([])).not.toBe(runtimePayloadHash(entries));
  });
});

describe('describeRuntimePayloadFiles', () => {
  it('lists nested files with their sizes and slash-separated paths', async () => {
    const root = scratch.create();
    seed(root, { 'runtime.exe': 'abcd', 'node_modules/pkg/addon.node': 'ab' });

    const files = await describeRuntimePayloadFiles(root);
    const byPath = [...files].sort((left, right) => (left.path < right.path ? -1 : 1));

    expect(byPath).toEqual([
      { path: 'node_modules/pkg/addon.node', size: 2 },
      { path: 'runtime.exe', size: 4 },
    ]);
    expect(files).toHaveLength(2);
  });

  it('treats a missing payload directory as empty rather than failing', async () => {
    expect(await describeRuntimePayloadFiles(path.join(scratch.create(), 'nowhere'))).toEqual([]);
  });
});

describe('describeInstalledRuntime', () => {
  it('describes the payload beside the running archive', async () => {
    const resources = scratch.create();
    const appPath = path.join(resources, 'app.asar');
    writeFileSync(appPath, 'archive bytes');
    seed(`${appPath}.unpacked`, { 'run/copilot-runtime.exe': 'binary', 'run/a.node': 'x' });

    const installed = await describeInstalledRuntime({ appPath, electronVersion: '45.1.0' });

    expect(installed).toEqual({
      format: RUNTIME_DESCRIPTOR_FORMAT,
      electron: '45.1.0',
      payload: runtimePayloadHash([
        { path: 'run/a.node', size: 1 },
        { path: 'run/copilot-runtime.exe', size: 6 },
      ]),
    });
  });

  it('looks for the payload as a sibling of the archive, where electron-builder puts it', () => {
    expect(resolveRuntimePayloadDirectory('C:/app/resources/app.asar')).toBe(
      'C:/app/resources/app.asar.unpacked',
    );
  });
});

describe('describeRuntimeDifferences', () => {
  it('is empty for the same runtime layer', () => {
    expect(describeRuntimeDifferences(descriptor(), descriptor())).toEqual([]);
  });

  it('names a moved Electron', () => {
    expect(describeRuntimeDifferences(descriptor(), descriptor({ electron: '45.0.0' }))).toEqual([
      'electron',
    ]);
  });

  it('names a changed unpacked payload', () => {
    expect(
      describeRuntimeDifferences(descriptor(), descriptor({ payload: 'b'.repeat(32) })),
    ).toEqual(['payload']);
  });

  it('names both when both moved', () => {
    expect(
      describeRuntimeDifferences(
        descriptor(),
        descriptor({ electron: '45.0.0', payload: 'b'.repeat(32) }),
      ),
    ).toEqual(['electron', 'payload']);
  });

  it('reports only the descriptor format when the two are not comparable', () => {
    expect(
      describeRuntimeDifferences(
        descriptor(),
        descriptor({ format: 2 as typeof RUNTIME_DESCRIPTOR_FORMAT, electron: '45.0.0' }),
      ),
    ).toEqual(['format']);
  });
});
