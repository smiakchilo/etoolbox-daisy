import { z } from 'zod';

/**
 * Runtime schema for the data exposed by the app-preload `getAppInfo()` API.
 * This is the contract validated at the IPC boundary: main process values are
 * treated as `unknown` until they pass this schema, per plan rule 5.
 */
export const appInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/, 'expected a semver-like version string'),
  /** Preload API surface version, so future steps can evolve the bridge safely. */
  apiVersion: z.literal(1),
});

export type AppInfo = z.infer<typeof appInfoSchema>;

export function parseAppInfo(candidate: unknown): AppInfo {
  return appInfoSchema.parse(candidate);
}
