import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pageAuditArgsSchema } from '../tool';

/**
 * The add-on's own declaration, held against its code.
 *
 * The application advertises a contributed tool from `addon.json` alone - its
 * descriptor, its allowlist entry, its billet - and never sees this module. So
 * the manifest and the schema that actually validates a call must agree: this is
 * the drift test that keeps the model's view honest.
 */

const root = path.join(__dirname, '..');

interface Manifest {
  readonly id: string;
  readonly apiVersion: number;
  readonly entry: string;
  readonly contributes: {
    readonly tools: readonly {
      readonly name: string;
      readonly descriptor: {
        readonly name: string;
        readonly description: string;
        readonly parameters: Record<string, unknown>;
      };
      readonly allowlistEntry: string;
      readonly instructions: string;
      readonly presentation?: string;
      readonly billet?: {
        readonly summary?: { readonly path: string };
        readonly rows: readonly { readonly value: { readonly path: string } }[];
      };
    }[];
  };
}

const manifest = JSON.parse(readFileSync(path.join(root, 'addon.json'), 'utf8')) as Manifest;
const tool = manifest.contributes.tools[0];

describe('addon.json', () => {
  it('declares the tool this add-on activates', () => {
    expect(tool?.name).toBe('page_audit');
    expect(tool?.descriptor.name).toBe(tool?.name);
    expect(tool?.allowlistEntry).toBe(`custom:${String(tool?.name)}`);
    expect(tool?.presentation).toBe('report');
  });

  it('declares exactly the parameter schema the tool validates with', () => {
    // One contract: the JSON Schema the model reads and the zod schema a call is
    // checked against are the same shapes, so they cannot drift.
    expect(tool?.descriptor.parameters).toEqual(
      z.toJSONSchema(pageAuditArgsSchema, { io: 'input' }),
    );
  });

  it('reads only parameters its descriptor declares', () => {
    const properties = (tool?.descriptor.parameters['properties'] ?? {}) as Record<string, unknown>;
    const paths = [
      ...(tool?.billet?.summary === undefined ? [] : [tool.billet.summary.path]),
      ...(tool?.billet?.rows ?? []).map((row) => row.value.path),
    ];

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(Object.keys(properties)).toContain(path);
  });
});

describe('the bundled skill', () => {
  const skillsDir = path.join(root, 'skills');
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  function frontMatter(name: string): Record<string, string> {
    const markdown = readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    const [, block] = markdown.split('---');
    const fields: Record<string, string> = {};
    for (const line of (block ?? '').split('\n')) {
      const match = /^\s*([a-z-]+):\s*(.*)$/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) fields[match[1]] = match[2].trim();
    }
    return fields;
  }

  it('is a user-invocable, table-only skill whose summary reads as a label', () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const fields = frontMatter(name);
      expect(fields['name']).toBe(name);
      expect((fields['description'] ?? '').length).toBeGreaterThan(0);
      expect((fields['description'] ?? '').length).toBeLessThanOrEqual(1024);
      expect(fields['table-only']).toBe('true');
      // The composer and the home screen render this verbatim.
      expect(fields['user-description'] ?? '').toMatch(/\S/);
      expect(fields['user-description'] ?? '').not.toMatch(/[.!?]$/);
    }
  });
});
