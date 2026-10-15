import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAKE_AGENT_SERVICE_ENV_VAR } from '../../../src/main/agentComposition';
import { definedEnv } from './env';

/** The directories a scratch profile redirects the app's per-user storage to. */
export interface ScratchHome {
  readonly home: string;
  readonly appData: string;
  readonly localAppData: string;
}

export interface ScratchDirs extends ScratchHome {
  readonly root: string;
}

export interface ScratchEnvOptions {
  /** Selects the deterministic fake agent service instead of the real SDK adapter. */
  readonly fakeAgent?: boolean;
}

/** Creates `<scratchBase>/<prefix>XXXXXX/home` with its `AppData` folders. */
export function createScratchDirs(scratchBase: string, prefix = 'profile-'): ScratchDirs {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, prefix));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return { root, home, appData, localAppData };
}

/**
 * The process environment, pointed at a scratch home. Overriding USERPROFILE/HOME
 * alone crashes Electron on this machine (0x80000003) - APPDATA/LOCALAPPDATA must agree.
 */
export function scratchEnv(
  profile: ScratchHome,
  options: ScratchEnvOptions = {},
): Record<string, string> {
  return {
    ...definedEnv(process.env),
    USERPROFILE: profile.home,
    HOME: profile.home,
    APPDATA: profile.appData,
    LOCALAPPDATA: profile.localAppData,
    ...(options.fakeAgent === true ? { [FAKE_AGENT_SERVICE_ENV_VAR]: '1' } : {}),
  };
}

/** A fresh scratch home together with the environment that launches the app against it. */
export function createLaunchProfile(
  scratchBase: string,
  options: ScratchEnvOptions = {},
): ScratchDirs & { readonly env: Record<string, string> } {
  const dirs = createScratchDirs(scratchBase);
  return { ...dirs, env: scratchEnv(dirs, options) };
}

/** Seeds `<home>/etoolbox-daisy/settings/settings.json` before the app starts. */
export function writeSettings(home: string, settings: unknown): void {
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}
