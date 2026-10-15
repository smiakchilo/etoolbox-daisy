import { TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY } from '../../../src/main/agentComposition';
import type { ScriptedTurn } from '../../../src/main/agents/fakeAgentService';
import type { ElectronApp } from './app';

/** Queues the next scripted response on the live fake agent service. */
export function scriptTurn(app: ElectronApp, turn: ScriptedTurn): Promise<void> {
  // `turn` is JSON-stringified before crossing the `app.evaluate` boundary,
  // rather than embedded directly in the `Arg` type parameter: Playwright's
  // `PageFunctionOn` overload resolution combined with `ScriptedTurn`'s
  // recursive `JsonValue` fields otherwise triggers TS2589 ("Type
  // instantiation is excessively deep").
  const payload = JSON.stringify({ globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY, turn });
  return app.evaluate((_electronNamespace, json: string) => {
    const arg = JSON.parse(json) as { readonly globalKey: string; readonly turn: unknown };
    const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
      readonly scriptNextResponse: (t: unknown) => void;
    };
    fake.scriptNextResponse(arg.turn);
  }, payload);
}

/** Delivers one scripted event; `false` once nothing is left to deliver. */
export function advanceFake(app: ElectronApp): Promise<boolean> {
  return app.evaluate(
    (_electronNamespace, arg: { readonly globalKey: string }) => {
      const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
        readonly advance: () => boolean;
      };
      return fake.advance();
    },
    { globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY },
  );
}

/** Drains the fake one event per round trip, so the renderer paints between events. */
export async function flushFake(app: ElectronApp): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    if (!(await advanceFake(app))) return;
  }
  throw new Error('flushFake exceeded its guard - the fake never drained.');
}

/** Drains the fake in a single round trip and returns how many events it delivered. */
export function flushFakeAtOnce(app: ElectronApp): Promise<number> {
  return app.evaluate(
    (_electronNamespace, arg: { readonly globalKey: string }) => {
      const fake = (globalThis as Record<string, unknown>)[arg.globalKey] as {
        readonly flush: () => number;
      };
      return fake.flush();
    },
    { globalKey: TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY },
  );
}
