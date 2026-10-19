import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { type ScriptedStep } from '../../src/main/agents/fakeAgentService';
import { MEMO_REFLECTION_TOOL_NAME, MEMO_TOOL_NAME } from '../../src/shared';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import { sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { flushFake, scriptTurn } from '../support/e2e/fakeAgent';
import { createScratchDirs, type ScratchDirs } from '../support/e2e/profile';
import { readRevealedPaths, stubShowItemInFolder } from '../support/e2e/shellStubs';
import { byTestId } from '../support/selectors';

/**
 * Self-learning memos against the BUILT app:
 *  - a stored memo raises the chat pane's notice ("Memo was stored"), whose
 *    **Open** action reveals that memo's own file (main derives the path from
 *    the id); the billet itself stays, and offers no hover toolbar;
 *  - a turn with a failed tool call is followed by the application's own
 *    reflection turn: its prompt is never painted as a user message, its prose
 *    is suppressed, and the transcript shows only the reflection marker and the
 *    memo it wrote.
 *
 * The fake scripts the tool outcomes, so the memo file is seeded on disk and
 * the scripted result names it by id.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/memos.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'memos-scratch');

const TOOL_CALL = '.chat-tool-call';
const HOVER_POPOVER = `${byTestId('hover-popover')}[open]`;
const USER_MESSAGE = '.chat-message--user';
const ASSISTANT_MESSAGE = '.chat-message--assistant';

/** Writes a memo file into the scratch home's memos folder; returns its absolute path. */
function seedMemo(dirs: ScratchDirs, id: string): string {
  const file = path.join(dirs.home, 'etoolbox-daisy', 'memos', ...id.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '---\ntitle: Seeded\n---\nA seeded lesson\n', 'utf8');
  return file;
}

/** A scripted `memo` call whose successful result names the memo `id`. */
function memoStep(id: string, title: string): ScriptedStep {
  return {
    kind: 'toolCall',
    call: {
      toolName: MEMO_TOOL_NAME,
      arguments: { title, text: 'Include both paths in the table', trigger: 'correction' },
      decision: {
        kind: 'approved',
        outcome: {
          ok: true,
          data: {
            operation: MEMO_TOOL_NAME,
            id,
            title,
            fileName: path.posix.basename(id),
            textResultForLlm: 'saved',
            resultType: 'success',
          } as never,
        },
      },
    },
  };
}

function memoBillet(shell: Page, title: string): Locator {
  return shell
    .locator(TOOL_CALL)
    .filter({ has: shell.locator('.chat-tool-call__header', { hasText: MEMO_TOOL_NAME }) })
    .filter({ hasText: title });
}

/**
 * Drains the fake until `title`'s memo billet is painted.
 *
 * The drain starts only once Stop shows, i.e. main has forwarded the turn's
 * `sending` event - which it journals first. Each `flushFake` is an
 * `app.evaluate` run through the V8 inspector, which can interrupt main's
 * synchronous code; flushing while the send was still writing its first
 * journal record re-entered zod's lazily-built union schema mid-build and
 * made the write throw (an inspector-only race, unreachable in production).
 */
async function flushUntilBillet(app: ElectronApp, shell: Page, title: string): Promise<void> {
  await expect(shell.locator(byTestId('chat-composer-stop'))).toBeVisible();
  await expect
    .poll(
      async () => {
        await flushFake(app);
        return memoBillet(shell, title).count();
      },
      { timeout: 15_000 },
    )
    .toBe(1);
}

test.describe('self-learning memos', () => {
  let app: ElectronApp;
  let shell: Page;
  let dirs: ScratchDirs;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dirs = createScratchDirs(scratchBase);
    app = await launchApp(dirs, { fakeAgent: true });
    shell = await app.firstWindow();
    await waitForComposerReady(shell);
    await stubShowItemInFolder(app);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('a stored memo raises a notice whose Open action reveals its file', async () => {
    const id = 'generic/20261019-101530-both-paths.md';
    const file = seedMemo(dirs, id);
    const title = 'Show both paths';
    await scriptTurn(app, { steps: [memoStep(id, title)] });
    await sendViaComposer(shell, 'You should have included both paths');
    await flushUntilBillet(app, shell, title);

    // The billet stays, but it carries no hover toolbar - it used to be the one
    // billet with one.
    const billet = memoBillet(shell, title);
    await expect(billet).toBeVisible();
    await billet.locator('.chat-tool-call__toggle').hover();
    await expect(shell.locator(HOVER_POPOVER)).toHaveCount(0);

    // The pane's one alert banner acknowledges the write; Open asks main to
    // reveal the memo main itself derived from the id.
    const banner = shell.locator('.chat-status-banner');
    await expect(banner).toHaveAttribute('open', '');
    await expect(banner).toContainText('Memo was stored');
    await shell.locator(byTestId('banner-open-memo-folder')).click();
    await expect.poll(() => readRevealedPaths(app)).toEqual([file]);
  });

  test('a failed turn is followed by a quiet reflection that writes a memo', async () => {
    const id = 'generic/20261019-101531-check-path.md';
    seedMemo(dirs, id);
    const title = 'Check the path first';
    const userMessages = await shell.locator(USER_MESSAGE).count();

    await scriptTurn(app, {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_get_json',
            arguments: { path: '/content/missing' },
            decision: {
              kind: 'approved',
              outcome: { ok: false, code: 'UNEXPECTED_RESPONSE', message: 'Bad response' },
            },
          },
        },
        { kind: 'delta', text: 'The read failed' },
      ],
    });
    await scriptTurn(app, {
      steps: [{ kind: 'delta', text: 'REFLECTION-PROSE' }, memoStep(id, title)],
    });
    await sendViaComposer(shell, 'Read the missing page');

    // The reflection starts once the user turn has ended, so keep draining.
    await flushUntilBillet(app, shell, title);

    await expect(
      shell.locator(TOOL_CALL).filter({
        has: shell.locator('.chat-tool-call__header', { hasText: MEMO_REFLECTION_TOOL_NAME }),
      }),
    ).toHaveCount(1);
    await expect(shell.locator(USER_MESSAGE)).toHaveCount(userMessages + 1);
    await expect(shell.locator(ASSISTANT_MESSAGE, { hasText: 'REFLECTION-PROSE' })).toHaveCount(0);
    // The reflection's memo raises the same sticky notice; Send is still ready,
    // so the banner being open is expected rather than a startup message.
    await expect(shell.locator('.chat-status-banner')).toContainText('Memo was stored');
    await waitForComposerReady(shell, { awaitBannerClosed: false });
  });
});
