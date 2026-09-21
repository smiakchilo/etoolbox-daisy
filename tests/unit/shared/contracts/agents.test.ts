import { describe, expect, it } from 'vitest';
import {
  AGENT_DEFINITIONS,
  agentDefinition,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_AGENT_ID,
  isAgentActive,
  isKnownAgentId,
  resolveActiveAgentId,
  type AgentDefinition,
  type AgentId,
} from '../../../../src/shared';

describe('agent registry', () => {
  it('describes GitHub Copilot as needing authentication', () => {
    const copilot = agentDefinition(DEFAULT_AGENT_ID);
    expect(copilot).toBeDefined();
    expect(copilot?.requiresAuth).toBe(true);
  });

  it('exposes the same object the active-agent default names', () => {
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

describe('resolveActiveAgentId', () => {
  it('returns the entry whose active flag is set', () => {
    expect(
      resolveActiveAgentId({
        [DEFAULT_AGENT_ID]: { active: false },
        opencode: { active: true },
      }),
    ).toBe('opencode');
  });

  it('falls back to the default provider when none is active or the map is empty', () => {
    expect(resolveActiveAgentId({})).toBe(DEFAULT_AGENT_ID);
    expect(resolveActiveAgentId({ [DEFAULT_AGENT_ID]: { active: false } })).toBe(DEFAULT_AGENT_ID);
  });
});

describe('isAgentActive', () => {
  const needsAuth: AgentDefinition = {
    id: 'copilot' as AgentId,
    label: 'GitHub Copilot',
    requiresAuth: true,
  };
  const noAuth: AgentDefinition = { id: 'local' as AgentId, label: 'Local', requiresAuth: false };

  it('is false while a provider that needs auth is signed out, or its status is unknown', () => {
    expect(isAgentActive(needsAuth, { isAuthenticated: false })).toBe(false);
    expect(isAgentActive(needsAuth, undefined)).toBe(false);
  });

  it('is true once a provider that needs auth is signed in', () => {
    expect(isAgentActive(needsAuth, { isAuthenticated: true })).toBe(true);
  });

  it('is true for a provider that needs no auth, whatever the auth status says', () => {
    expect(isAgentActive(noAuth, undefined)).toBe(true);
    expect(isAgentActive(noAuth, { isAuthenticated: false })).toBe(true);
  });
});
