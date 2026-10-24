import { describe, expect, it } from 'vitest';
import type { ModelUsageBody, OneShotRequest, OneShotResult } from '../../src/shared';

/**
 * The contract of `AgentRuntime.complete` - the one routine behind every tool's
 * secondary agentic turn (see `src/shared/agents/oneShot.ts`). It is no chat turn
 * and emits no events, but it spends the chat's tokens, so every model call it
 * makes must reach the usage sink it is given; and, being generic, it must run
 * exactly what the caller asked and know nothing of any one tool. An agent that
 * defines `complete` supplies a harness around its fake SDK and gets the same
 * assertions as every other; `tests/unit/agents/agentConformance.test.ts` fails
 * the build for one that does not run this suite.
 */

export const ONE_SHOT_REQUEST: OneShotRequest = {
  instructions: 'conformance-instructions',
  prompt: 'conformance-prompt',
};

export interface OneShotScenario {
  /** What the model call used. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The reply text on success. */
  readonly reply?: string;
  /** The model call fails after it spent its tokens (a transport or provider error). */
  readonly fails?: boolean;
}

export interface OneShotOutcome {
  readonly result: OneShotResult;
  /** Every body the runtime handed to the sink. */
  readonly reports: readonly ModelUsageBody[];
  /** What actually reached the model. */
  readonly sent: { readonly instructions: string; readonly prompt: string };
}

/** Runs {@link ONE_SHOT_REQUEST} through the agent's `complete`, in the scenario. */
export type OneShotHarness = (scenario: OneShotScenario) => Promise<OneShotOutcome>;

const sumOf = (
  reports: readonly ModelUsageBody[],
  pick: (body: ModelUsageBody) => number | undefined,
): number => reports.reduce((total, body) => total + (pick(body) ?? 0), 0);

export function describeAgentOneShotConformance(agentName: string, run: OneShotHarness): void {
  describe(`${agentName} - secondary-turn (complete) contract`, () => {
    it('returns the reply text and reports the tokens of the call', async () => {
      const { result, reports } = await run({
        inputTokens: 40,
        outputTokens: 6,
        reply: 'the reply',
      });

      expect(result).toEqual({ ok: true, value: 'the reply' });
      expect(sumOf(reports, (body) => body.inputTokens)).toBe(40);
      expect(sumOf(reports, (body) => body.outputTokens)).toBe(6);
    });

    it('still reports the tokens of a call that failed', async () => {
      const { result, reports } = await run({ inputTokens: 25, outputTokens: 2, fails: true });

      expect(result.ok).toBe(false);
      expect(sumOf(reports, (body) => body.inputTokens)).toBe(25);
    });

    it('runs the instructions and prompt it was given, not any of its own', async () => {
      const { sent } = await run({ inputTokens: 1, outputTokens: 1, reply: 'x' });

      expect(sent.instructions).toBe(ONE_SHOT_REQUEST.instructions);
      expect(sent.prompt).toBe(ONE_SHOT_REQUEST.prompt);
    });

    it('reports only usable numbers, and a cost only with its unit', async () => {
      const { reports } = await run({ inputTokens: 3, outputTokens: 1, reply: 'x' });

      expect(reports.length).toBeGreaterThan(0);
      for (const body of reports) {
        expect(body.type).toBe('model.usage');
        if (body.cost !== undefined) expect(body.costUnit).toBeDefined();
        for (const value of [body.inputTokens, body.outputTokens, body.cost, body.aiCredits]) {
          if (value !== undefined) expect(Number.isFinite(value) && value >= 0).toBe(true);
        }
      }
    });
  });
}
