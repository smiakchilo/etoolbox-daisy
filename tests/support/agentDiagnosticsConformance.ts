import { describe, expect, it } from 'vitest';
import { type AgentEvent, type ChatId, type ModelPreference, turnIdSchema } from '../../src/shared';

/**
 * The diagnostics contract every agent adapter must honour, whatever its SDK:
 * the journal-only `model.changed` / `model.usage` events (see
 * `src/shared/contracts/agentEvents.ts`). An adapter test file supplies a
 * harness - how to build the adapter around a fake SDK and how to run a turn
 * on it - and gets the same assertions as every other agent. A new agent
 * (e.g. Claude) is conformant when this suite passes against it.
 */

export interface ConformanceUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface DiagnosticsHarness {
  readonly events: AgentEvent[];
  readonly chatId: ChatId;
  /** Sends `prompt` as `turnId` and drives the turn to its end, reporting `usage` as one model call. */
  runTurn(turnId: ReturnType<typeof turnIdSchema.parse>, usage?: ConformanceUsage): Promise<void>;
  /** Changes the Settings model/effort the adapter reads at the start of its next turn. */
  setPreference(preference: ModelPreference): void;
}

export type DiagnosticsHarnessFactory = (
  preference: ModelPreference,
) => Promise<DiagnosticsHarness>;

const turn = (n: number) => turnIdSchema.parse(`conformance-turn-${String(n)}`);

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
  });
}
