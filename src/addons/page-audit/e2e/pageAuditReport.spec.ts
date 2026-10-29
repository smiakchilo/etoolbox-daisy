import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mainEntry } from '../../../../tests/support/e2e/app';
import { createLaunchProfile, writeSettings } from '../../../../tests/support/e2e/profile';
import { byTestId } from '../../../../tests/support/selectors';

/**
 * The audit report, driven against the **built** app: its sections and entries
 * collapse and expand (the real CSS, which jsdom cannot check - a
 * `display: flex` body would otherwise stay visible when `hidden` is set), the
 * evidence is indented under the heading text, and expanding a small entry after
 * a tall one keeps the just-expanded heading on screen.
 *
 * The report needs a real audit result, which the fake agent cannot produce, so
 * the tests seed a chat journal holding one - in exactly the shape this add-on's
 * tool returns, the report message under `data.report` - and open it with the dev
 * `!!open <chatId>` trigger (unpackaged builds only). Everything else - the
 * transcript render, the accordion state, the linkifier, the scroll - is the
 * real app.
 *
 *   npm run build
 *   npx playwright test src/addons/page-audit/e2e
 */

// The add-on's own package.json declares `"type": "module"`, so this spec runs
// as ESM: `import.meta.dirname` is where `__dirname` would be.
const scratchBase = path.resolve(
  import.meta.dirname,
  '../../../../test-results',
  'page-audit-report-scratch',
);

type CellValue =
  | { readonly kind: 'text'; readonly value: string }
  | {
      readonly kind: 'selector';
      readonly selector: string;
      readonly snippet?: string;
      readonly label?: string;
      readonly explanation?: string;
    };
type Cell = readonly CellValue[];

function textRow(value: string): Cell {
  return [{ kind: 'text', value }];
}

interface SeedOptions {
  /** A first entry with a tall evidence table, then a small second entry, then many collapsed entries below. */
  readonly tall?: boolean;
}

/** Writes a chat journal holding one audit report, and returns its chat id. */
function seedReportJournal(home: string, options: SeedOptions = {}): string {
  const chatId = randomUUID();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const toolCallId = randomUUID();
  const messageId = randomUUID();
  const at = Date.now();

  const selectorRow = (index: number): Cell => [
    {
      kind: 'selector',
      selector: `h4.title-${String(index)}`,
      snippet: `<h4 class="title">A code snippet ${String(index)} that goes on for a while</h4>`,
      label: 'h4',
    },
    { kind: 'text', value: 'https://cdn.example/x.css' },
  ];
  const firstRows =
    options.tall === true
      ? Array.from({ length: 40 }, (_, index) => selectorRow(index))
      : [selectorRow(0)];

  const firstColumns = [
    { key: 'node', label: 'Element' },
    { key: 'url', label: 'URL' },
  ];
  const urlColumn = { key: 'url', label: 'URL' };
  const failures = [
    {
      category: 'performance',
      id: 'largest-contentful-paint',
      title: 'Largest Contentful Paint',
      score: 33,
      displayValue: '3.0 s',
      evidence: [
        { kind: 'table', columns: firstColumns, rows: firstRows },
        {
          kind: 'text',
          value:
            'Learn more about the Total Blocking Time metric (https://developer.chrome.com/docs/tbt/).',
        },
      ],
    },
    {
      category: 'performance',
      id: 'speed-index',
      title: 'Speed Index',
      score: 40,
      displayValue: '2.9 s',
      evidence: [
        { kind: 'table', columns: [urlColumn], rows: [textRow('https://cdn.example/y.css')] },
      ],
    },
    // Enough collapsed entries below to keep the transcript scrollable once the
    // tall first entry collapses (so the small entry's position really moves).
    ...Array.from({ length: options.tall === true ? 30 : 0 }, (_, index) => ({
      category: 'performance',
      id: `padding-${String(index)}`,
      title: `Padding issue ${String(index + 1)}`,
      score: 0,
      evidence: [{ kind: 'text', value: 'No further detail.' }],
    })),
  ];

  // The report message the tool builds itself: one lead table, then one section
  // per category holding its findings' evidence (see `toolRenderer.ts`).
  const report = {
    ok: true,
    operation: 'page_audit',
    url: 'https://author.example/page.html',
    formFactor: 'desktop',
    scores: [{ category: 'performance', score: 70 }],
    failures,
    report: {
      summary: {
        kind: 'table',
        columns: [
          { key: 'category', label: 'Category' },
          { key: 'score', label: 'Score' },
          { key: 'status', label: 'Status', kind: 'status' },
        ],
        rows: [
          [
            { kind: 'text', value: 'Performance' },
            { kind: 'text', value: '70' },
            { kind: 'text', value: 'warn' },
          ],
        ],
      },
      sections: [
        {
          title: 'Performance',
          entries: failures.map((failure) => ({
            id: `${failure.category}:${failure.id}`,
            title: failure.title,
            score: failure.score,
            ...('displayValue' in failure ? { displayValue: failure.displayValue } : {}),
            blocks: failure.evidence,
          })),
        },
      ],
    },
    textResultForLlm: 'done',
    resultType: 'success',
  };

  const events: readonly Record<string, unknown>[] = [
    { type: 'session.state.changed', chatId, sequence: 0, turnId, state: 'sending' },
    {
      type: 'tool.call.requested',
      chatId,
      sequence: 1,
      toolCallId,
      toolName: 'page_audit',
      arguments: {},
    },
    {
      type: 'tool.result',
      chatId,
      sequence: 2,
      toolCallId,
      outcome: { ok: true, data: report },
    },
    // A table-only turn's model sometimes emits a bogus closing line; the app
    // must suppress it (the report is the answer).
    { type: 'assistant.message.started', chatId, sequence: 3, turnId, messageId },
    {
      type: 'assistant.message.completed',
      chatId,
      sequence: 4,
      turnId,
      messageId,
      content: 'No response.',
    },
    { type: 'session.state.changed', chatId, sequence: 5, turnId, state: 'idle' },
  ];
  const records = [
    { recordType: 'header', schemaVersion: 1, chatId, sessionId, startedAt: at },
    { recordType: 'user.prompt', at, chatId, turnId, prompt: '/check-page' },
    ...events.map((event, index) => ({ recordType: 'agent.event', at: at + index + 1, event })),
  ];
  const dir = path.join(home, 'etoolbox-daisy', 'chats');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${chatId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
  return chatId;
}

/** Launches the app and opens the seeded report; the caller closes the app. */
async function openReport(
  options: SeedOptions = {},
): Promise<{ readonly page: Page; readonly app: Awaited<ReturnType<typeof electron.launch>> }> {
  const env = createLaunchProfile(scratchBase, { fakeAgent: true }).env;
  const home = env['USERPROFILE'] ?? '';
  // A minimal settings document: the loader defaults whatever is absent.
  writeSettings(home, {});
  const chatId = seedReportJournal(home, options);

  const app = await electron.launch({ args: [mainEntry], env });
  const page = await app.firstWindow();
  await page.locator('.chat-composer__send').waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('.chat-composer textarea').fill(`!!open ${chatId}`);
  await page.locator('.chat-composer__send').click();
  await page.locator('.chat-report-message').waitFor({ state: 'visible', timeout: 30_000 });
  return { page, app };
}

function display(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).display);
}

test('the audit report collapses and expands, indents its evidence, and keeps links real', async () => {
  test.setTimeout(120_000);
  const { page, app } = await openReport();
  try {
    // Level 1: the rubric body starts visible, collapses to `display: none`,
    // then re-expands - the `[hidden]` rule that outranks its `display: flex`.
    expect(await display(page, '.chat-report-section__body')).not.toBe('none');
    await page.locator('button[data-report-rubric]').first().click();
    expect(await display(page, '.chat-report-section__body')).toBe('none');
    await page.locator('button[data-report-rubric]').first().click();
    expect(await display(page, '.chat-report-section__body')).not.toBe('none');

    // Level 2: an entry starts collapsed and expands on its own click.
    expect(await display(page, '.chat-report-entry__body')).toBe('none');
    await page.locator('button[data-report-entry]').first().click();
    expect(await display(page, '.chat-report-entry__body')).not.toBe('none');

    // The evidence content starts under the heading's text (past the chevron),
    // not under the chevron.
    const geo = await page.evaluate(() => {
      const toggle = document.querySelector('.chat-report-entry__toggle');
      const title = toggle?.querySelector('.chat-report-entry__title');
      const body = document.querySelector('.chat-report-entry__body');
      if (!toggle || !title || !body) return undefined;
      const t = toggle.getBoundingClientRect();
      return {
        titleLeft: Math.round(title.getBoundingClientRect().left - t.left),
        bodyPad: Math.round(parseFloat(getComputedStyle(body).paddingInlineStart)),
      };
    });
    expect(geo?.bodyPad).toBe(geo?.titleLeft);
    expect(geo?.bodyPad).toBeGreaterThan(16);

    // The URL cell is a real, externally-routed anchor.
    const anchor = page
      .locator('.chat-report-entry')
      .first()
      .locator('.chat-report-entry__body a')
      .first();
    await expect(anchor).toHaveCount(1);
    await expect(anchor).toHaveAttribute('data-daisy-external', '');
    // ...and a report link carries no underline (like a `format_table` link).
    expect(await anchor.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe(
      'none',
    );
    // The selector pseudo-link is underline-free too.
    expect(
      await page
        .locator('.chat-report-selector')
        .first()
        .evaluate((element) => getComputedStyle(element).textDecorationLine),
    ).toBe('none');

    // The code snippet uses the app's reading font and size (not a monospace
    // fallback), and is a bordered block on the hovered-row shade.
    const snippetStyles = await page.evaluate(() => {
      const cell = document.querySelector('.chat-report-entry__body sp-table-cell');
      const snippet = document.querySelector('.chat-report-cell__snippet');
      if (!cell || !snippet) return undefined;
      const cellStyle = getComputedStyle(cell);
      const snippetStyle = getComputedStyle(snippet);
      return {
        cellFontSize: cellStyle.fontSize,
        cellFontFamily: cellStyle.fontFamily,
        snippetFontSize: snippetStyle.fontSize,
        snippetFontFamily: snippetStyle.fontFamily,
        borderWidth: snippetStyle.borderTopWidth,
        borderStyle: snippetStyle.borderTopStyle,
        wordBreak: snippetStyle.wordBreak,
        background: snippetStyle.backgroundColor,
      };
    });
    expect(snippetStyles).toBeDefined();
    expect(snippetStyles?.snippetFontSize).toBe(snippetStyles?.cellFontSize);
    expect(snippetStyles?.snippetFontFamily).toBe(snippetStyles?.cellFontFamily);
    expect(snippetStyles?.snippetFontFamily ?? '').not.toMatch(/mono|Source Code Pro/i);
    expect(snippetStyles?.borderWidth).toBe('1px');
    expect(snippetStyles?.borderStyle).toBe('solid');
    // Wraps at any character, not only at a word boundary.
    expect(snippetStyles?.wordBreak).toBe('break-all');
    // A solid shade equal to a hovered row's (`rgba(0,0,0,.07)` over white):
    // hovering the row it sits in must not darken it with a second overlay.
    expect(snippetStyles?.background).toBe('rgb(237, 237, 237)');

    // A text block's "Learn more" URL is a real, externally-routed anchor.
    const textLink = page.locator('.chat-report-text a').first();
    await expect(textLink).toHaveCount(1);
    await expect(textLink).toHaveAttribute('href', 'https://developer.chrome.com/docs/tbt/');
    await expect(textLink).toHaveAttribute('data-daisy-external', '');
  } finally {
    await app.close();
  }
});

test('expanding a small entry after a tall one keeps its heading on screen', async () => {
  test.setTimeout(120_000);
  const { page, app } = await openReport({ tall: true });
  try {
    const entryToggles = page.locator('button[data-report-entry]');
    // Expand the tall first entry.
    await entryToggles.first().click();
    // Bring the second (small) entry's heading into view at the bottom.
    await entryToggles.nth(1).scrollIntoViewIfNeeded();
    const before = await entryToggles.nth(1).boundingBox();
    // Expanding it collapses the tall one above, which moves it up.
    await entryToggles.nth(1).click();
    const after = await entryToggles.nth(1).boundingBox();

    // The setup is meaningful: the transcript stays scrollable after the
    // collapse, and the small heading really moves up...
    const state = await page.evaluate(() => {
      const scroller = document.querySelector('.chat-transcript');
      const toggle = document.querySelectorAll('button[data-report-entry]')[1];
      if (!scroller || !toggle) return undefined;
      const s = scroller.getBoundingClientRect();
      const t = toggle.getBoundingClientRect();
      return {
        scrollable: scroller.scrollHeight > scroller.clientHeight,
        inView: t.top >= s.top - 1 && t.bottom <= s.bottom + 1,
      };
    });
    expect(state?.scrollable).toBe(true);
    expect(after!.y).toBeLessThan(before!.y);
    // ...and the app scrolled it back into the transcript's viewport.
    expect(state?.inView).toBe(true);
  } finally {
    await app.close();
  }
});

test('a report table carries the same Copy/Export gutter as a format_table', async () => {
  test.setTimeout(120_000);
  const { page, app } = await openReport();
  try {
    // Expand the first entry so its evidence table is visible.
    await page.locator('button[data-report-entry]').first().click();
    const table = page.locator('.chat-report-entry__body .chat-table-message').first();
    await expect(table).toBeVisible();

    // Hover the column header row (the gutter): its popover offers Copy/Export.
    // Re-hover until it opens, because the transcript's settling scroll closes
    // the popover on any scroll (same discipline as `table-export.spec.ts`).
    const header = table.locator('sp-table-head').first();
    const openOverlay = page.locator(`${byTestId('hover-popover')}[open]`);
    await expect
      .poll(
        async () => {
          await page.mouse.move(1, 1);
          await header.hover();
          return openOverlay.locator(byTestId('popover-copy')).count();
        },
        { timeout: 15_000 },
      )
      .toBe(1);
    await expect(openOverlay.locator(byTestId('popover-copy'))).toBeVisible();
    await expect(openOverlay.locator(byTestId('popover-export'))).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a table-only turn does not paint its model's bogus closing line", async () => {
  test.setTimeout(120_000);
  const { page, app } = await openReport();
  try {
    await expect(page.locator('.chat-report-message')).toBeVisible();
    // The seeded journal ends with an assistant "No response." message; the
    // report is the turn's answer, so that prose is suppressed.
    await expect(page.locator('.chat-transcript')).not.toContainText('No response.');
  } finally {
    await app.close();
  }
});
