import { describe, expect, it, vi } from 'vitest';
import { addonPins } from '../../../../src/shared';
import {
  createHardenedSession,
  denyAllPermissions,
  allowlistedToolPermissions,
  resumeHardenedSession,
  type HardenedSessionClient,
  type HardenedToolPolicy,
} from '../../../../src/agents/copilot/toolPolicy';

// Derived structurally from `HardenedSessionClient` instead of importing
// `CopilotSession`/`SessionUpdateOptionsResult` from `@github/copilot-sdk`
// directly - only `src/agent` is allowed to import the SDK package (see the
// `no-restricted-imports` ESLint rule), including type-only imports.
type FakeSession = Awaited<ReturnType<HardenedSessionClient['createSession']>>;
type UpdateOptionsResult = Awaited<ReturnType<FakeSession['rpc']['options']['update']>>;

function makeFakeSession(
  update = vi.fn<(params: unknown) => Promise<UpdateOptionsResult>>(() =>
    Promise.resolve({ success: true } as UpdateOptionsResult),
  ),
): FakeSession {
  return {
    sessionId: 'fake-session-id',
    rpc: { options: { update } },
  } as unknown as FakeSession;
}

function makeFakeClient(session: FakeSession): {
  client: HardenedSessionClient;
  createSession: ReturnType<typeof vi.fn<HardenedSessionClient['createSession']>>;
  resumeSession: ReturnType<typeof vi.fn<HardenedSessionClient['resumeSession']>>;
} {
  const createSession = vi.fn<HardenedSessionClient['createSession']>(() =>
    Promise.resolve(session),
  );
  const resumeSession = vi.fn<HardenedSessionClient['resumeSession']>(() =>
    Promise.resolve(session),
  );
  return { client: { createSession, resumeSession }, createSession, resumeSession };
}

describe('denyAllPermissions', () => {
  it('rejects every permission request', () => {
    const handler = denyAllPermissions();
    const result = handler(
      // The handler ignores its arguments entirely, so any shape is fine here.
      {} as never,
      {} as never,
    );
    expect(result).toEqual({
      kind: 'reject',
      feedback: expect.stringContaining('hardened tool policy') as string,
    });
  });
});

describe('a tool an add-on contributes', () => {
  it('is approved from its pins allowlist entry, by bare name and by source-qualified name', () => {
    const tool = Object.values(addonPins)
      .flatMap((pin) => pin.contributions.tools)
      .at(0);
    // A build with no pinned add-on has nothing to admit.
    if (tool === undefined) return;
    const ask = allowlistedToolPermissions({ availableTools: [tool.allowlistEntry] });

    for (const toolName of [tool.name, tool.allowlistEntry]) {
      expect(ask({ kind: 'custom-tool', toolName, toolDescription: '' }, {} as never)).toEqual({
        kind: 'approve-once',
      });
    }
  });
});

describe('allowlistedToolPermissions', () => {
  const policy: HardenedToolPolicy = { availableTools: ['custom:aem_get_json'] };

  function ask(request: unknown): unknown {
    return allowlistedToolPermissions(policy)(request as never, {} as never);
  }

  it('approves an allowlisted custom tool, matching a bare name against a source-qualified entry', () => {
    expect(ask({ kind: 'custom-tool', toolName: 'aem_get_json', toolDescription: '' })).toEqual({
      kind: 'approve-once',
    });
  });

  it('approves only once, never for the session or permanently', () => {
    const result = ask({ kind: 'custom-tool', toolName: 'aem_get_json', toolDescription: '' }) as {
      kind: string;
    };
    // `approve-for-session`/`-for-location`/`-permanently` would let the
    // runtime remember a decision we intend to re-make from the in-memory
    // policy on every single call.
    expect(result.kind).toBe('approve-once');
  });

  it('rejects a custom tool that is not on the allowlist', () => {
    expect(ask({ kind: 'custom-tool', toolName: 'shell_exec', toolDescription: '' })).toEqual({
      kind: 'reject',
      feedback: expect.stringContaining('hardened tool policy') as string,
    });
  });

  it('rejects non-tool permission kinds even when the allowlist is non-empty', () => {
    for (const kind of ['shell', 'write', 'read', 'mcp', 'url', 'memory', 'hook']) {
      expect(ask({ kind, toolName: 'aem_get_json' })).toEqual({
        kind: 'reject',
        feedback: expect.stringContaining('hardened tool policy') as string,
      });
    }
  });

  it('rejects everything when the allowlist is empty', () => {
    const handler = allowlistedToolPermissions({ availableTools: [] });
    expect(
      handler(
        { kind: 'custom-tool', toolName: 'aem_get_json', toolDescription: '' } as never,
        {} as never,
      ),
    ).toEqual({
      kind: 'reject',
      feedback: expect.stringContaining('hardened tool policy') as string,
    });
  });
});

describe('createHardenedSession', () => {
  it('throws when availableTools is not supplied at all', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());
    await expect(
      createHardenedSession(client, {} as unknown as HardenedToolPolicy),
    ).rejects.toThrow(/explicit.*availableTools/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('accepts an explicit empty array as a valid deny-everything policy', async () => {
    const session = makeFakeSession();
    const { client, createSession } = makeFakeClient(session);
    const policy: HardenedToolPolicy = { availableTools: [] };

    await expect(createHardenedSession(client, policy)).resolves.toBe(session);

    expect(createSession).toHaveBeenCalledTimes(1);
    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['availableTools']).toEqual([]);
    expect(config['enableSessionTelemetry']).toBe(false);
    expect(config['enableSkills']).toBe(false);
    expect(config['mcpServers']).toEqual({});
    expect(config['onPermissionRequest']).toBeTypeOf('function');
    expect(config['systemMessage']).toEqual({
      mode: 'customize',
      sections: { environment_context: { action: 'remove' } },
    });
  });

  it("disables the SDK's large-output temp-file diversion", async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(client, { availableTools: [] });

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    // The SDK default is `{ enabled: true, maxSizeBytes: 51200 }`, which writes
    // an oversized tool result to a file in the OS temp directory instead of
    // rejecting it - spilling private AEM content onto disk with no error.
    expect(config['largeOutput']).toEqual({ enabled: false });
  });

  it('does not let caller overrides re-enable large-output diversion', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(
      client,
      { availableTools: [] },
      // `largeOutput` is also `Omit`ted from `HardenedSessionOverrides`, so
      // this does not type-check without the cast; the cast is what lets the
      // test prove the *runtime* precedence too, not just the type-level one.
      { largeOutput: { enabled: true, maxSizeBytes: 51200 } } as never,
    );

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['largeOutput']).toEqual({ enabled: false });
  });

  it('wires the allowlist-driven permission handler into the session config', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(client, { availableTools: ['custom:aem_get_json'] });

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    const handler = config['onPermissionRequest'] as (a: unknown, b: unknown) => unknown;
    // Without this, an allowlisted tool is refused on every live call - the
    // deterministic fake never raises a permission request, so nothing else
    // in the suite would notice.
    expect(
      handler({ kind: 'custom-tool', toolName: 'aem_get_json', toolDescription: '' }, {}),
    ).toEqual({ kind: 'approve-once' });
    expect(
      handler({ kind: 'custom-tool', toolName: 'something_else', toolDescription: '' }, {}),
    ).toEqual({
      kind: 'reject',
      feedback: expect.stringContaining('hardened tool policy') as string,
    });
  });

  it('suppresses sub-agent streaming deltas', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(client, { availableTools: [] });

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['includeSubAgentStreamingEvents']).toBe(false);
  });

  it('does not let caller overrides re-enable sub-agent streaming deltas', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(client, { availableTools: [] }, {
      includeSubAgentStreamingEvents: true,
    } as never);

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['includeSubAgentStreamingEvents']).toBe(false);
  });

  it('leaves streaming to the caller, since it is a functional need and not a hardening concern', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(client, { availableTools: [] }, { streaming: true });

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['streaming']).toBe(true);
  });

  it('appends policy instructions to the system message without dropping the section strip', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(client, {
      availableTools: [],
      instructions: '  You are a read-only AEM assistant.  ',
    });

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['systemMessage']).toEqual({
      mode: 'customize',
      sections: { environment_context: { action: 'remove' } },
      content: 'You are a read-only AEM assistant.',
    });
  });

  it('omits systemMessage.content entirely when no instructions are supplied', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(client, { availableTools: [], instructions: '   ' });

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    // Under `exactOptionalPropertyTypes` the key must be absent, not
    // `undefined`, so assert on key presence rather than on the value.
    expect(Object.hasOwn(config['systemMessage'] as object, 'content')).toBe(false);
  });

  it('applies the post-create options patch (including installedPlugins) after creation', async () => {
    const update = vi.fn<(params: unknown) => Promise<UpdateOptionsResult>>(() =>
      Promise.resolve({ success: true } as UpdateOptionsResult),
    );
    const { client } = makeFakeClient(makeFakeSession(update));

    await createHardenedSession(client, { availableTools: ['builtin:read'] });

    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch['installedPlugins']).toEqual([]);
    expect(patch['skipCustomInstructions']).toBe(true);
    expect(patch['customAgentsLocalOnly']).toBe(true);
  });

  it('throws when the post-create options patch reports failure', async () => {
    const update = vi.fn<(params: unknown) => Promise<UpdateOptionsResult>>(() =>
      Promise.resolve({ success: false } as UpdateOptionsResult),
    );
    const { client } = makeFakeClient(makeFakeSession(update));

    await expect(createHardenedSession(client, { availableTools: [] })).rejects.toThrow(
      /failed to apply hardened post-create session options/i,
    );
  });

  it('passes excludedTools through only when explicitly supplied', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(client, { availableTools: [], excludedTools: ['builtin:bash'] });
    const configWith = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(configWith['excludedTools']).toEqual(['builtin:bash']);

    createSession.mockClear();
    await createHardenedSession(client, { availableTools: [] });
    const configWithout = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('excludedTools' in configWithout).toBe(false);
  });
});

describe('resumeHardenedSession', () => {
  it('throws when availableTools is not supplied at all', async () => {
    const { client, resumeSession } = makeFakeClient(makeFakeSession());
    await expect(
      resumeHardenedSession(client, 'some-session-id', {} as unknown as HardenedToolPolicy),
    ).rejects.toThrow(/explicit.*availableTools/i);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('re-applies the same hardening on resume (ResumeSessionConfig is not persisted)', async () => {
    const update = vi.fn<(params: unknown) => Promise<UpdateOptionsResult>>(() =>
      Promise.resolve({ success: true } as UpdateOptionsResult),
    );
    const { client, resumeSession } = makeFakeClient(makeFakeSession(update));

    await resumeHardenedSession(client, 'some-session-id', { availableTools: [] });

    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    const config = resumeSession.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(config['availableTools']).toEqual([]);
    expect(config['enableSkills']).toBe(false);
  });
});

describe('runtime skills', () => {
  it('keeps the runtime-owned skills off and discovers none', async () => {
    const { client, createSession } = makeFakeClient(makeFakeSession());

    await createHardenedSession(client, { availableTools: [] });

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['enableSkills']).toBe(false);
    expect(config['skillDirectories']).toBeUndefined();
    expect(config['enableConfigDiscovery']).toBe(false);
  });
});
