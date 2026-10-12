import { describe, expect, it } from 'vitest';
import { createModelObserver } from '../../../../src/shared';

describe('createModelObserver', () => {
  it('reports the first model as session-open, without previous values', () => {
    const observer = createModelObserver();
    const body = observer.observe({ model: 'a', reasoningEffort: 'low' });
    expect(body).toEqual({
      type: 'model.changed',
      model: 'a',
      reasoningEffort: 'low',
      cause: 'session-open',
    });
  });

  it('stays silent while the model and effort are unchanged', () => {
    const observer = createModelObserver();
    observer.observe({ model: 'a', reasoningEffort: 'low' });
    expect(observer.observe({ model: 'a', reasoningEffort: 'low' })).toBeUndefined();
  });

  it('reports a model change as preference-change with the previous values', () => {
    const observer = createModelObserver();
    observer.observe({ model: 'a', reasoningEffort: 'low' });
    expect(observer.observe({ model: 'b' })).toEqual({
      type: 'model.changed',
      model: 'b',
      previousModel: 'a',
      previousReasoningEffort: 'low',
      cause: 'preference-change',
    });
  });

  it('reports an effort-only change, including dropping the effort', () => {
    const observer = createModelObserver();
    observer.observe({ model: 'a', reasoningEffort: 'low' });
    expect(observer.observe({ model: 'a', reasoningEffort: 'high' })).toMatchObject({
      reasoningEffort: 'high',
      previousReasoningEffort: 'low',
    });
    const dropped = observer.observe({ model: 'a' });
    expect(dropped).toMatchObject({ previousReasoningEffort: 'high' });
    expect(dropped).not.toHaveProperty('reasoningEffort');
  });

  it('remembers a runtime-announced model so the same preference is not re-reported', () => {
    const observer = createModelObserver();
    observer.record({ model: 'b' });
    expect(observer.observe({ model: 'b' })).toBeUndefined();
    expect(observer.observe({ model: 'c' })).toMatchObject({ previousModel: 'b' });
  });

  it('forgets everything on reset, so the next report is session-open again', () => {
    const observer = createModelObserver();
    observer.observe({ model: 'a' });
    observer.reset();
    expect(observer.observe({ model: 'a' })).toMatchObject({ cause: 'session-open' });
  });
});
