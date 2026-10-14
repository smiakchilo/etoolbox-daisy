/**
 * Resolves the app's window/taskbar icon.
 *
 * Dev runs execute from `out/main`, two levels below the repository root where
 * `resources/` lives; packaged builds get `resources/` copied next to the app
 * by electron-builder's `extraResources` (`from: resources`, `to: resources`),
 * landing under `process.resourcesPath`. Deliberately Electron-free (the
 * `(platform, isPackaged, resourcesPath, mainDir)` tuple plus `join`/`exists`
 * are injected) so this stays unit-testable without a running Electron
 * process - the same shape as `resolveBundledResourcesDirectory` in
 * `agentComposition.ts`.
 *
 * macOS gets `icon.png`: Electron's `nativeImage` there loads neither `.ico`
 * nor `.icns` (both come back empty), so the Dock icon of an unpackaged run
 * needs a PNG. The packaged bundle's own icon is `icon.icns`, set by
 * electron-builder.yml's `mac.icon`, not by this function.
 *
 * Returns `undefined` (rather than a path that does not exist) when the icon
 * is absent, so window construction falls back to Electron's default icon
 * instead of being handed a dead path.
 */
export function resolveAppIconPath(params: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly mainDir: string;
  readonly join: (...segments: readonly string[]) => string;
  readonly exists: (candidate: string) => boolean;
}): string | undefined {
  const fileName = params.platform === 'darwin' ? 'icon.png' : 'icon.ico';
  const candidate = params.isPackaged
    ? params.join(params.resourcesPath, 'resources', fileName)
    : params.join(params.mainDir, '..', '..', 'resources', fileName);
  return params.exists(candidate) ? candidate : undefined;
}
