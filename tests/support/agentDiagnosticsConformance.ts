import { describe, expect, it } from 'vitest';
import { type AgentEvent, type ChatId, type ModelPreference, turnIdSchema } from '../../src/shared';

/**
 * The diagnostics contract every agent adapter must honour, whatever its SDK:
 * the `model.changed` / `model.usage` / `context.usage` events (see
 * `src/shared/contracts/agentEvents.ts`). The user sees the usage totals, so
 * they must add up: cumulative over every model call of a turn, still reported
 * when the turn fails after a completed call, and a cost only ever with its
 * unit. An adapter test file supplies a harness - how to build the adapter
 * around a fake SDK and how to run a turn on it - and gets the same assertions
 * as every other agent. A new agent (e.g. Claude) is conformant when this suite
 * passes against it, and `tests/unit/agents/agentConformance.test.ts` fails the
 * build for an agent folder that does not run it.
 */

export interface ConformanceUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** A cost the SDK reported for the call; the adapter must report it with its unit. */
  readonly cost?: number;
}

export interface ConformanceTurnOptions {
  /** The turn fails after reporting its model calls (the calls still spent tokens). */
  readonly failAfterUsage?: boolean;
  /** The user presses Stop after the model calls were made, while the chat stays open. */
  readonly stopAfterUsage?: boolean;
}

export interface DiagnosticsHarness {
  readonly events: AgentEvent[];
  readonly chatId: ChatId;
  /**
   * Sends `prompt` as `turnId` and drives the turn to its end. `usage` is the
   * model call(s) the turn made - an array is several calls of one tool loop,
   * which the SDK may only expose as a per-turn aggregate (its last round
   * alone must not be what the adapter reports).
   */
  runTurn(
    turnId: ReturnType<typeof turnIdSchema.parse>,
    usage?: ConformanceUsage | readonly ConformanceUsage[],
    options?: ConformanceTurnOptions,
  ): Promise<void>;
  /** Changes the Settings model/effort the adapter reads at the start of its next turn. */
  setPreference(preference: ModelPreference): void;
}

export type DiagnosticsHarnessFactory = (
  preference: ModelPreference,
) => Promise<DiagnosticsHarness>;

const turn = (n: number) => turnIdSchema.parse(`conformance-turn-${String(n)}`);

/** The model calls a harness was asked to make, as a list. */
export function conformanceCalls(
  usage: ConformanceUsage | readonly ConformanceUsage[] | undefined,
): readonly ConformanceUsage[] {
  if (usage === undefined) return [];
  return 'model' in usage ? [usage] : usage;
}

export function describeAgentDiagnosticsConformance(
  agentName: string,
  createHarness: DiagnosticsHarnessFactory,
): void {
  describe(`${agentName} - uniform diagnostics contract`, () => {
    it('reports the model once at the first turn, as session-open, scoped to that turn', async () => {
      const harness = await createHarness({ model: 'model-a', reasoningEffort: 'low' });
      await harness.runTurn(turn(1));
      await harness.runTurn(turn(2));

      const changes = harness.events.filter((event) => event.type === 'model.changed');
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        model: 'model-a',
        reasoningEffort: 'low',
        cause: 'session-open',
        turnId: turn(1),
      });
      expect(changes[0]).not.toHaveProperty('previousModel');
    });

    it('reports a changed preference at the next turn, with the previous values', async () => {
      const harness = await createHarness({ model: 'model-a', reasoningEffort: 'low' });
      await harness.runTurn(turn(1));
      harness.setPreference({ model: 'model-b', reasoningEffort: null });
      await harness.runTurn(turn(2));

      const changes = harness.events.filter((event) => event.type === 'model.changed');
      expect(changes).toHaveLength(2);
      expect(changes[1]).toMatchObject({
        model: 'model-b',
        previousModel: 'model-a',
        previousReasoningEffort: 'low',
        cause: 'preference-change',
        turnId: turn(2),
      });
      expect(changes[1]).not.toHaveProperty('reasoningEffort');
    });

    it('reports an effort-only change', async () => {
      const harness = await createHarness({ model: 'model-a', reasoningEffort: 'low' });
      await harness.runTurn(turn(1));
      harness.setPreference({ model: 'model-a', reasoningEffort: 'high' });
      await harness.runTurn(turn(2));

      const changes = harness.events.filter((event) => event.type === 'model.changed');
      expect(changes).toHaveLength(2);
      expect(changes[1]).toMatchObject({
        model: 'model-a',
        reasoningEffort: 'high',
        previousReasoningEffort: 'low',
        cause: 'preference-change',
      });
    });

    it('reports a model call as model.usage on the turn that made it', async () => {
      const harness = await createHarness({ model: 'model-a', reasoningEffort: null });
      await harness.runTurn(turn(1), { model: 'model-a-2025', inputTokens: 9, outputTokens: 3 });

      const usage = harness.events.filter((event) => event.type === 'model.usage');
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        turnId: turn(1),
        model: 'model-a-2025',
        inputTokens: 9,
        outputTokens: 3,
      });
    });

    it('reports the tokens of every model call of a turn, not just the last round', async () => {
      const harness = await createHarness({ model: 'model-a', reasoningEffort: null });
      await harness.runTurn(turn(1), [
        { model: 'model-a', inputTokens: 10, outputTokens: 2 },
        { model: 'model-a', inputTokens: 20, outputTokens: 3 },
      ]);

      const usage = harness.events.filter((event) => event.type === 'model.usage');
      const sum = (pick: (event: (typeof usage)[number]) => number | undefined): number =>
        usage.reduce((total, event) => total + (pick(event) ?? 0), 0);
      expect(sum((event) => event.inputTokens)).toBe(30);
      expect(sum((event) => event.outputTokens)).toBe(5);
    });

    it('reports the calls a turn completed before it failed', async () => {
      const harness = await createHarness({ model: 'model-a', reasoningEffort: null });
      await harness.runTurn(
        turn(1),
        { model: 'model-a', inputTokens: 7, outputTokens: 1 },
        { failAfterUsage: true },
      );

      const usage = harness.events.filter((event) => event.type === 'model.usage');
      expect(usage.reduce((total, event) => total + (event.inputTokens ?? 0), 0)).toBe(7);
    });

    it('reports the calls a turn completed before the user stopped it', async () => {
      const harness = await createHarness({ model: 'model-a', reasoningEffort: null });
      await harness.runTurn(
        turn(1),
        { model: 'model-a', inputTokens: 11, outputTokens: 2 },
        { stopAfterUsage: true },
      );

      const usage = harness.events.filter((event) => event.type === 'model.usage');
      expect(usage.reduce((total, event) => total + (event.inputTokens ?? 0), 0)).toBe(11);
    });
    it('never reports a cost without its unit, nor an unusable number', async () => {
      const harness = await createHarness({ model: 'model-a', reasoningEffort: null });
      await harness.runTurn(turn(1), {
        model: 'model-a',
        inputTokens: 5,
        outputTokens: 1,
        cost: 0.5,
      });

      for (const event of harness.events) {
        if (event.type === 'model.usage') {
          if (event.cost !== undefined) expect(event.costUnit).toBeDefined();
          for (const value of [
            event.inputTokens,
            event.outputTokens,
            event.cacheReadTokens,
            event.cost,
            event.aiCredits,
          ]) {
            if (value !== undefined) expect(Number.isFinite(value) && value >= 0).toBe(true);
          }
        }
        // Optional per agent, but a snapshot that is reported must describe a real window.
        if (event.type === 'context.usage') expect(event.tokenLimit).toBeGreaterThan(0);
      }
    });
  });
}
