import type { ScriptFailureKind } from './scriptRunner';

/** What the main side hands the worker through `workerData`. */
export interface WorkerJob {
  readonly entry: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly inputJson: string;
  readonly deadlineMs: number;
  readonly memoryBytes: number;
  readonly stackBytes: number;
  readonly maxOutputBytes: number;
  readonly maxLogBytes: number;
}

/** The single message the worker posts back. */
export type WorkerOutcome =
  | {
      readonly ok: true;
      readonly outputJson: string;
      readonly logs: string;
      readonly logsTruncated: boolean;
    }
  | {
      readonly ok: false;
      readonly kind: ScriptFailureKind;
      readonly message: string;
      readonly logs: string;
      readonly logsTruncated: boolean;
    };

/** Importing the boot script is impossible: it is never a key of the modules map. */
export const BOOT_MODULE_NAME = '<boot>';

/** Longest failure message (including a stack) ever returned. */
export const MAX_FAILURE_MESSAGE_CHARS = 4000;
