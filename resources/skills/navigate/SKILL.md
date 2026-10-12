---
name: navigate
description: How to open a page in the AEM browser pane when the user asks to go to, open, or navigate to a page - by host label, by a full or partial path, or by a page name or title. Resolve the host with environment_facts, then resolve a name or title with aem_query in strict order - a node-name contains pattern first, then the page title, then a full-text search - and when more than one page matches, always disambiguate with ask_user rather than choosing; open the result with browser_navigate. Use whenever the user says "open", "go to", "navigate to", or "show me" a page, including when they invoke `/navigate <what>`.
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

The user may give a **path**, a **page name**, or a **page title**. A given path
is used directly; a name or title is resolved by the strict, ordered phases
below. Run the phases in order and never skip or merge them.

### A path was given

Use it. A path may be full (`/content/wknd/us/en/resource-library`) or partial
(`us/en/resource-library`). A partial path is relative to a site or content
root, so make it absolute with `aem_query` (a `path` predicate) before opening
it, then go to **Open it** below. A given path needs no name/title search.

### A name or title was given

Build the **name pattern** from the phrase first: lower-case it, replace every
run of spaces, hyphens or underscores with a single `*`, then wrap the whole
thing in `*` ... `*`. `*` is the `nodename` wildcard - it stands for any or no
characters - so the pattern *contains* the phrase. `"Elastic Browser"` and
`"elastic_browser"` both become `*elastic*browser*`, which matches
`elastic-browser`, `elastic_browser`, `new-elastic_browser`, `elastic-browser2`
and `elastic browser` alike. It is not a regex.

Then run the phases in order, and enter the next phase **only** when the current
one found nothing.

#### Phase A - the node name (always first)

Run **one `aem_query`** for the whole name pattern, scoped to the current host's
content roots (from the current page context block, or `environment_facts`):

```json
{
  "predicates": { "type": "cq:Page", "nodename": "*elastic*browser*" },
  "roots": ["<the host's content roots>"],
  "properties": ["jcr:content/jcr:title"],
  "limit": 50
}
```

Page through it with `offset` while `pagination.hasMore` is `true` or
`"unknown"`.

- **Any rows -> that is the candidate set. Go to Phase D.**
- **No rows -> go to Phase B.**

Never use `fulltext` in Phase A: a full-text search finds pages that merely
*mention* the words and is not the name search the user asked for. A **failed**
query (an error result, for example an unindexed `nodename` traversal that AEM
aborted) is **not** an empty result - relay the failure; do not treat it as "no
match" and do not silently fall through.

#### Phase B - the page title (only when Phase A found nothing)

Search the **spaced** phrase in the page's title. Run one `aem_query`, scoped to
the current host's content roots:

```json
{
  "predicates": {
    "type": "cq:Page",
    "group.p.or": "true",
    "group.1_property": "jcr:content/jcr:title",
    "group.1_property.operation": "like",
    "group.1_property.value": "%elastic%browser%",
    "group.2_property": "jcr:content/pageTitle",
    "group.2_property.operation": "like",
    "group.2_property.value": "%elastic%browser%"
  },
  "roots": ["<the host's content roots>"],
  "properties": ["jcr:content/jcr:title", "jcr:content/pageTitle"],
  "limit": 50
}
```

`property.operation=like` is `jcr:like`: `%` stands for any characters, so
`%elastic%browser%` matches the phrase anywhere in either title property, with
any separator.

- **Any rows -> that is the candidate set. Go to Phase D.**
- **No rows -> go to Phase C.**

#### Phase C - full text (only when Phase A and Phase B found nothing)

The name and the title both came back empty, so fall back to a full-text search
of the spaced phrase, scoped to the current host's content roots:

```json
{
  "predicates": { "type": "cq:Page", "fulltext": "elastic browser" },
  "roots": ["<the host's content roots>"],
  "properties": ["jcr:content/jcr:title"],
  "limit": 50
}
```

This is the broadest phase - it matches pages that merely mention the words -
so reach it only when the name and title searches found nothing.

- **Any rows -> that is the candidate set. Go to Phase D.**
- **Still nothing -> report that no page matched and ask for a clearer name or
  path. Open nothing.**

#### Phase D - never choose for the user

- **Exactly one candidate -> open it** (**Open it** below).
- **More than one candidate -> you MUST call `ask_user`.** Build one option per
  candidate and label it `"<title> - <jcr:path>"` (omit the title when it is
  absent). Every candidate from the matching phase must appear in the list, one
  option each, none omitted. Open **only** the option the user chooses.

Do not pick the "best" match, the one on the current page, the one in the
"right" locale, or the one that looks most plausible. Do not open anything
before the answer comes back - not even the first candidate. If more than 50
candidates match (the `ask_user` limit), do not silently truncate the list:
report the count and ask the user to narrow the phrase.

### The path you open is copied, never composed

`browser_navigate`'s `path` **must be copied character-for-character from the
`jcr:path` of a row returned earlier in this same turn** (then turned into a
browser path per **Building the URL**). Never type a path from memory, from the
current page, or from a guess.

## 3. A page on a different host

`aem_query` and `aem_get_json` only read the host the browser pane is currently
on. So if the host you identified in step 1 is **not** the current host:

- If the user gave a **concrete path**, open it directly on that host with
  `browser_navigate` (pass `host` and `path`) - no search is needed.
- If the user gave a **name or title**, first move the pane to that host with
  `browser_navigate` (pass `host` and a path - the host root `/`, or the content
  root). The pane now shows that host, and this turn continues. Then re-read
  `environment_facts` and run the search from step 2 against the now-current
  host.

## 4. Building the URL

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

## 5. Open it

Call `browser_navigate` **once** with `host` (the configured label) and `path`.
On success it reports the URL it opened. If it reports a failure, relay the
reason to the user rather than retrying the identical call.

Do not open a page the user did not ask for, and do not use this to reach AEM by
any route other than a normal page load - the session remains read-only.
