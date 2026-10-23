import { describe, expect, it } from 'vitest';
import {
  ANSWER_MAX_ATTEMPTS,
  type AnswerItem,
  parseAnswer,
  renderAnswerPrompt,
} from '../../../../../src/shared';

const items: readonly AnswerItem[] = [
  { id: '1', text: '/content/a\n    (1) jcr:title: "Waldo is good"' },
  { id: '2', text: '/content/b\n    (1) jcr:title: "Waldo is bad"' },
  { id: '3', text: '/content/c\n    (no readable text)' },
];

describe('renderAnswerPrompt', () => {
  it('carries the instruction and every numbered item, and asks for JSON only', () => {
    const prompt = renderAnswerPrompt({ instruction: 'Waldo is benevolent', items });

    expect(prompt).toContain('Waldo is benevolent');
    expect(prompt).toContain('[1] /content/a');
    expect(prompt).toContain('[3] /content/c');
    expect(prompt).toContain('{"matches":[1,4]}');
    expect(prompt).toContain('{"matches":[]}');
  });
});

describe('parseAnswer', () => {
  it('turns a number list into one verdict per item, in item order', () => {
    const result = parseAnswer('{"matches":[3,1]}', items);

    expect(result).toEqual({
      ok: true,
      value: [
        { id: '1', match: true },
        { id: '2', match: false },
        { id: '3', match: true },
      ],
    });
  });

  it('accepts numeric strings, a code fence and surrounding prose', () => {
    for (const answer of [
      '{"matches":["2"]}',
      '```json\n{"matches":[2]}\n```',
      'Here is my answer: {"matches":[2]} - done.',
    ]) {
      const result = parseAnswer(answer, items);
      expect(result.ok && result.value.map((verdict) => verdict.match)).toEqual([
        false,
        true,
        false,
      ]);
    }
  });

  it('accepts an empty list as "nothing matched"', () => {
    const result = parseAnswer('{"matches":[]}', items);
    expect(result.ok && result.value.every((verdict) => !verdict.match)).toBe(true);
  });

  it('rejects prose, a missing list, unknown ids and non-integers', () => {
    for (const answer of [
      'no candidates',
      '{"result":[]}',
      '{"matches":[4]}',
      '{"matches":["x"]}',
      '{"matches":[1.5]}',
      '{"matches":"1"}',
    ]) {
      const result = parseAnswer(answer, items);
      expect(!result.ok).toBe(true);
    }
  });

  it('keeps a bounded retry budget', () => {
    // The owner's decision: one attempt plus two retries.
    expect(ANSWER_MAX_ATTEMPTS).toBe(3);
  });
});
