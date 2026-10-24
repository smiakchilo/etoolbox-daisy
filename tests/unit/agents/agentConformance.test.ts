import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The guard that makes the agent usage contract binding on every SDK. An agent
 * is a folder under `src/agents/<name>/`; dropping one in (Claude, say) must not
 * be able to skip the diagnostics contract - usage that adds up, a cost only
 * with its unit - because the user reads those totals in the footer gauge and the
 * usage panel. So every enabled agent must run the shared conformance suites from
 * its own tests, and one whose runtime defines `complete` (the secondary-turn routine) must also run the
 * one-shot suite (its calls spend the chat's tokens too).
 *
 * Detection is textual on purpose: it needs no SDK, and a rename of a suite
 * breaks this test rather than silently passing.
 */

const ROOT = path.resolve(__dirname, '../../..');
const AGENTS_DIR = path.join(ROOT, 'src', 'agents');
const AGENT_TESTS_DIR = path.join(ROOT, 'tests', 'unit', 'agents');

const DIAGNOSTICS_SUITE = 'describeAgentDiagnosticsConformance';
const ONE_SHOT_SUITE = 'describeAgentOneShotConformance';

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

const readAll = (files: readonly string[]): string =>
  files.map((file) => readFileSync(file, 'utf8')).join('\n');

/** An agent's `complete` capability: a runtime that declares the stateless one-shot call. */
const DEFINES_COMPLETE =
  /\b(?:const|let)\s+complete\b|\bcomplete\s*[:=]\s*(?:async\s*)?(?:\(|function)/;

interface AgentFolder {
  readonly name: string;
  readonly source: string;
  readonly tests: string;
}

function enabledAgents(): AgentFolder[] {
  return readdirSync(AGENTS_DIR)
    .filter((name) => statSync(path.join(AGENTS_DIR, name)).isDirectory())
    .filter((name) => {
      const meta = readFileSync(path.join(AGENTS_DIR, name, 'meta.ts'), 'utf8');
      return !/\bdisabled\s*:\s*true\b/.test(meta);
    })
    .map((name) => {
      const testDirectory = path.join(AGENT_TESTS_DIR, name);
      let tests = '';
      try {
        tests = readAll(sourceFiles(testDirectory));
      } catch {
        // No tests folder at all: reported by the assertions below.
      }
      return { name, source: readAll(sourceFiles(path.join(AGENTS_DIR, name))), tests };
    });
}

describe('every enabled agent runs the shared usage-contract suites', () => {
  const agents = enabledAgents();

  it('finds the agents this repository ships', () => {
    expect(agents.map((agent) => agent.name)).toEqual(
      expect.arrayContaining(['copilot', 'openrouter']),
    );
  });

  it.each(agents.map((agent) => [agent.name, agent] as const))(
    '%s runs the diagnostics conformance suite',
    (_name, agent) => {
      expect(agent.tests).toContain(DIAGNOSTICS_SUITE);
    },
  );

  it.each(
    agents
      .filter((agent) => DEFINES_COMPLETE.test(agent.source))
      .map((agent) => [agent.name, agent] as const),
  )('%s defines `complete`, so it runs the one-shot conformance suite', (_name, agent) => {
    expect(agent.tests).toContain(ONE_SHOT_SUITE);
  });

  it('recognises an agent that defines `complete` (so the guard cannot go blind)', () => {
    const withComplete = agents.filter((agent) => DEFINES_COMPLETE.test(agent.source));
    expect(withComplete.map((agent) => agent.name)).toEqual(
      expect.arrayContaining(['copilot', 'openrouter']),
    );
  });
});
