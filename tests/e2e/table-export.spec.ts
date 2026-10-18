// noinspection HtmlUnknownTarget

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { type ScriptedStep } from '../../src/main/agents/fakeAgentService';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import { sendViaComposer, waitForComposerReady } from '../support/e2e/composer';
import { flushFake, scriptTurn } from '../support/e2e/fakeAgent';
import { createScratchDirs } from '../support/e2e/profile';
import { readRevealedPaths, stubShowItemInFolder } from '../support/e2e/shellStubs';
import { byTestId } from '../support/selectors';

/**
 * The `format_table` message gutter's **Copy** and **Export** actions, against
 * the BUILT app.
 *
 * Proves, with the deterministic fake driving a real `format_table` call and
 * the real Spectrum table:
 *
 *  - hovering the column header row (the gutter) opens the travelling popover
 *    with Copy/Export, while hovering an ordinary data row does not;
 *  - Copy writes BOTH a tab-separated `text/plain` and an HTML `<table>` to the
 *    real OS clipboard (read back in the main process);
 *  - Export hands the CSV to main, which shows the save dialog (stubbed here to
 *    a fixed path) and writes the file.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/table-export.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'table-export-scratch');

const TABLE = '.chat-table-message sp-table';
const OPEN_OVERLAY = `${byTestId('hover-popover')}[open]`;
const COPY_BUTTON = `${OPEN_OVERLAY} ${byTestId('popover-copy')}`;
const EXPORT_BUTTON = `${OPEN_OVERLAY} ${byTestId('popover-export')}`;

/**
 * Waits until the transcript's scroll position stops changing. The gutter
 * popover closes on **any** scroll (so it is never anchored to something that
 * has moved), and the transcript is still stick-to-bottom-pinning for a few
 * frames after a turn's table appears - so hovering before it settles can be
 * undone by that scroll. This removes the window; `hoverGutterUntilOpen` then
 * re-hovers as a second safety net.
 */
async function waitForTranscriptSettled(shell: Page): Promise<void> {
  const transcript = shell.locator('.chat-transcript');
  await expect
    .poll(
      async () => {
        const before = await transcript.evaluate((element) => element.scrollTop);
        await shell.waitForTimeout(150);
        const after = await transcript.evaluate((element) => element.scrollTop);
        return before === after;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * Opens the gutter popover and waits until both actions are in it.
 *
 * Hovering once can be undone by the settling scroll above; this also re-hovers
 * (moving the pointer away first, so a fresh `pointerover` fires) until the open
 * popover holds both buttons.
 */
async function hoverGutterUntilOpen(shell: Page): Promise<void> {
  await waitForTranscriptSettled(shell);
  await expect
    .poll(
      async () => {
        await shell.mouse.move(1, 1);
        await shell.locator('.chat-table-message sp-table-head').hover();
        return shell.locator(`${OPEN_OVERLAY} sp-action-button`).count();
      },
      { timeout: 15_000 },
    )
    .toBe(2);
}

/** A scripted `format_table` call carrying `data` verbatim (the app paints the table from the call's args). */
function formatTableStep(data: unknown): ScriptedStep {
  return {
    kind: 'toolCall',
    call: {
      toolName: 'format_table',
      arguments: { data: data as never, mode: 'new' },
      decision: {
        kind: 'approved',
        outcome: {
          ok: true,
          data: {
            operation: 'format_table',
            rowCount: 2,
            mode: 'new',
            textResultForLlm: 'ok',
            resultType: 'success',
          } as never,
        },
      },
    },
  };
}

const TABLE_DATA = {
  rows: [{ 'jcr:path': '/content/site/a' }, { 'jcr:path': '/content/site/b' }],
  pagination: { hasMore: false, total: { accuracy: 'exact', value: 2 } },
};

// What the serializers must produce for TABLE_DATA: header row, data rows, and
// the total line as a trailing row. Deliberately spelled out here rather than
// recomputed with the app's own module, so this is a genuine end-to-end
// expectation.
const EXPECTED_TSV = 'Path\r\n/content/site/a\r\n/content/site/b\r\nTotal: 2';
const EXPECTED_CSV = '\uFEFFPath\r\n/content/site/a\r\n/content/site/b\r\nTotal: 2';
const EXPECTED_HTML =
  '<table><thead><tr><th>Path</th></tr></thead><tbody>' +
  '<tr><td>/content/site/a</td></tr>' +
  '<tr><td>/content/site/b</td></tr>' +
  '<tr><td>Total: 2</td></tr>' +
  '</tbody></table>';

test.describe('format_table gutter: copy and export', () => {
  let app: ElectronApp;
  let shell: Page;
  let exportPath: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const profile = createScratchDirs(scratchBase);
    exportPath = path.join(profile.home, 'exported-table.csv');
    app = await launchApp(profile, { fakeAgent: true });
    shell = await app.firstWindow();
    await waitForComposerReady(shell);

    // The Export action's OS dialog is replaced with a deterministic path in the
    // main process, so the real renderer -> IPC -> write path runs end to end
    // with no native dialog to drive.
    await app.evaluate(({ dialog }, filePath: string) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
    }, exportPath);

    // ... and `shell.showItemInFolder` is replaced with a recorder, so the
    // "Open in folder" click never opens an Explorer window.
    await stubShowItemInFolder(app);

    await scriptTurn(app, { steps: [formatTableStep(TABLE_DATA)] });
    await sendViaComposer(shell, '/search waldo');
    await flushFake(app);
    await expect(shell.locator(TABLE)).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('hovering the header row opens Copy/Export; hovering a data row does not', async () => {
    await hoverGutterUntilOpen(shell);
    // The real Spectrum icons, not unknown tags.
    await expect(shell.locator(COPY_BUTTON)).toBeVisible();
    await expect(shell.locator(EXPORT_BUTTON)).toBeVisible();
    expect(await shell.evaluate(() => customElements.get('sp-icon-copy') !== undefined)).toBe(true);
    expect(await shell.evaluate(() => customElements.get('sp-icon-export') !== undefined)).toBe(
      true,
    );
    await expect(shell.locator(`${EXPORT_BUTTON} sp-icon-export`)).toHaveCount(1);

    // An ordinary data row is not the gutter: the popover closes and stays shut.
    await shell.locator('.chat-table-message sp-table-body sp-table-row').first().hover();
    await expect(shell.locator(OPEN_OVERLAY)).toHaveCount(0);
  });

  test('Copy writes tab-separated text and an HTML table to the clipboard', async () => {
    // Clear the clipboard first: otherwise the poll below can pass on content
    // left there by an earlier run, before the new write lands.
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await hoverGutterUntilOpen(shell);
    await shell.locator(COPY_BUTTON).click();

    // The real OS clipboard, read back in the main process. Electron's
    // `clipboard` is the async W3C-shaped API here: `read()` yields items whose
    // `getType` returns the payload for a MIME type.
    await expect
      .poll(async () => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(EXPECTED_TSV);
    const html = await app.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read();
      for (const item of items) {
        if (item.types.includes('text/html')) {
          const payload = await item.getType('text/html');
          return await (payload as Blob).text();
        }
      }
      return '';
    });
    expect(html).toContain(EXPECTED_HTML);
  });

  test('Export writes the CSV the save dialog names, and offers Open in folder', async () => {
    await hoverGutterUntilOpen(shell);
    await shell.locator(EXPORT_BUTTON).click();

    await expect.poll(() => existsSync(exportPath)).toBe(true);
    expect(readFileSync(exportPath, 'utf8')).toBe(EXPECTED_CSV);

    // A sticky notice tells the reader which file landed and offers to reveal
    // it. Its copy names the file and - per the app's rule - never ends with a
    // period, so the exact text node is asserted, not a substring.
    const banner = shell.locator('.chat-status-banner');
    await expect(banner).toHaveAttribute('open', '');
    const copyText = await banner.locator('.banner-row__copy').evaluate((copy) => {
      const first = copy.firstChild;
      return first !== null && first.nodeType === 3 /* TEXT_NODE */ ? first.textContent : '';
    });
    expect(copyText).toBe('Exported to exported-table.csv');
    // ... and the control is separated from that text by a real space, so the
    // row reads (and copies) as one sentence rather than "…csvOpen in folder".
    const fullCopy = await banner.locator('.banner-row__copy').evaluate((copy) => copy.textContent);
    expect(fullCopy).toBe('Exported to exported-table.csv Open in folder');
    const openInFolder = banner.locator(byTestId('banner-open-in-folder'));
    await expect(openInFolder).toBeVisible();

    await openInFolder.click();
    await expect.poll(() => readRevealedPaths(app)).toEqual([exportPath]);
    // Acting on the notice dismisses it.
    await expect(banner).not.toHaveAttribute('open', '');
  });

  test('the gutter popover is right-aligned to the table', async () => {
    await hoverGutterUntilOpen(shell);
    const geometry = await shell.evaluate((openOverlay) => {
      const table = document.querySelector('.chat-table-message sp-table');
      const popover = document.querySelector(`${openOverlay} sp-popover`);
      if (table === null || popover === null) return null;
      const tableRect = table.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      return { table: tableRect, popover: popoverRect };
    }, OPEN_OVERLAY);
    expect(geometry).not.toBeNull();
    const { table, popover } = geometry!;
    // The popover hugs the table's RIGHT edge (right-aligned) rather than
    // straddling its middle. A small tolerance covers Spectrum's own offset
    // between an overlay and its trigger.
    expect(Math.abs(popover.right - table.right)).toBeLessThanOrEqual(16);
    expect(popover.left).toBeGreaterThan(table.left + (table.right - table.left) / 2);
  });
});
