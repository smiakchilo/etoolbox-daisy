import type { MemoHost, MemoOutcome, MemoRecord } from '../../shared';
import type { Logger } from '../logger';
import { renderSkillMemos } from './memoRendering';
import type { MemoStore } from './memoStore';

/**
 * The `memo` tool's {@link MemoHost}: the memo store behind the Settings
 * **Self-learning** switch. The switch is read fresh on every call, so turning
 * it off stops writes at once, with no runtime restart (the tool itself stays
 * registered, because a runtime's tool set is fixed when it starts).
 */

export interface MemoHostOptions {
  readonly store: Pick<MemoStore, 'forSkill' | 'write'>;
  /** `resources/rules/skill-memos.md`, the frame around one skill's memos. */
  readonly skillMemosTemplate: string;
  /** Whether self-learning is on, read fresh. */
  readonly enabled: () => boolean;
  /** The conversation the memo is written in, recorded in its front matter. */
  readonly currentChatId: () => string | undefined;
  readonly logger: Logger;
}

const SWITCHED_OFF: MemoOutcome<MemoRecord> = {
  ok: false,
  error: {
    code: 'ACCESS_DENIED',
    message: 'Self-learning is switched off in Settings, so no memo was written',
  },
};

export function createMemoHost(options: MemoHostOptions): MemoHost {
  return {
    enabled: options.enabled,
    async write(request) {
      if (!options.enabled()) return SWITCHED_OFF;
      const chatId = options.currentChatId();
      const outcome = await options.store.write(request, chatId === undefined ? {} : { chatId });
      if (!outcome.ok) {
        options.logger.warn(
          outcome.error.code === 'STORAGE_ERROR' ? 'MEMO_WRITE_FAILED' : 'MEMO_REJECTED',
          { outcome: 'failure' },
        );
      }
      return outcome;
    },
    async skillMemos(skill) {
      if (!options.enabled()) return '';
      try {
        return renderSkillMemos(
          options.skillMemosTemplate,
          (await options.store.forSkill(skill)).memos,
        );
      } catch {
        return '';
      }
    },
  };
}
