import { describe, expect, it } from 'vitest';
import {
  createSessionUsage,
  describeGauge,
  describeUsagePanel,
  formatExactTokens,
  formatTokenCount,
  replayJournalIntoUsage,
  uncachedInput,
} from '../../../../src/renderer/src/chat/sessionUsage';
import type { AgentEvent, ChatJournalRecord } from '../../../../src/shared';

const CHAT = 'chat-1';

function usage(fields: Record<string, unknown>): AgentEvent {
  return { type: 'model.usage', chatId: CHAT, sequence: 0, ...fields } as AgentEvent;
}

function context(currentTokens: number, tokenLimit: number): AgentEvent {
  return {
    type: 'context.usage',
    chatId: CHAT,
    sequence: 0,
    currentTokens,
    tokenLimit,
  } as AgentEvent;
}

function folded(
  ...events: AgentEvent[]
): ReturnType<ReturnType<typeof createSessionUsage>['snapshot']> {
  const session = createSessionUsage();
  for (const event of events) session.apply(event);
  return session.snapshot();
}

const rowValue = (
  rows: ReturnType<typeof describeUsagePanel>,
  id: (typeof rows)[number]['id'],
): string | undefined => rows.find((row) => row.id === id)?.value;

describe('createSessionUsage', () => {
  it('sums every call of the conversation, cached reads included in the gross input', () => {
    const snapshot = folded(
      usage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 60 }),
      usage({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 150 }),
    );

    expect(snapshot.calls).toBe(2);
    expect(snapshot.input).toEqual({ value: 300, complete: true });
    expect(snapshot.output).toEqual({ value: 30, complete: true });
    expect(snapshot.cacheRead).toEqual({ value: 210, complete: true });
  });

  it('marks a total as a lower bound when a call did not report it, never as zero', () => {
    const snapshot = folded(usage({ inputTokens: 100 }), usage({ outputTokens: 5 }));

    expect(snapshot.input).toEqual({ value: 100, complete: false });
    expect(snapshot.output).toEqual({ value: 5, complete: false });
  });

  it('leaves a metric undefined when no call ever reported it', () => {
    const snapshot = folded(usage({ inputTokens: 1 }));

    expect(snapshot.cacheRead).toBeUndefined();
    expect(snapshot.aiCredits).toBeUndefined();
    expect(snapshot.costs).toEqual({});
  });

  it('keeps costs of different units apart, and ignores a cost with no unit', () => {
    const snapshot = folded(
      usage({ cost: 0.25, costUnit: 'usd' }),
      usage({ cost: 0.5, costUnit: 'usd' }),
      usage({ cost: 3, costUnit: 'billing-multiplier' }),
      usage({ cost: 99 }),
    );

    expect(snapshot.costs.usd).toEqual({ value: 0.75, complete: false });
    expect(snapshot.costs['billing-multiplier']).toEqual({ value: 3, complete: false });
  });

  it('follows the latest model and the latest context snapshot', () => {
    const snapshot = folded(
      {
        type: 'model.changed',
        chatId: CHAT,
        sequence: 0,
        model: 'a',
        cause: 'session-open',
      } as AgentEvent,
      usage({ model: 'b', inputTokens: 1 }),
      context(10, 100),
      context(20, 100),
    );

    expect(snapshot.model).toBe('b');
    expect(snapshot.context).toEqual({ currentTokens: 20, tokenLimit: 100 });
  });

  it('ignores events that are not usage', () => {
    const snapshot = folded({
      type: 'assistant.text.delta',
      chatId: CHAT,
      sequence: 0,
      turnId: 't',
      messageId: 'm',
      delta: 'x',
    } as AgentEvent);

    expect(snapshot.calls).toBe(0);
  });

  it('starts over on clear', () => {
    const session = createSessionUsage();
    session.apply(usage({ inputTokens: 5 }));
    session.apply(context(1, 2));

    session.clear();

    expect(session.snapshot()).toMatchObject({ calls: 0, input: undefined, context: undefined });
  });
});

describe('replayJournalIntoUsage', () => {
  it('rebuilds a resumed chat from its agent events and nothing else', () => {
    const records = [
      { recordType: 'user.prompt', at: 1, chatId: CHAT, turnId: 't', prompt: 'hi' },
      { recordType: 'agent.event', at: 2, chatId: CHAT, event: usage({ inputTokens: 40 }) },
      { recordType: 'agent.event', at: 3, chatId: CHAT, event: usage({ inputTokens: 2 }) },
    ] as unknown as readonly ChatJournalRecord[];
    const session = createSessionUsage();

    replayJournalIntoUsage(records, session);

    expect(session.snapshot().input).toEqual({ value: 42, complete: true });
  });
});

describe('uncachedInput', () => {
  it('is the gross input less cache reads and writes', () => {
    const snapshot = folded(usage({ inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 10 }));

    expect(uncachedInput(snapshot)).toBe(30);
  });

  it('cannot be stated when input or cache reads were not reported on every call', () => {
    expect(uncachedInput(folded(usage({ inputTokens: 100 })))).toBeUndefined();
    expect(
      uncachedInput(
        folded(usage({ inputTokens: 100, cacheReadTokens: 1 }), usage({ inputTokens: 5 })),
      ),
    ).toBeUndefined();
  });

  it('never goes below zero', () => {
    expect(uncachedInput(folded(usage({ inputTokens: 10, cacheReadTokens: 50 })))).toBe(0);
  });
});

describe('formatTokenCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1k'],
    [1234, '1.2k'],
    [12345, '12.3k'],
    [150000, '150k'],
    [1_500_000, '1.5M'],
  ])('compacts %d', (value, expected) => {
    expect(formatTokenCount(value)).toBe(expected);
  });
});

describe('describeGauge', () => {
  it('shows the compact input and output totals, with the exact ones in the title', () => {
    const gauge = describeGauge(folded(usage({ inputTokens: 12345, outputTokens: 1800 })));

    expect(gauge?.text).toContain(formatTokenCount(12345));
    expect(gauge?.text).toContain(formatTokenCount(1800));
    expect(gauge?.title).toContain(formatExactTokens(12345));
    expect(gauge?.title).toContain(formatExactTokens(1800));
  });

  it('marks a total as a lower bound when a call did not report it', () => {
    const exact = describeGauge(
      folded(
        usage({ inputTokens: 5, outputTokens: 1 }),
        usage({ inputTokens: 5, outputTokens: 1 }),
      ),
    );
    const partial = describeGauge(
      folded(usage({ inputTokens: 5, outputTokens: 1 }), usage({ outputTokens: 1 })),
    );

    expect(partial?.text).not.toBe(exact?.text);
    expect(partial?.text).toContain('5');
  });

  it('shows what was reported when only one of input and output was', () => {
    const gauge = describeGauge(folded(usage({ outputTokens: 800 })));

    expect(gauge?.text).toContain(formatTokenCount(800));
  });

  it.each([
    ['a conversation that has made no call', []],
    ['calls that reported no tokens', [usage({ durationMs: 900 })]],
  ])('has nothing to show for %s', (_name, events) => {
    expect(describeGauge(folded(...events))).toBeUndefined();
  });
});
describe('describeUsagePanel', () => {
  it('lists the model, context, uncached and cached input, and output', () => {
    const rows = describeUsagePanel(
      folded(
        usage({ model: 'gpt-x', inputTokens: 1000, outputTokens: 50, cacheReadTokens: 400 }),
        context(2500, 10000),
      ),
      undefined,
    );

    expect(rowValue(rows, 'model')).toBe('gpt-x');
    expect(rowValue(rows, 'input-uncached')).toBe(formatExactTokens(600));
    expect(rowValue(rows, 'input-cached')).toBe(formatExactTokens(400));
    expect(rowValue(rows, 'output')).toBe(formatExactTokens(50));
    expect(rowValue(rows, 'context')).toContain(formatExactTokens(2500));
    expect(rowValue(rows, 'context')).toContain('25%');
  });

  it('falls back to the selected model before any call named one', () => {
    expect(rowValue(describeUsagePanel(folded(), 'selected-model'), 'model')).toBe(
      'selected-model',
    );
  });

  it('does not invent a context figure or an uncached one it cannot derive', () => {
    const rows = describeUsagePanel(
      folded(usage({ inputTokens: 100, outputTokens: 5 })),
      undefined,
    );

    expect(rowValue(rows, 'context')).not.toMatch(/\d/);
    expect(rowValue(rows, 'input-uncached')).not.toMatch(/\d/);
  });

  it('shows a cost only when one was reported in a unit worth showing', () => {
    const none = describeUsagePanel(folded(usage({ inputTokens: 1 })), undefined);
    const multiplierOnly = describeUsagePanel(
      folded(usage({ cost: 1, costUnit: 'billing-multiplier' })),
      undefined,
    );
    const usd = describeUsagePanel(folded(usage({ cost: 0.0123, costUnit: 'usd' })), undefined);
    const credits = describeUsagePanel(folded(usage({ aiCredits: 1.5 })), undefined);

    expect(rowValue(none, 'cost-usd')).toBeUndefined();
    expect(rowValue(none, 'cost-ai-credits')).toBeUndefined();
    expect(rowValue(multiplierOnly, 'cost-usd')).toBeUndefined();
    expect(rowValue(usd, 'cost-usd')).toContain('0.0123');
    expect(rowValue(credits, 'cost-ai-credits')).toContain('1.5');
  });
});
