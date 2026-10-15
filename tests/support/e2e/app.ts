import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import { type ScratchEnvOptions, type ScratchHome, scratchEnv } from './profile';

export type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

/** The built main-process entry point the specs launch. */
export const mainEntry = path.resolve(__dirname, '../../../out/main/index.js');

/** Launches the built app against a scratch home. */
export function launchApp(
  profile: ScratchHome,
  options: ScratchEnvOptions = {},
): Promise<ElectronApp> {
  return electron.launch({ args: [mainEntry], env: scratchEnv(profile, options) });
}
