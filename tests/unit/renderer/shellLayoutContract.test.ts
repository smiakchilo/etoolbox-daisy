import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Pins the "the document itself never scrolls" layout invariant that the
 * reserved WebContentsView region depends on (see viewModel.ts's
 * `computeReservedRegionBounds` doc comment and base.css's top-of-file
 * comment): the main process positions a native view using bounds measured
 * from the DOM, and a native view does not scroll with the document, so a
 * document-level scrollbar would silently desync the reported bounds from
 * where the view actually renders.
 *
 * There is no DOM/layout engine available to this suite (vitest.config.ts
 * runs tests under environment: "node"), so a real rendered-layout assertion
 * (e.g. an actual scrollHeight/clientHeight comparison) is not possible here
 * - that is verified manually against a launched build instead. This test
 * pins the *source* invariants that make that outcome true: it reads the
 * shipped stylesheets and fails if a future edit removes any link in the
 * "html to .main-shell is exactly 100% height with no overflow" chain, or
 * reintroduces a fixed min-height that could force the shell taller than the
 * viewport. The document and split-view rules live in base.css; the chat
 * pane's designated scroll region lives in chat.css.
 */

const cssDir = path.join(process.cwd(), 'src', 'renderer', 'src', 'styles');
const baseCssPath = path.join(cssDir, 'base.css');
const chatCssPath = path.join(cssDir, 'chat.css');
const baseCss = readFileSync(baseCssPath, 'utf8');
const chatCss = readFileSync(chatCssPath, 'utf8');

/** Returns the `{ ... }` declaration block for the first rule whose selector list matches `selectorPattern`. */
function findRuleBody(selectorPattern: RegExp, stylesheet: string, stylesheetName: string): string {
  const match = new RegExp(`${selectorPattern.source}\\s*\\{([^}]*)}`, 's').exec(stylesheet);
  if (!match) {
    throw new Error(
      `No CSS rule found in ${stylesheetName} matching selector ${selectorPattern.source}`,
    );
  }
  return match[1] ?? '';
}

describe('main window shell CSS: document-never-scrolls layout contract', () => {
  it('makes html/body fill the viewport with overflow hidden, so the document itself cannot scroll', () => {
    const body = findRuleBody(/html,\s*body/, baseCss, 'base.css');
    expect(body).toMatch(/height:\s*100%/);
    expect(body).toMatch(/overflow:\s*hidden/);
  });

  it('keeps #app and sp-theme at exactly 100% height, with no independent scroll behaviour', () => {
    const body = findRuleBody(/#app,\s*sp-theme/, baseCss, 'base.css');
    expect(body).toMatch(/height:\s*100%/);
    expect(body).not.toMatch(/overflow/);
  });

  it('sizes .main-shell to exactly 100% height with no min-height floor that could force it taller than the viewport', () => {
    const body = findRuleBody(/\.main-shell\s*/, baseCss, 'base.css');
    expect(body).toMatch(/height:\s*100%/);
    // Matches only an actual `min-height:` declaration, not the word
    // appearing in this file's own explanatory comments.
    expect(body).not.toMatch(/min-height\s*:/);
  });

  it("keeps .main-shell free of a grid/track layout - sp-split-view's own shadow styles own pane sizing", () => {
    // mainSplitView.ts's primary-min/secondary-min attributes are the single
    // authority on how narrow either pane may get; a CSS grid track here
    // could silently disagree with the value that gets persisted.
    const body = findRuleBody(/\.main-shell\s*/, baseCss, 'base.css');
    expect(body).not.toMatch(/display:\s*grid/);
    expect(body).not.toMatch(/grid-template-columns/);
  });

  it('keeps .chat-transcript as the one designated internally-scrolling region in the main window', () => {
    const body = findRuleBody(/\.chat-transcript/, chatCss, 'chat.css');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/min-height:\s*0/);
  });

  it('stretches the empty-conversation prompt to the whole pane height, with no fixed row cap', () => {
    // The field is sized by `composer.ts` to whatever `.chat-composer__field`
    // is offered, so the frame and the field must both grow and be allowed to
    // shrink - dropping either `min-height: 0` would let the field's content
    // floor it instead of filling the pane.
    for (const selector of [
      /\.chat-pane--empty \.chat-composer__frame/,
      /\.chat-pane--empty \.chat-composer__field/,
    ]) {
      const body = findRuleBody(selector, chatCss, 'chat.css');
      expect(body).toMatch(/flex:\s*1 1 auto/);
      expect(body).toMatch(/min-height:\s*0/);
    }
  });
});
