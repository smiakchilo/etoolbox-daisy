import { exposeFakeAgentServiceForTests, fakeModelCatalog } from '../agentComposition';
import {
  createFakeAgentService,
  DEFAULT_FAKE_AUTH_STATE,
  type FakeAgentService,
} from './fakeAgentService';
import { ok, type AgentHost, type AgentRuntime } from '../../shared';

/**
 * The deterministic stand-in for every agent when `shouldUseFakeAgentService`
 * is true (unpackaged E2E runs only). No SDK, no child process: it installs a
 * scripted {@link FakeAgentService} and answers auth from it, so the whole chat
 * and Settings surface is exercisable without a real provider - and, because
 * it stands in for *any* agent id, without the provider's folder being loaded.
 */
export function createFakeRuntime(host: AgentHost): AgentRuntime {
  let fake: FakeAgentService | undefined;
  let installed: Promise<void> = Promise.resolve();

  const start = (): Promise<void> => {
    fake = createFakeAgentService();
    // Test-only global; see `exposeFakeAgentServiceForTests`.
    exposeFakeAgentServiceForTests(fake);
    installed = host.installService(fake);
    return installed;
  };

  return {
    start,
    // The fake owns its state; recycling would throw the E2E script away.
    reconcile: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    whenReady: () => installed.catch(() => undefined),
    getAuthStatus: () => Promise.resolve(fake?.getAuthState() ?? { ...DEFAULT_FAKE_AUTH_STATE }),
    login: () =>
      Promise.resolve({ status: 'failed', message: 'Sign-in is unavailable with the fake agent.' }),
    logout: () =>
      Promise.resolve({ apiVersion: 1, warning: 'Sign-out is unavailable with the fake agent.' }),
    loadModelCatalog: () => Promise.resolve(ok(fakeModelCatalog())),
  };
}
