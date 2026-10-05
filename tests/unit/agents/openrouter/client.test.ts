import { describe, expect, it } from 'vitest';
import { createOpenRouterClient } from '../../../../src/agents/openrouter/client';

/**
 * Regression guard for the OpenRouter `state` seam.
 *
 * The SDK's `callModel` `state` option is a `StateAccessor` - a
 * `{ load, save }` pair - not a `ConversationState` value. Passing the value
 * returned by `createInitialState()` made every turn reject immediately with
 * `this.stateAccessor.load is not a function`, before a single HTTP request was
 * sent, which surfaced to the user as a stuck "The last turn ended in an error"
 * banner. This asserts the accessor contract directly.
 */
describe('createOpenRouterClient conversation state', () => {
  it('returns a { load, save } accessor that round-trips the conversation state', async () => {
    const client = createOpenRouterClient({ apiKey: 'sk-or-test' });

    const accessor = client.createConversationState() as {
      load: () => Promise<unknown>;
      save: (state: unknown) => Promise<void>;
    };

    expect(typeof accessor.load).toBe('function');
    expect(typeof accessor.save).toBe('function');
    await expect(accessor.load()).resolves.toBeNull();

    const saved = { fake: true };
    await accessor.save(saved);
    await expect(accessor.load()).resolves.toBe(saved);
  });
});
