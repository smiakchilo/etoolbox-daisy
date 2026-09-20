import { describe, expect, it, vi } from 'vitest';

interface CapturedConnectionOptions {
  readonly path: string;
}

interface CapturedClientOptions {
  readonly connection: unknown;
  readonly baseDirectory: string;
  readonly env: Record<string, string | undefined>;
  readonly logLevel: string;
}

const constructorCalls: CapturedClientOptions[] = [];
const forStdioCalls: CapturedConnectionOptions[] = [];

vi.mock('@github/copilot-sdk', () => {
  return {
    CopilotClient: class {
      constructor(options: CapturedClientOptions) {
        constructorCalls.push(options);
      }
    },
    RuntimeConnection: {
      forStdio: (options: CapturedConnectionOptions) => {
        forStdioCalls.push(options);
        return { kind: 'fake-stdio-connection' };
      },
    },
  };
});

// Imported after the mock so the mocked module is what copilotClient.ts sees.
const { buildRuntimeChildEnv, createHardenedCopilotClient, toAuthStatus } =
  await import('../../../src/agent/copilotClient');
const { parseAuthStatus } = await import('../../../src/shared/agent-auth');

describe('toAuthStatus', () => {
  it('adds the apiVersion the raw SDK auth response does not carry', () => {
    // Regression: the composition root used to hand the bare CopilotClient to
    // the adapter as its auth source, whose getAuthStatus() returns the SDK's
    // raw `{ isAuthenticated }` with no apiVersion. parseAuthStatus then threw
    // `expected 1` at path ["apiVersion"] on every real initialize().
    const raw = { isAuthenticated: false };
    expect(toAuthStatus(raw)).toEqual({ apiVersion: 1, isAuthenticated: false });
  });

  it('produces a value the IPC-facing schema accepts', () => {
    const projected = toAuthStatus({
      isAuthenticated: true,
      authType: 'user',
      host: 'github.com',
      login: 'octocat',
      statusMessage: 'Signed in',
    });
    expect(parseAuthStatus(projected)).toEqual(projected);
  });

  it('omits absent optional fields rather than setting them to undefined', () => {
    const projected = toAuthStatus({ isAuthenticated: true });
    expect(Object.keys(projected).sort()).toEqual(['apiVersion', 'isAuthenticated']);
  });
});

describe('buildRuntimeChildEnv', () => {
  it('spreads the base environment first (never starts from an empty object)', () => {
    const base = { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' };
    const env = buildRuntimeChildEnv(base);
    expect(env['PATH']).toBe('C:\\Windows');
    expect(env['SystemRoot']).toBe('C:\\Windows');
  });

  it('does not mutate the base environment object it was given', () => {
    const base = { PATH: 'C:\\Windows' };
    buildRuntimeChildEnv(base, { httpsProxy: 'https://proxy.example' });
    expect(base).toEqual({ PATH: 'C:\\Windows' });
  });

  it('layers proxy overrides on top only for keys actually supplied', () => {
    const base = { PATH: 'C:\\Windows' };
    const env = buildRuntimeChildEnv(base, {
      httpsProxy: 'https://proxy.example:8080',
      noProxy: 'localhost',
    });
    expect(env['HTTPS_PROXY']).toBe('https://proxy.example:8080');
    expect(env['NO_PROXY']).toBe('localhost');
    expect(env['HTTP_PROXY']).toBeUndefined();
    expect(env['NODE_EXTRA_CA_CERTS']).toBeUndefined();
  });

  it('applies no proxy overrides when none are supplied', () => {
    const base = { PATH: 'C:\\Windows' };
    const env = buildRuntimeChildEnv(base);
    expect(env).toEqual(base);
  });
});

describe('createHardenedCopilotClient', () => {
  it('passes only an explicit path to RuntimeConnection.forStdio, never env', () => {
    constructorCalls.length = 0;
    forStdioCalls.length = 0;

    createHardenedCopilotClient({
      runtimeExePath: 'C:\\fake\\copilot-runtime.exe',
      copilotHomeDir: 'C:\\fake\\copilot-home',
      baseEnv: { PATH: 'C:\\Windows' },
    });

    expect(forStdioCalls).toHaveLength(1);
    expect(forStdioCalls[0]).toEqual({ path: 'C:\\fake\\copilot-runtime.exe' });
    expect(Object.keys(forStdioCalls[0] as object)).not.toContain('env');
  });

  it('sets baseDirectory to the app-owned COPILOT_HOME and never sets mode', () => {
    constructorCalls.length = 0;
    forStdioCalls.length = 0;

    createHardenedCopilotClient({
      runtimeExePath: 'C:\\fake\\copilot-runtime.exe',
      copilotHomeDir: 'C:\\fake\\copilot-home',
      baseEnv: { PATH: 'C:\\Windows' },
    });

    expect(constructorCalls).toHaveLength(1);
    const options = constructorCalls[0] as unknown as Record<string, unknown>;
    expect(options['baseDirectory']).toBe('C:\\fake\\copilot-home');
    expect(options).not.toHaveProperty('mode');
  });

  it('builds the client-level env by spreading baseEnv (PATH survives)', () => {
    constructorCalls.length = 0;
    forStdioCalls.length = 0;

    createHardenedCopilotClient({
      runtimeExePath: 'C:\\fake\\copilot-runtime.exe',
      copilotHomeDir: 'C:\\fake\\copilot-home',
      baseEnv: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
    });

    const options = constructorCalls[0] as CapturedClientOptions;
    expect(options.env['PATH']).toBe('C:\\Windows');
    expect(options.env['SystemRoot']).toBe('C:\\Windows');
  });
});

describe('ambient credential isolation', () => {
  it('strips ambient GH_TOKEN/GITHUB_TOKEN/COPILOT_GITHUB_TOKEN from the child env', () => {
    // Regression: an installed build reported authType "env" / "(via GH_TOKEN)"
    // and was authenticated as an account it had never signed into, because the
    // developer's ambient token was inherited by the runtime child. That is the
    // hidden credential fallback step 02 forbids, and it makes logout meaningless.
    const env = buildRuntimeChildEnv({
      PATH: 'C:\\Windows',
      GH_TOKEN: 'gho_ambient',
      GITHUB_TOKEN: 'gho_ambient2',
      COPILOT_GITHUB_TOKEN: 'gho_ambient3',
    });

    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['COPILOT_GITHUB_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBe('C:\\Windows');
  });

  it('honours an explicitly supplied token and lets it win over an ambient one', () => {
    const env = buildRuntimeChildEnv({ GH_TOKEN: 'gho_ambient' }, {}, 'gho_explicit');
    expect(env['COPILOT_GITHUB_TOKEN']).toBe('gho_explicit');
    expect(env['GH_TOKEN']).toBeUndefined();
  });

  it("treats an empty explicit token as 'not supplied' rather than an empty credential", () => {
    const env = buildRuntimeChildEnv({ GH_TOKEN: 'gho_ambient' }, {}, '');
    expect(env['COPILOT_GITHUB_TOKEN']).toBeUndefined();
  });
});
