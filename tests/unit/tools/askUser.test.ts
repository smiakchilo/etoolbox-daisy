import { describe, expect, it } from 'vitest';
import {
  askUserArgsSchema,
  createAskUserExecutor,
  renderAskUserSuccess,
} from '../../../src/tools/ask-user/askUser';
import { renderer } from '../../../src/tools/ask-user/renderer';
import { type ToolHost, type UserInputAnswer, type UserInputRequest } from '../../../src/shared';
import { createCountingIdGenerator } from '../../support/testIds';

function makeHost(
  answer: UserInputAnswer,
  capture?: (request: UserInputRequest) => void,
): ToolHost {
  const ids = createCountingIdGenerator('ask');
  return {
    bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
    currentContext: () => {
      throw new Error('ask_user must never ask for an AEM context');
    },
    environmentFacts: () => undefined,
    requestUserInput: (request) => {
      capture?.(request);
      return Promise.resolve(answer);
    },
    clock: () => 1,
    idGenerator: ids,
  };
}

const callContext = { toolCallId: 'call-1' as never, signal: undefined };

describe('askUserArgsSchema', () => {
  it('defaults multiple and freeInput to false', () => {
    const parsed = askUserArgsSchema.parse({ question: 'Pick one', options: ['a', 'b'] });
    expect(parsed.multiple).toBe(false);
    expect(parsed.freeInput).toBe(false);
  });
});

describe('createAskUserExecutor', () => {
  it('normalizes the request and returns the user answer in the payload', async () => {
    let captured: UserInputRequest | undefined;
    const host = makeHost({ selections: ['Red'], freeform: null }, (request) => {
      captured = request;
    });
    const executor = createAskUserExecutor(host);

    const result = await executor(
      { question: 'Pick a colour', options: ['Red', 'Green'], multiple: false, freeInput: false },
      callContext,
    );

    expect(captured).toEqual({
      question: 'Pick a colour',
      options: ['Red', 'Green'],
      multiple: false,
      freeInput: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const payload = result.value as Readonly<Record<string, unknown>>;
      expect(payload['operation']).toBe('ask_user');
      expect(payload['selections']).toEqual(['Red']);
      expect(payload['freeform']).toBeNull();
      expect(typeof payload['textResultForLlm']).toBe('string');
    }
  });

  it('omits options for a free-input-only question', async () => {
    let captured: UserInputRequest | undefined;
    const host = makeHost({ selections: [], freeform: 'typed' }, (request) => {
      captured = request;
    });
    await createAskUserExecutor(host)({ question: 'Say something', freeInput: true }, callContext);
    expect(captured).toEqual({ question: 'Say something', multiple: false, freeInput: true });
  });

  it('refuses a call with neither options nor freeInput', async () => {
    const host = makeHost({ selections: [], freeform: null });
    const result = await createAskUserExecutor(host)({ question: 'Hmm' }, callContext);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('maps a cancelled question to a CANCELLED failure rather than throwing', async () => {
    const ids = createCountingIdGenerator('ask');
    const host: ToolHost = {
      ...makeHost({ selections: [], freeform: null }),
      requestUserInput: () => Promise.reject(new Error('The question was cancelled')),
      idGenerator: ids,
    };
    const result = await createAskUserExecutor(host)(
      { question: 'Pick', options: ['a'] },
      callContext,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CANCELLED');
  });

  it('honours an already-aborted signal without asking', async () => {
    let asked = false;
    const host = makeHost({ selections: [], freeform: null }, () => {
      asked = true;
    });
    const controller = new AbortController();
    controller.abort();
    const result = await createAskUserExecutor(host)(
      { question: 'Pick', options: ['a'] },
      { toolCallId: 'call-1' as never, signal: controller.signal },
    );
    expect(asked).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CANCELLED');
  });

  it('builds an actions request with no options and no question', async () => {
    let captured: UserInputRequest | undefined;
    const host = makeHost({ selections: ['Load more'], freeform: null }, (request) => {
      captured = request;
    });
    const result = await createAskUserExecutor(host)({ actions: ['Load more'] }, callContext);
    expect(captured).toEqual({ actions: ['Load more'], multiple: false, freeInput: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const payload = result.value as Readonly<Record<string, unknown>>;
      expect(payload['selections']).toEqual(['Load more']);
      expect(payload['question']).toBeUndefined();
    }
  });

  it('rejects actions combined with options or freeInput', async () => {
    const host = makeHost({ selections: [], freeform: null });
    const withOptions = await createAskUserExecutor(host)(
      { actions: ['a'], options: ['b'] },
      callContext,
    );
    expect(withOptions.ok).toBe(false);
    const withFree = await createAskUserExecutor(host)(
      { actions: ['a'], freeInput: true },
      callContext,
    );
    expect(withFree.ok).toBe(false);
  });

  it('rejects actions with multiple (they are single-click)', async () => {
    const host = makeHost({ selections: [], freeform: null });
    const result = await createAskUserExecutor(host)(
      { actions: ['a'], multiple: true },
      callContext,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('renderAskUserSuccess', () => {
  it('renders a single choice, a multiple choice, and free text', () => {
    const base = {
      ok: true as const,
      operation: 'ask_user' as const,
      requestId: 'r' as never,
      question: 'Q',
    };
    expect(renderAskUserSuccess({ ...base, selections: ['A'], freeform: null })).toBe(
      'The user chose: A',
    );
    expect(renderAskUserSuccess({ ...base, selections: ['A', 'B'], freeform: null })).toBe(
      'The user chose: A, B',
    );
    expect(renderAskUserSuccess({ ...base, selections: [], freeform: 'typed' })).toBe(
      'The user answered: typed',
    );
  });
});

describe('ask_user transcript composition', () => {
  it('is presented as a conversation, never a billet', () => {
    expect(renderer.presentation).toBe('conversation');
    expect(renderer.readConversation).toBeTypeOf('function');
  });

  it('shows the question with no answer while pending', () => {
    const item = renderer.readConversation?.({ question: 'Pick a colour', options: ['Red'] });
    expect(item).toEqual({ question: 'Pick a colour', answer: undefined });
  });

  it('reads the answer from the succeeded payload', () => {
    const data = { operation: 'ask_user', selections: ['Red', 'Green'], freeform: null };
    expect(renderer.readConversation?.({ question: 'Pick' }, data)).toEqual({
      question: 'Pick',
      answer: 'Red, Green',
    });
    expect(
      renderer.readConversation?.(
        { question: 'Pick' },
        { operation: 'ask_user', selections: [], freeform: 'typed' },
      ),
    ).toEqual({ question: 'Pick', answer: 'typed' });
  });

  it('returns undefined when the call shape is unrecognised', () => {
    expect(renderer.readConversation?.({})).toBeUndefined();
  });

  it('renders nothing for an actions-only call (the buttons are the interface)', () => {
    expect(renderer.readConversation?.({ actions: ['Load more'] })).toBeUndefined();
  });

  it('still composes a describeCall fallback (never displayed)', () => {
    const details = renderer.describeCall({ question: 'Pick', options: ['A', 'B'] });
    expect(details.summary).toBe('Pick');
    expect(details.parameters).toEqual([
      { label: 'Question', value: 'Pick' },
      { label: 'Options', value: 'A, B' },
    ]);
  });
});
