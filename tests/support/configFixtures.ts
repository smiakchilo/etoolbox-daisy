import {
  type ProjectSnapshot,
  type ServerConfig,
  newProjectId,
  newServerId,
  projectSnapshotSchema,
  serverConfigSchema,
} from '../../src/shared';

/** A blue-swatch host; `overrides` are merged over the defaults before parsing. */
export function makeServer(
  id: string,
  origin: string,
  overrides: Partial<Record<string, unknown>> = {},
): ServerConfig {
  return serverConfigSchema.parse({
    id: newServerId(() => id),
    label: `Server ${id}`,
    origin,
    color: { kind: 'swatch', swatch: 'blue' },
    revision: 0,
    ...overrides,
  });
}

/** The "Author" host at `https://author.example`; `overrides` win over every default. */
export function makeAuthorServer(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): ServerConfig {
  return serverConfigSchema.parse({
    id: newServerId(() => id),
    label: 'Author',
    origin: 'https://author.example',
    color: { kind: 'swatch', swatch: 'blue' },
    revision: 0,
    ...overrides,
  });
}

export function projectSnapshot(
  id: string,
  label: string,
  roots: {
    contentRoots?: string;
    componentRoots?: string;
    contentPriorityPaths?: string;
    damRoots?: string;
  } = {},
): ProjectSnapshot {
  return projectSnapshotSchema.parse({ id: newProjectId(() => id), label, ...roots });
}
