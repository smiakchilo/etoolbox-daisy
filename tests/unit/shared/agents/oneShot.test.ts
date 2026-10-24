import { describe, expect, it, vi } from 'vitest';
import {
  ANSWER_SESSION_INSTRUCTIONS,
  answerWith,
  err,
  ok,
  type OneShotRequest,
  type OneShotResult,
} from '../../../../src/shared';

const REQUEST = {
  instruction: 'Waldo is good',
  items: [
    { id: '1', text: 'bad Waldo' },
    { id: '2', text: 'good Waldo' },
  ],
};

describe('answerWith', () => {
  it("asks the model with the answer instructions and a prompt naming every item, and parses the reply's matches", async () => {
    const complete = vi.fn<(request: OneShotRequest) => Promise<OneShotResult>>(() =>
      Promise.resolve(ok('{"matches":[2]}')),
    );

    const result = await answerWith(complete, REQUEST);

    expect(result).toEqual(
      ok([
        { id: '1', match: false },
        { id: '2', match: true },
      ]),
    );
    const sent = complete.mock.calls[0]?.[0];
    expect(sent?.instructions).toBe(ANSWER_SESSION_INSTRUCTIONS);
    expect(sent?.prompt).toContain('Waldo is good');
    expect(sent?.prompt).toContain('[2] good Waldo');
  });

  it('passes the call failure through, keeping a cancellation recognisable', async () => {
    const result = await answerWith(
      () => Promise.resolve(err({ message: 'cancelled', cancelled: true })),
      REQUEST,
    );

    expect(result).toEqual(err({ message: 'cancelled', cancelled: true }));
  });

  it('fails on a reply that is not exactly one known id list, never a silent "none matched"', async () => {
    for (const reply of ['not json', '{"matches":[9]}', '{"other":1}']) {
      const result = await answerWith(() => Promise.resolve(ok(reply)), REQUEST);

      expect(result.ok).toBe(false);
    }
  });
});
