---
name: navigate
description: How to open a page in the AEM browser pane when the user asks to go to, open, or navigate to a page - by host label, by a full or partial path, or by a page name or title. Resolve the host with environment_facts and the page with aem_query, disambiguate with ask_user, and open the result with browser_navigate. Use whenever the user says "open", "go to", "navigate to", or "show me" a page, including when they invoke `/navigate <what>`.
metadata:
  user-description: Open a page in the AEM browser pane.
---

# Navigating to a page

This skill is reached two ways, and the target is the same in both:

- **The user typed `/navigate <what>`.** The text after the directive is **your
  input for the turn** - the page to open. Do not ask the user to restate it.
- **You loaded this skill yourself** because the request is to open a page.

Either way, open the page. The whole job is: work out **which host** and **which
page**, then call `browser_navigate` once. If you cannot determine one of them,
say so and ask for a clearer instruction - never guess a path or a host.

## 1. Work out the host

The user may name an environment ("in HPE DEV", "on staging"), or name nothing
at all.

- **A host is named.** Call `environment_facts` and match the name against the
  configured hosts' **labels**. Match loosely but unambiguously: case-insensitive,
  and a label that clearly contains the name. If exactly one host matches, use it.
  If none match, or several do, do not guess - report the configured labels and
  ask which one is meant.
- **No host is named.** Use the host the browser pane is on, which the current
  page context block names. If there is no current host, call
  `environment_facts` and ask.

## 2. Work out the page

The user may give a **path**, a **page name**, or a **page title**.

### A path was given

Use it. A path may be full (`/content/wknd/us/en/resource-library`) or partial
(`us/en/resource-library`). A partial path is relative to a site or content
root, so make it absolute with `aem_query` (a `path` predicate) before opening
it. Turn the resolved content path into a browser path as described in
**Building the URL** below.

### A name or title was given

Resolve it on the **current** host with `aem_query`, scoped to that host's
content roots and `type=cq:Page`. Search the node **name** first, then the
**title**, trying the natural variants of the phrase:

- "home page" → node name `home`, then title `home`.
- "media library page" → node names `media-library`, `media_library`,
  `media%20library`, `media library`, then the title `media library`.

Use the `nodename` predicate for names and `fulltext` (with
`fulltext.relPath=jcr:content`) or a `property` predicate on
`jcr:content/jcr:title` for titles. If the first attempt returns nothing, try
the next variant; do not give up after one. Ask for a narrow `properties`
projection (`jcr:content/jcr:title`) so the result stays small.

## 3. Disambiguate

If the search returns **more than one** plausible page - the same page in
several locales, a draft and a live copy, two similarly named pages - do not
pick one. Call `ask_user` with one option per candidate, each labelled with its
title and its path, and open the one the user chooses. If it returns **no**
plausible page, say so and ask for a clearer path or name.

## 4. A page on a different host

`aem_query` and `aem_get_json` only read the host the browser pane is currently
on. So if the host you identified in step 1 is **not** the current host:

- If the user gave a **concrete path**, open it directly on that host with
  `browser_navigate` (pass `host` and `path`) - no search is needed.
- If the user gave a **name or title**, first move the pane to that host with
  `browser_navigate` (pass `host` and a path - the host root `/`, or the content
  root). The pane now shows that host, and this turn continues. Then re-read
  `environment_facts` and run the search from step 2 against the now-current
  host.

## 5. Building the URL

`browser_navigate` takes a **verbatim browser path** and joins it to the host's
own origin. You choose the form:

- A **content page's rendered view**: the JCR path plus `.html` -
  `/content/wknd/us/en/resource-library.html`.
- A **content page in the editor**: `/editor.html` plus the JCR path plus
  `.html` - `/editor.html/content/wknd/us/en/resource-library.html`. Use this
  when the user says "edit", "open in the editor", or similar.
- **Anything else on the host**: use it verbatim - `/crx/de`,
  `/system/console`, `/sites.html`.

Never include a scheme, host, or port - the application supplies the origin
from the configured host.

## 6. Open it

Call `browser_navigate` **once** with `host` (the configured label) and `path`.
On success it reports the URL it opened. If it reports a failure, relay the
reason to the user rather than retrying the identical call.

Do not open a page the user did not ask for, and do not use this to reach AEM by
any route other than a normal page load - the session remains read-only.
