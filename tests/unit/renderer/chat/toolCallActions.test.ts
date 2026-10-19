import { describe, expect, it, vi } from 'vitest';
import {
  type ToolCallActionOutcome,
  createToolCallActionState,
} from '../../../../src/renderer/src/chat/toolCallActions';
import type { ToolCallAction } from '../../../../src/shared';
import { flushMicrotasks } from '../../../support/asyncWaits';

const REVEAL: ToolCallAction = { kind: 'memo.reveal', target: 'generic/a.md' };
const UNDO: ToolCallAction = { kind: 'memo.undo', target: 'generic/a.md', doneSummary: 'gone!' };
const ACTIONS = [REVEAL, UNDO];

function runner(outcome: ToolCallActionOutcome) {
  return vi.fn<(action: ToolCallAction) => Promise<ToolCallActionOutcome>>(() =>
    Promise.resolve(outcome),
  );
}

async function activate(
  state: ReturnType<typeof createToolCallActionState>,
  run: ReturnType<typeof runner>,
  kind: ToolCallAction['kind'],
  onSettled: () => void = () => undefined,
): Promise<void> {
  const button = state.hoverActions(ACTIONS, run, onSettled).find((action) => action.id === kind);
  if (button === undefined) throw new Error(`no ${kind} button`);
  button.onActivate();
  await flushMicrotasks();
}

describe('createToolCallActionState', () => {
  it('offers one button per action, and none without a runner', () => {
    const state = createToolCallActionState();
    expect(state.hoverActions(ACTIONS, runner('done'), () => undefined).map((a) => a.id)).toEqual([
      'memo.reveal',
      'memo.undo',
    ]);
    expect(state.hoverActions(ACTIONS, undefined, () => undefined)).toEqual([]);
  });

  it('runs the action it was built for', async () => {
    const state = createToolCallActionState();
    const run = runner('done');
    await activate(state, run, 'memo.reveal');
    expect(run).toHaveBeenCalledWith(REVEAL);
  });

  it('a done reveal settles nothing: the billet keeps its summary and its buttons', async () => {
    const state = createToolCallActionState();
    const onSettled = vi.fn();
    await activate(state, runner('done'), 'memo.reveal', onSettled);
    expect(onSettled).not.toHaveBeenCalled();
    expect(state.settledSummary(ACTIONS)).toBeUndefined();
    expect(state.hoverActions(ACTIONS, runner('done'), () => undefined)).toHaveLength(2);
  });

  it('a done undo settles the target with its own summary and withdraws the buttons', async () => {
    const state = createToolCallActionState();
    const onSettled = vi.fn();
    await activate(state, runner('done'), 'memo.undo', onSettled);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(state.settledSummary(ACTIONS)).toBe(UNDO.doneSummary);
    expect(state.hoverActions(ACTIONS, runner('done'), () => undefined)).toEqual([]);
  });

  it('a reveal that finds the memo gone settles it with the billet final summary', async () => {
    const state = createToolCallActionState();
    await activate(state, runner('gone'), 'memo.reveal');
    expect(state.settledSummary(ACTIONS)).toBe(UNDO.doneSummary);
  });

  it('a failed or rejected action settles nothing', async () => {
    const state = createToolCallActionState();
    const onSettled = vi.fn();
    await activate(state, runner('failed'), 'memo.undo', onSettled);
    const rejecting = vi.fn<(action: ToolCallAction) => Promise<ToolCallActionOutcome>>(() =>
      Promise.reject(new Error('ipc down')),
    );
    await activate(state, rejecting, 'memo.undo', onSettled);
    expect(onSettled).not.toHaveBeenCalled();
    expect(state.settledSummary(ACTIONS)).toBeUndefined();
  });

  it('settles per target: another memo keeps its buttons', async () => {
    const state = createToolCallActionState();
    await activate(state, runner('done'), 'memo.undo');
    const other: ToolCallAction[] = [{ ...UNDO, target: 'generic/b.md' }];
    expect(state.settledSummary(other)).toBeUndefined();
    expect(state.hoverActions(other, runner('done'), () => undefined)).toHaveLength(1);
  });
});
