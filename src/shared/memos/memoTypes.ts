import { z } from 'zod';
import type { ToolErrorCode } from '../contracts';
import type { Result } from '../result';

/**
 * The self-learning vocabulary. A memo is a short lesson the agent writes down
 * - when the user asks it to remember something, when the user corrects it, or
 * after a turn that went wrong - and that the application feeds back into later
 * conversations. Main owns the files (`src/main/memos/`); the `memo` tool sees
 * only these types, through `ToolHost.memos`.
 */

/**
 * The `memo` tool's name. Shared rather than owned by `src/tools/memo/` alone
 * because the chat controller watches for it: a turn that already wrote a memo
 * is not reflected on again.
 */
export const MEMO_TOOL_NAME = 'memo';

/**
 * The internal marker tool (`src/tools/memo-reflection/`) the application
 * records for its own post-turn reflection. The model never sees it; the
 * transcript shows it as the reflection's billet and hides that turn's prose.
 */
export const MEMO_REFLECTION_TOOL_NAME = 'memo_reflection';

/** Why a memo was written. */
export const MEMO_TRIGGERS = ['request', 'correction', 'error', 'loop'] as const;

export type MemoTrigger = (typeof MEMO_TRIGGERS)[number];

export const memoTriggerSchema = z.enum(MEMO_TRIGGERS);

/** Longest accepted memo title, in characters. */
export const MEMO_TITLE_MAX_LENGTH = 120;

/** Longest accepted memo body, in bytes (UTF-8). */
export const MEMO_TEXT_MAX_BYTES = 2048;

/**
 * A memo's store-relative id: its path under the memos folder, `/`-separated -
 * `generic/<stamp>-<slug>.md` or `skills/<skill>/<stamp>-<slug>.md`. It is the
 * only way the renderer names a memo; main resolves and contains the path.
 */
export const MEMO_ID_PATTERN =
  /^(?:generic|skills\/[a-z0-9][a-z0-9-]{0,63})\/\d{8}-\d{6}(?:-\d{1,3})?-[a-z0-9-]{1,60}\.md$/;

export const memoIdSchema = z.string().max(200).regex(MEMO_ID_PATTERN);

export type MemoId = z.infer<typeof memoIdSchema>;

/** What the `memo` tool asks the store to write. */
export interface MemoWriteRequest {
  readonly title: string;
  readonly text: string;
  /** The skill the lesson belongs to; absent for a generic memo. */
  readonly skill?: string;
  readonly trigger: MemoTrigger;
}

/** One written memo. */
export interface MemoRecord {
  readonly id: MemoId;
  readonly title: string;
  /** The owning skill; absent for a generic memo. */
  readonly skill?: string;
  /** The file name alone, for display. */
  readonly fileName: string;
}

export interface MemoFailure {
  readonly code: ToolErrorCode;
  readonly message: string;
}

export type MemoOutcome<TValue> = Result<TValue, MemoFailure>;

/**
 * The `memo` tool's window onto the memo store. `write` resolves an outcome
 * and never rejects: self-learning switched off, an unknown skill or a
 * duplicate is a failure the tool reports, never an exception.
 */
export interface MemoHost {
  /** Whether self-learning is switched on, read fresh. */
  enabled(): boolean;
  write(request: MemoWriteRequest): Promise<MemoOutcome<MemoRecord>>;
  /**
   * The model-facing block of one skill's memos, appended to that skill's
   * activation; `""` when it has none or self-learning is switched off.
   * Never rejects.
   */
  skillMemos(skill: string): Promise<string>;
}
