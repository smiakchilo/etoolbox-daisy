import { z } from 'zod';
import { projectIdSchema } from './ids';
import { serverLabelSchema } from './serverConfig';

/**
 * A configured project entry - a named bundle of *host-structure* facts that
 * several hosts may share. It carries no address, proxy or TLS material: a
 * project describes how the data in an AEM instance is laid out, not where or
 * how that instance is reached, which stays on the host (`serverConfig.ts`).
 *
 * This exists because such facts repeat across the hosts of one environment
 * (an "HPE" project's content/component roots are the same for its Dev, Stage
 * and Prod hosts), so they are written once here and referenced by a host's
 * optional `projectId`, rather than duplicated on every host.
 *
 * Like every schema in this module it is `.strict()`, and like the proxies
 * library it carries an `id` (so a host can reference it and reordering can be
 * persisted) and a `label` (user-facing only).
 */

const ENVIRONMENT_ROOT_TEXT_MAX_LENGTH = 2000;

/**
 * Free text naming one or more JCR roots, e.g. `/content/a, /content/b`. The
 * interpretation - comma-or-semicolon separation (a comma wins over a
 * semicolon), trimming, dropping unusable tokens, and the `/content`/`/apps`
 * defaults - lives in `src/shared/tools/core/environment.ts`; this schema only
 * bounds the string. An empty string is accepted and means "no roots written",
 * identical to omitting the field; the forgiving reader drops it on load.
 */
export const environmentRootTextSchema = z
  .string()
  .max(
    ENVIRONMENT_ROOT_TEXT_MAX_LENGTH,
    `must be at most ${String(ENVIRONMENT_ROOT_TEXT_MAX_LENGTH)} characters`,
  );

export const projectConfigSchema = z
  .object({
    id: projectIdSchema,
    label: serverLabelSchema,
    /**
     * Where content lives on the hosts of this project, in free text (one or
     * more JCR roots separated by `,`, or by `;` when no comma is present).
     * Optional: absent means "use the `/content` default".
     */
    contentRoots: environmentRootTextSchema.optional(),
    /**
     * Where components live on the hosts of this project, in the same
     * free-text form. Optional: absent means "use the `/apps` default".
     */
    componentRoots: environmentRootTextSchema.optional(),
    /**
     * Content paths whose search results come first, in the written order,
     * followed by everything else in scope. Same free-text form as the roots;
     * optional, with no default: absent means "no priority".
     */
    contentPriorityPaths: environmentRootTextSchema.optional(),
  })
  .strict();

export type ProjectConfig = Readonly<z.infer<typeof projectConfigSchema>>;
