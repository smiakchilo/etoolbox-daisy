---
name: check-page
description: MANDATORY for any request to audit, check, test or score a page - performance, accessibility, best practices, SEO - including "check the page performance", "accessibility score of this page", "SEO audit of <url>", "run lighthouse" and `/check-page <url>`. Load this skill BEFORE calling page_audit - it holds the one-call procedure, and page_audit paints the whole report itself, the scores and, for every issue, the evidence Lighthouse found. The scores always come from that tool, never from your own estimate.
metadata:
  user-description: Audit a page with Lighthouse for performance, accessibility and SEO
table-only: true
---

# Lighthouse check

The input is optional: a web address, or nothing (the page on screen). It may also name
the categories ("accessibility only") or a desktop run.

## Procedure

1. Call `page_audit` **once**. Pass `url` only when the user gave one. Pass `categories`
   only when the user narrowed them, and `formFactor: "desktop"` only when they asked for
   desktop. Do not retry a successful audit.
2. If the call fails with `select_server`, ask the user to open a page or pick a host and
   stop. Any other failure is reported in one sentence with the tool's own reason.
3. Add nothing. `page_audit` puts the whole report on screen itself: the score table,
   then one table per issue - every failed audit, and every performance insight
   Lighthouse measured a saving for - with the evidence it found: the failing
   elements with their selector and snippet, the insecure URLs, the deprecated APIs
   and where they are called, the console messages. Do not call `format_table`, do
   not repeat a score, an audit or a row, and write no summary or list around the
   tables.

## Discussing a failure

The user will often ask about a specific issue next. Answer from the evidence in the
`page_audit` result, which stays in the conversation:

- Name what failed and where: the element's selector, its snippet, or the file, line and
  column of a script that logged or used something.
- Give the fix that matches that evidence - the attribute to add, the element to replace,
  the heading level to use, the redirect to configure. When the evidence does not settle
  the cause, say which of the listed items you are guessing about.
- Do not run the audit again to answer a question, and do not re-read the tables into
  prose. Run it again only when the user changed the page and asked for a fresh check.

## Rules

- Use only what `page_audit` returned. Never invent a score, an audit or an element.
- The audit loads the page in a hidden window, so it can differ from what the user sees
  after signing in or interacting. Say nothing about this unless it explains a result.
