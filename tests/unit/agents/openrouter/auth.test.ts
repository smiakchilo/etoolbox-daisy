import { describe, expect, it } from 'vitest';
import { authPresenceFromToken, authStatusFromToken } from '../../../../src/agents/openrouter/auth';

describe('OpenRouter auth projection', () => {
  it('reports authenticated with a type token when a key is stored', () => {
    expect(authStatusFromToken('sk-or-v1-key')).toMatchObject({
      apiVersion: 1,
      isAuthenticated: true,
      authType: 'token',
    });
  });

  it('reports signed out for an absent or empty key (the store may yield "")', () => {
    for (const token of [undefined, '']) {
      const status = authStatusFromToken(token);
      expect(status.isAuthenticated).toBe(false);
      expect(status.statusMessage).toBeDefined();
    }
  });

  it('mirrors the token into the cheap presence probe', () => {
    expect(authPresenceFromToken('k')).toEqual({ present: true });
    expect(authPresenceFromToken(undefined)).toEqual({ present: false });
    expect(authPresenceFromToken('')).toEqual({ present: false });
  });
});
