import { describe, expect, it } from 'vitest';
import {
  createToolError,
  newRequestId,
  renderToolFailureForModel,
  SIGN_IN_DIRECTIVE,
} from '../../../../../src/shared';

const requestId = newRequestId(() => 'req-1');

describe('renderToolFailureForModel - sign-in directive', () => {
  it('tells the model to stop when the failure needs a sign-in', () => {
    const rendered = renderToolFailureForModel(
      createToolError('REDIRECT_BLOCKED', 'Redirected', requestId),
    );

    expect(rendered).toContain(SIGN_IN_DIRECTIVE);
  });

  it('adds nothing to a failure that needs no sign-in', () => {
    const rendered = renderToolFailureForModel(createToolError('NOT_FOUND', 'Missing', requestId));

    expect(rendered).not.toContain(SIGN_IN_DIRECTIVE);
  });
});
