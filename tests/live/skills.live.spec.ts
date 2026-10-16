import { expect, test, type TestInfo } from '@playwright/test';
import { journalPathFor, toolCalls } from '../support/live/journal';
import {
  expectNoToolError,
  expectSkillLoaded,
  expectToolCalled,
  expectToolSucceeded,
  expectTurnCompleted,
} from '../support/live/liveAssertions';
import { type LiveApp, launchLiveApp } from '../support/live/liveApp';
import { sendAndWait, startFreshConversation } from '../support/live/liveChat';
import { attachEvidence } from '../support/live/liveEvidence';

// Needs the `skill-selftest` skill in the user's skills folder (<home>/etoolbox-daisy/skills).
// It reads references/passphrase.md and runs scripts/checksum.js with [3, 5, 7, 11] (weighted sum 78).
const SKILL = 'skill-selftest';
const PASSPHRASE = 'amber-heron-4821';
const WEIGHTED_SUM = 78;

const PROMPTS = {
  explicit: `/${SKILL}`,
  inferred: 'Please run the skill self-test and tell me the passphrase and the checksum.',
};

async function runScenario(testInfo: TestInfo, scenario: string, prompt: string): Promise<void> {
  let live: LiveApp | undefined;
  let chatId: string | undefined;
  let passed = false;
  try {
    live = await launchLiveApp();
    chatId = await startFreshConversation(live);
    const { journal } = await sendAndWait(live, chatId, prompt);

    expectTurnCompleted(journal);
    expectSkillLoaded(journal, SKILL);

    const [resource] = expectToolCalled(
      journal,
      'skill_resource',
      (call) =>
        call.arguments['skill'] === SKILL && call.arguments['path'] === 'references/passphrase.md',
    );
    if (resource === undefined) throw new Error('unreachable');
    expectToolSucceeded(resource);
    expect(JSON.stringify(resource.outcome)).toContain(PASSPHRASE);

    const [script] = expectToolCalled(
      journal,
      'skill_script',
      (call) =>
        call.arguments['skill'] === SKILL && call.arguments['script'] === 'scripts/checksum.js',
    );
    if (script === undefined) throw new Error('unreachable');
    expectToolSucceeded(script);
    expect(script.outcome?.ok && script.outcome.data).toMatchObject({
      output: { weightedSum: WEIGHTED_SUM, label: 'selftest-ok' },
    });

    expectNoToolError(journal);
    // The diagnostic skill must not reach for AEM.
    expect(toolCalls(journal).filter((call) => call.toolName.startsWith('aem_'))).toEqual([]);
    passed = true;
  } finally {
    if (live !== undefined && chatId !== undefined) {
      const host = await live.currentHost().catch(() => undefined);
      const result = await attachEvidence(testInfo, {
        scenario,
        journalPath: journalPathFor(live.paths.chats, chatId),
        agent: live.agent,
        host,
        passed,
      });
      console.log(`Evidence: ${result.directory}`);
    }
    await live?.close();
  }
}

test('skills: /skill-selftest loads the user skill, reads its file and runs its script', async () => {
  await runScenario(test.info(), 'skills-explicit', PROMPTS.explicit);
});

test('skills: the model picks the user skill from its description alone', async () => {
  await runScenario(test.info(), 'skills-inferred', PROMPTS.inferred);
});
