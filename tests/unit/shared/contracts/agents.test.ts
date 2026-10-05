import { describe, expect, it } from 'vitest';
import {
  agentDefinition,
  isAgentEligible,
  isKnownAgentId,
  resolveConfiguredAgentId,
  resolveEffectiveActiveAgentId,
  type AgentDefinition,
  type AgentId,
} from '../../../../src/shared';
import {
  TEST_AGENT_DEFINITION,
  TEST_AGENT_DEFINITIONS,
  TEST_AGENT_ID,
} from '../../../support/agentDefinitions';

const OPENCODE: AgentDefinition = {
  id: 'opencode' as AgentId,
  label: 'OpenCode',
  requiresAuth: false,
  supportsInteractiveLogin: false,
};

describe('agent definitions', () => {
  it('finds a definition by id', () => {
    const copilot = agentDefinition(TEST_AGENT_ID, TEST_AGENT_DEFINITIONS);
    expect(copilot).toBe(TEST_AGENT_DEFINITION);
    expect(copilot?.requiresAuth).toBe(true);
  });

  it('returns undefined for a provider this build does not know', () => {
    expect(agentDefinition('not-shipped' as AgentId, TEST_AGENT_DEFINITIONS)).toBeUndefined();
  });

  it('reports known ids honestly, and none when no agent is built', () => {
    for (const definition of TEST_AGENT_DEFINITIONS) {
      expect(isKnownAgentId(definition.id, TEST_AGENT_DEFINITIONS)).toBe(true);
    }
    expect(isKnownAgentId('not-shipped', TEST_AGENT_DEFINITIONS)).toBe(false);
    expect(isKnownAgentId(TEST_AGENT_ID, [])).toBe(false);
  });
});

describe('resolveConfiguredAgentId', () => {
  const both = [TEST_AGENT_DEFINITION, OPENCODE];

  it('returns the known entry whose active flag is set', () => {
    expect(
      resolveConfiguredAgentId(
        { [TEST_AGENT_ID]: { active: false }, opencode: { active: true } },
        both,
      ),
    ).toBe('opencode');
  });

  it('ignores an active entry this build does not contain', () => {
    expect(resolveConfiguredAgentId({ opencode: { active: true } }, TEST_AGENT_DEFINITIONS)).toBe(
      TEST_AGENT_ID,
    );
  });

  it('falls back to the first definition when none is active or the map is empty', () => {
    expect(resolveConfiguredAgentId({}, both)).toBe(TEST_AGENT_ID);
    expect(resolveConfiguredAgentId({ [TEST_AGENT_ID]: { active: false } }, both)).toBe(
      TEST_AGENT_ID,
    );
  });

  it('is undefined when the build contains no agent', () => {
    expect(resolveConfiguredAgentId({ [TEST_AGENT_ID]: { active: true } }, [])).toBeUndefined();
  });
});

describe('isAgentEligible', () => {
  const needsAuth: AgentDefinition = {
    id: 'copilot' as AgentId,
    label: 'GitHub Copilot',
    requiresAuth: true,
    supportsInteractiveLogin: true,
  };
  const noAuth: AgentDefinition = {
    id: 'local' as AgentId,
    label: 'Local',
    requiresAuth: false,
    supportsInteractiveLogin: false,
  };

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
    supportsInteractiveLogin: true,
  };
  const local: AgentDefinition = {
    id: 'local' as AgentId,
    label: 'Local',
    requiresAuth: false,
    supportsInteractiveLogin: false,
  };
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
