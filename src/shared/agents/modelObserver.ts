/**
 * The one place that decides when an agent reports `model.changed`, so every
 * agent follows the same rule and a new adapter only says "the conversation now
 * runs on model X". It remembers the last model/reasoning effort reported for
 * the open conversation, stays silent while it is unchanged, and fills in the
 * previous value and the cause. Pure and dependency-free; the adapter adds
 * `chatId`/`sequence`/`turnId` and emits the result.
 */
import type { ModelChangedEvent } from '../contracts';

export interface ObservedModel {
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** A `model.changed` event without the fields only the adapter knows. */
export type ModelChangedBody = Omit<ModelChangedEvent, 'chatId' | 'sequence' | 'turnId'>;

export interface ModelObserver {
  /**
   * Reports the model a turn is about to run on. Returns the event body when it
   * differs from the last reported one (first report: `session-open`, later:
   * `preference-change`), `undefined` when nothing changed.
   */
  observe(next: ObservedModel): ModelChangedBody | undefined;
  /** Records a model the runtime itself announced, without deduplication. */
  record(next: ObservedModel): void;
  /** Forgets the last report (conversation closed, opened or recycled). */
  reset(): void;
}

function sameModel(a: ObservedModel, b: ObservedModel): boolean {
  return a.model === b.model && a.reasoningEffort === b.reasoningEffort;
}

export function createModelObserver(): ModelObserver {
  let last: ObservedModel | undefined;

  return {
    observe(next) {
      if (last !== undefined && sameModel(last, next)) return undefined;
      const previous = last;
      last = next;
      return {
        type: 'model.changed',
        model: next.model,
        ...(next.reasoningEffort !== undefined ? { reasoningEffort: next.reasoningEffort } : {}),
        ...(previous !== undefined ? { previousModel: previous.model } : {}),
        ...(previous?.reasoningEffort !== undefined
          ? { previousReasoningEffort: previous.reasoningEffort }
          : {}),
        cause: previous === undefined ? 'session-open' : 'preference-change',
      };
    },
    record(next) {
      last = next;
    },
    reset() {
      last = undefined;
    },
  };
}
