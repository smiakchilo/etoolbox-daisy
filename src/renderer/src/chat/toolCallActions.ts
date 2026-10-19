import type { ToolCallAction } from '../../../shared';
import type { HoverAction } from './hoverActionPopover';

/**
 * What carrying out a billet action came to: `done` (it worked), `gone` (its
 * target no longer exists - a memo removed by hand, or by an earlier Undo in a
 * replayed transcript), or `failed` (it could not be done; nothing changes).
 */
export type ToolCallActionOutcome = 'done' | 'gone' | 'failed';

export type ToolCallActionRunner = (action: ToolCallAction) => Promise<ToolCallActionOutcome>;

const ACTION_PRESENTATION: Readonly<
  Record<
    ToolCallAction['kind'],
    { readonly title: string; readonly icon: keyof HTMLElementTagNameMap }
  >
> = {
  'memo.reveal': { title: 'Reveal in folder', icon: 'sp-icon-file-txt' },
  'memo.undo': { title: 'Undo', icon: 'sp-icon-undo' },
};

/**
 * The per-transcript record of billet actions whose effect is final: once an
 * Undo is done (or any action finds its target gone), the target is settled -
 * the billet reads the action's `doneSummary` and offers nothing more for it.
 * It lives in the view, not the journal: a replayed transcript starts clean,
 * and the first action on a memo that no longer exists settles it (`gone`).
 */
export interface ToolCallActionState {
  /** The summary a billet should read instead of its own, once its target is settled. */
  settledSummary(actions: readonly ToolCallAction[]): string | undefined;
  /**
   * The hover buttons for a billet's actions - none once settled. `onSettled`
   * runs after an action settles its target, for the view to redraw the billet.
   */
  hoverActions(
    actions: readonly ToolCallAction[],
    run: ToolCallActionRunner | undefined,
    onSettled: () => void,
  ): readonly HoverAction[];
}

export function createToolCallActionState(): ToolCallActionState {
  const settled = new Map<string, string>();

  function settledSummary(actions: readonly ToolCallAction[]): string | undefined {
    for (const action of actions) {
      const summary = settled.get(action.target);
      if (summary !== undefined) return summary;
    }
    return undefined;
  }

  function finalSummary(actions: readonly ToolCallAction[]): string | undefined {
    return actions.find((action) => action.doneSummary !== undefined)?.doneSummary;
  }

  return {
    settledSummary,
    hoverActions(actions, run, onSettled) {
      if (run === undefined || settledSummary(actions) !== undefined) return [];
      return actions.map((action) => ({
        id: action.kind,
        title: ACTION_PRESENTATION[action.kind].title,
        icon: ACTION_PRESENTATION[action.kind].icon,
        onActivate: () => {
          void run(action)
            .catch((): ToolCallActionOutcome => 'failed')
            .then((outcome) => {
              const summary =
                outcome === 'done'
                  ? action.doneSummary
                  : outcome === 'gone'
                    ? finalSummary(actions)
                    : undefined;
              if (summary === undefined) return;
              settled.set(action.target, summary);
              onSettled();
            });
        },
      }));
    },
  };
}
