import { type SkillHost, err } from '../../src/shared';

const notLoaded = (name: string) =>
  err({ code: 'NOT_FOUND' as const, message: `No skill named "${name}" is loaded.` });

/** A `ToolHost.skills` that holds no skill: every lookup is `NOT_FOUND`. */
export const NO_SKILLS: SkillHost = {
  list: () => [],
  activate: (name) => notLoaded(name),
  readResource: (request) => Promise.resolve(notLoaded(request.skill)),
  runScript: (request) => Promise.resolve(notLoaded(request.skill)),
};

export interface FakeSkillOptions {
  readonly list?: SkillHost['list'];
  readonly activate?: SkillHost['activate'];
  readonly readResource?: SkillHost['readResource'];
  readonly runScript?: SkillHost['runScript'];
}

/** A skill host whose operations the test supplies; the rest behave as {@link NO_SKILLS}. */
export function createFakeSkillHost(options: FakeSkillOptions): SkillHost {
  return {
    list: () => (options.list ?? NO_SKILLS.list)(),
    activate: (name) => (options.activate ?? NO_SKILLS.activate)(name),
    readResource: (request) => (options.readResource ?? NO_SKILLS.readResource)(request),
    runScript: (request) => (options.runScript ?? NO_SKILLS.runScript)(request),
  };
}
