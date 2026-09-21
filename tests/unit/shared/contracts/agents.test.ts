import { describe, expect, it } from 'vitest';
import {
  AGENT_DEFINITIONS,
  agentDefinition,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_AGENT_ID,
  isAgentEligible,
  isKnownAgentId,
  resolveConfiguredAgentId,
  resolveEffectiveActiveAgentId,
  type AgentDefinition,
  type AgentId,
} from '../../../../src/shared';

describe('agent registry', () => {
  it('describes GitHub Copilot as needing authentication', () => {
    const copilot = agentDefinition(DEFAULT_AGENT_ID);
    expect(copilot).toBeDefined();
    expect(copilot?.requiresAuth).toBe(true);
  });

  it('exposes the same object the configured-agent default names', () => {
    expect(DEFAULT_AGENT_DEFINITION).toBe(agentDefinition(DEFAULT_AGENT_ID));
  });

  it('returns undefined for a provider this build does not know', () => {
    expect(agentDefinition('not-shipped' as AgentId)).toBeUndefined();
  });

  it('reports known ids honestly', () => {
    for (const definition of AGENT_DEFINITIONS) {
      expect(isKnownAgentId(definition.id)).toBe(true);
    }
    expect(isKnownAgentId('not-shipped')).toBe(false);
  });
});

describe('resolveConfiguredAgentId', () => {
  it('returns the entry whose active flag is set', () => {
    expect(
      resolveConfiguredAgentId({
        [DEFAULT_AGENT_ID]: { active: false },
        opencode: { active: true },
      }),
    ).toBe('opencode');
  });

  it('falls back to the default provider when none is active or the map is empty', () => {
    expect(resolveConfiguredAgentId({})).toBe(DEFAULT_AGENT_ID);
    expect(resolveConfiguredAgentId({ [DEFAULT_AGENT_ID]: { active: false } })).toBe(
      DEFAULT_AGENT_ID,
    );
  });
});

describe('isAgentEligible', () => {
  const needsAuth: AgentDefinition = {
    id: 'copilot' as AgentId,
    label: 'GitHub Copilot',
    requiresAuth: true,
  };
  const noAuth: AgentDefinition = { id: 'local' as AgentId, label: 'Local', requiresAuth: false };

  it('is false while a provider that needs auth is signed out, or its status is unknown', () => {
    expect(isAgentEligible(needsAuth, { isAuthenticated: false })).toBe(false);
    expect(isAgentEligible(needsAuth, undefined)).toBe(false);
  });

  it('is true once a provider that needs auth is signed in', () => {
    expect(isAgentEligible(needsAuth, { isAuthenticated: true })).toBe(true);
  });

  it('is true once a personal-access token is stored, even while signed out', () => {
    expect(isAgentEligible(needsAuth, { isAuthenticated: false, hasToken: true })).toBe(true);
  });

  it('is false when a provider that needs auth is signed out and holds no token', () => {
    expect(isAgentEligible(needsAuth, { isAuthenticated: false, hasToken: false })).toBe(false);
  });

  it('is true for a provider that needs no auth, whatever the auth status says', () => {
    expect(isAgentEligible(noAuth, undefined)).toBe(true);
    expect(isAgentEligible(noAuth, { isAuthenticated: false })).toBe(true);
  });
});

describe('resolveEffectiveActiveAgentId', () => {
  const copilot: AgentDefinition = {
    id: 'copilot' as AgentId,
    label: 'GitHub Copilot',
    requiresAuth: true,
  };
  const local: AgentDefinition = { id: 'local' as AgentId, label: 'Local', requiresAuth: false };
  const signedOut = (): { isAuthenticated: boolean } | undefined => ({ isAuthenticated: false });
  const signedIn = (): { isAuthenticated: boolean } | undefined => ({ isAuthenticated: true });

  it('honours the configured provider when it is eligible', () => {
    expect(
      resolveEffectiveActiveAgentId([copilot, local], { local: { active: true } }, () =>
        signedIn(),
      ),
    ).toBe('local');
  });

  it('auto-activates the first eligible provider when none is configured', () => {
    expect(
      resolveEffectiveActiveAgentId([copilot, local], {}, (id) =>
        id === 'copilot' ? signedOut() : undefined,
      ),
    ).toBe('local');
  });

  it('falls through a configured provider whose criterion is unmet', () => {
    expect(
      resolveEffectiveActiveAgentId([copilot, local], { copilot: { active: true } }, (id) =>
        id === 'copilot' ? signedOut() : undefined,
      ),
    ).toBe('local');
  });

  it('returns undefined when no provider is eligible', () => {
    expect(
      resolveEffectiveActiveAgentId([copilot], { copilot: { active: true } }, () => signedOut()),
    ).toBeUndefined();
    expect(resolveEffectiveActiveAgentId([copilot], {}, () => undefined)).toBeUndefined();
  });

  it('treats a stored token as eligibility while signed out', () => {
    expect(
      resolveEffectiveActiveAgentId([copilot], { copilot: { active: true } }, () => ({
        isAuthenticated: false,
        hasToken: true,
      })),
    ).toBe('copilot');
  });

  it('keeps registration order among eligible fallbacks', () => {
    expect(resolveEffectiveActiveAgentId([copilot, local], {}, () => signedIn())).toBe('copilot');
  });
});
