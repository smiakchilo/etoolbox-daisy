import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  getLocalDataDirectory,
  getOsHomeDirectory,
  resolveAppPaths,
} from '../../src/main/appPaths';
import { assistantText, journalPathFor, toolCalls, userPrompts } from '../support/live/journal';
import { expectNoToolError, expectTurnCompleted } from '../support/live/liveAssertions';
import { type LiveApp, launchLiveApp } from '../support/live/liveApp';
import { sendAndWait, startFreshConversation } from '../support/live/liveChat';
import { attachEvidence } from '../support/live/liveEvidence';

// Rules are read at app start, so the files are written into the real rules folder BEFORE the
// app launches and removed afterwards. The file names are prefixed so a real rule is never touched.
// The project rule is scoped to the label of the project the restored host selects (read from
// the real settings), so the run needs at least one host with a project.
const GENERIC_TOKEN = 'ember-quartz-7302';
const PROJECT_TOKEN = 'cobalt-fox-5518';
const OTHER_PROJECT_TOKEN = 'slate-owl-0000';
const PROMPT =
  'rules-selftest: reply with the self-test tokens that your instructions require for this phrase. ' +
  'Use no tools and add nothing else.';

function rule(trigger: string, token: string, label?: string): string {
  const frontMatter = label === undefined ? '' : `---\nproject: "${label}"\n---\n\n`;
  return `${frontMatter}When the user's message contains the phrase "${trigger}", include the exact token \`${token}\` in your reply.\n`;
}

test('rules: generic and matching project rules reach the model; another project rule does not', async () => {
  const paths = resolveAppPaths(getOsHomeDirectory(), getLocalDataDirectory());
  const files = ['zz-livetest-generic.md', 'zz-livetest-project.md', 'zz-livetest-other.md'].map(
    (name) => path.join(paths.rules, name),
  );
  const projectLabel = process.env['LIVE_RULES_PROJECT'];

  let live: LiveApp | undefined;
  let chatId: string | undefined;
  let passed = false;
  try {
    // Probe the settings first (the launch reads them again) to learn the project label.
    const probe = await launchLiveApp();
    const host = await probe.currentHost();
    const settings = probe.settings as {
      hosts?: { id?: string; projectId?: string }[];
      projects?: { id?: string; label?: string }[];
    };
    await probe.close();
    const hostProject = settings.hosts?.find((entry) => entry.id === host?.id)?.projectId;
    const label =
      projectLabel ?? settings.projects?.find((project) => project.id === hostProject)?.label;
    if (label === undefined) {
      throw new Error(
        'The restored host selects no project. Select a project for it in Settings, or set LIVE_RULES_PROJECT.',
      );
    }

    mkdirSync(paths.rules, { recursive: true });
    writeFileSync(files[0] as string, rule('rules-selftest', GENERIC_TOKEN));
    writeFileSync(files[1] as string, rule('rules-selftest', PROJECT_TOKEN, label));
    writeFileSync(
      files[2] as string,
      rule('rules-selftest', OTHER_PROJECT_TOKEN, 'No Such Project'),
    );

    live = await launchLiveApp();
    chatId = await startFreshConversation(live);
    const { journal } = await sendAndWait(live, chatId, PROMPT);

    expectTurnCompleted(journal);
    expectNoToolError(journal);
    expect(toolCalls(journal)).toEqual([]);
    const reply = assistantText(journal);
    expect(reply).toContain(GENERIC_TOKEN);
    expect(reply).toContain(PROJECT_TOKEN);
    expect(reply).not.toContain(OTHER_PROJECT_TOKEN);
    // The typed prompt is journaled as typed; rules travel beside it, never inside it.
    expect(userPrompts(journal)[0]?.prompt).toBe(PROMPT);
    passed = true;
  } finally {
    if (live !== undefined && chatId !== undefined) {
      const host = await live.currentHost().catch(() => undefined);
      const result = await attachEvidence(test.info(), {
        scenario: 'rules',
        journalPath: journalPathFor(live.paths.chats, chatId),
        agent: live.agent,
        host,
        passed,
      });
      console.log(`Evidence: ${result.directory}`);
    }
    await live?.close();
    for (const file of files) rmSync(file, { force: true });
  }
});
