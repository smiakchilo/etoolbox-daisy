---
name: navigate
description: MANDATORY for any request to open, load, go to, goto, navigate to, show, or take the user to a page, asset, or AEM place (any language) - load this skill BEFORE calling browser_navigate. Examples - Show news-library page, Load my-first-page, Go to package manager, Goto crx/de, Open bundles, Load this page in admin, Open my_page in sites console, Navigate to page properties, Open us/en/some-page on localhost in edit mode. Covers environment qualifiers (in Acme Dev, on localhost), display modes (edit, sites console or admin, crx, assets, properties) and standard places (crx/de, package manager, config manager, bundles, system console). Holds the rules you would otherwise get wrong - the words are a page NAME to search for, never a description of it, host is a configured label never a URL, admin means the sites console, and a page name is found with aem_query, never guessed as a path. Also used for /navigate <what>.
metadata:
  user-description: Open a page in the AEM browser pane
---

# Opening a page, asset, or place in the browser pane

Open what the user asked for. The whole job is: work out **which host**, **which page,
asset or place**, and **which display mode**, then call `browser_navigate`
**once**. If you cannot determine one of them, say so and ask for a clearer
instruction - never guess a path or a host.

**Words are a name, never a description.** What the user types after "open"
or "go to" is the **name** of something - match it literally, exactly as
written - not a characterisation of what they are after. "Media-library page"
is a page *named* `media-library`, not "something about media"; "the home page" is a page named `home`,
not the locale root or the site's front page; `qa-space-ai` is a name, not a
topic. Never reason about what a page is "probably" or "sort of" - search the
name. Only when every exact search below found nothing may the words be used
as a loose hint, and even then you only **ask** (see "The words as a hint").

**Search, never assume.** A page or asset the user names - "the home page",
"elastic browser", "qa-space-ai", "the hero image" - is always found by
**searching**, never by inferring a path from it. A bare token like
`qa-space-ai` is a **name to search**, not a path, however path-like it
looks. If the user did not literally write a path, you have not been given
one. The only paths you may ever hand to `browser_navigate` are a path the
user literally wrote, a `place` from section 2, and a
`jcr:path` copied from a query result in this same turn. That a site
"usually" keeps its home at `/content/<site>/us/en`, or that a name
resembles a path, changes nothing: run the phases and open what they return.
`/content/<site>/us/en` is a guess, not a home page - and a guessed path is
wrong as often as it is right.

## 1. Read the prompt

Split the request into:

- the **target** - the page, asset or place to open, by name;
- **qualifiers** - trailing phrases introduced by "in", "on" or "at".

Test **every qualifier in this exact order**:

1. **Environment reference first.** Call `environment_facts` and match the
   phrase against the configured hosts - against a host's **label** ("HPE
   DEV") or its **origin's host and port** ("localhost", "localhost:4502"),
   case-insensitively and loosely but unambiguously: the phrase names the
   label, or the host, or a distinctive part of one. Exactly one host
   matches -> that is the environment; remember its **label** to pass as
   `host` to `browser_navigate`. No host matches -> the phrase is not an
   environment reference; continue to 2. Several hosts match -> do not
   choose: list the configured labels and origins and ask which one is
   meant.
2. **Display mode second.** Match the phrase against the display-mode
   vocabulary below ("in edit mode", "in sites console", "in crx de", ...).
3. **Scope third.** A phrase that names *where to look* - a path or section
   such as `us/en`, `jp/ja`, "the blueprint site" - is a **scope**, not part
   of the name and not a page to open. "Home page in us/en" is the page named
   `home`, looked for inside `us/en`. Remember it; section 3 applies it.

Any kind can be present, and each qualifier is tested independently in
this order: "Open qa-space-ai on localhost in edit mode" has one environment
qualifier and one display-mode qualifier. A qualifier that matches none of
the three stays part of the target - search it, do not guess at it.

If no environment qualifier is present, use the host the browser pane is on,
which the current page context block names. If there is no current host,
call `environment_facts` and ask.

### The display-mode vocabulary

| The user says | `mode` |
| --- | --- |
| nothing - "open", "load", "show" plainly | omit the mode |
| "edit mode", "editor", "in the editor" | `edit` |
| "sites console", "sites", "admin" (AEM's own menu reads "Open in Admin") | `sites` (`admin` is an accepted alias) |
| "assets console", "assets", "dam" | `assets` |
| "crxde", "crx de", "crx" | `crxde` |
| "asset editor", "asset details" | `asset_details` |
| "properties", "page properties" | `properties` |

A display-mode qualifier attaches to a named page or asset: "open
qa-space-ai in sites console" is the page **qa-space-ai** shown in the Sites
console. When no page or asset is named - "navigate to the sites console" -
the phrase is a **standard place**, not a display mode; see section 2.

## 2. Standard places open directly

When the target is one of these places (and no page or asset is named), no
search and no mode is needed: call `browser_navigate` with `host` (when an
environment was named) and `place` - the application owns the path, so never
type one.

| The user says | `place` |
| --- | --- |
| "crx/de", "crxde", "crx de", "repository browser" | `crxde` |
| "package manager", "packages", "packmgr" | `package_manager` |
| "sites console", "sites", "admin", "siteadmin" | `sites` |
| "assets console", "dam console" | `assets` |
| "system console", "osgi console", "felix console" | `system_console` |
| "config manager", "configmgr", "osgi config" | `config_manager` |
| "bundles", "osgi bundles" | `bundles` |
| "components", "osgi components" | `osgi_components` |
| "logs", "sling logs", "logging" | `sling_logs` |
| "jmx" | `jmx` |

The phrases are examples, not a keyword list: the user's words may be in any
language. But a place is chosen **only when the user names the tool or
console itself** ("package manager", "crx/de", "bundles"). A page name is
never a place, however related it sounds: "media-library page" is not the
Assets console, "components page" is not the OSGi components console. When
unsure whether a name is a tool or a page, search for the page first.
## 3. Work out the page or asset

The user may give a **path**, a **name**, or a **title**. A given path is
used directly; a name or title is resolved by the strict, ordered phases
below. Run the phases in order and never skip or merge them.

### A path was given

Use it. A path may be full (`/content/wknd/us/en/resource-library`) or
partial (`us/en/resource-library`). A partial path is relative to a site or
content root, so make it absolute with `aem_query` (a `path` predicate)
before opening it, then go to **Open it** below. A given path needs no
name/title search.

A path is the thing to open **only when it is the whole target**. When a name
is given too - "home page in `us/en`" - the name is the target and the path
is only the **scope** from section 1: search the name, then keep the
candidates whose `jcr:path` contains the scope as consecutive segments
(`/us/en/`). Never open the scope itself instead of searching the name.

Treat this as a path **only** when the user actually wrote path-like text -
segments separated by `/`. A name is not a path, however obvious the site's
structure looks: "the home page" is a name to search for, not
`/content/<site>/us/en`, and `qa-space-ai` is a name to search for, not a
path under `/content`.

### A name or title was given

Build the **name patterns** from the phrase first. Replace every run of
spaces, hyphens or underscores with a single `*`, then wrap the whole thing in
`*` ... `*`. `*` is the `nodename` wildcard - it stands for any or no
characters - so the pattern *contains* the phrase. `"Elastic Browser"` and
`"elastic_browser"` both become `*elastic*browser*`, which matches
`elastic-browser`, `elastic_browser`, `new-elastic_browser`,
`elastic-browser2` and `elastic browser` alike. A file name keeps its dot:
`hero.jpg` becomes `*hero*jpg*`. It is not a regex.

**Names and titles are matched without regard to case** - `Media_Library`,
`media-library` and `MEDIA LIBRARY` are the same name. Query Builder's
`nodename` pattern and `like` comparison are not guaranteed to ignore case, so
make every name or title search case-insensitive yourself: build **each
pattern in up to four case forms** - all lower case, all UPPER case, each
word Capitalised, and as the user wrote it - drop duplicates, and OR them in
one `group.p.or` (the JSON below shows it). Fold case the way the user's own
alphabet does (this works for any language). Full-text search (Phase C) is
already case-insensitive and needs no variants.

A generic trailing word - "page", "screen" - is **not** part of the name: "the
home page" is searched as `*home*`, and "Go to elastic browser page" as
`*elastic*browser*`.

Then run the phases in order, and enter the next phase **only** when the
current one found nothing. **Pages first** - unless the display mode is
`assets` or `asset_details`, which says the target is an asset and the asset
phases run first. Whichever set runs first falls through to the other set
only when its own phases all found nothing.

A **failed** query (an error result) is **not** an empty result - relay the
failure; do not treat it as "no match" and do not silently fall through.

#### Page phases

**Phase A - the node name.** One `aem_query` for the whole name pattern in
its case forms, scoped to the host's content roots (from the current page
context block, or `environment_facts`):

```json
{
  "predicates": {
    "type": "cq:Page",
    "group.p.or": "true",
    "group.1_nodename": "*elastic*browser*",
    "group.2_nodename": "*ELASTIC*BROWSER*",
    "group.3_nodename": "*Elastic*Browser*"
  },
  "roots": ["<the host's content roots>"],
  "properties": ["jcr:content/jcr:title"]
}
```

Run it once with no `limit`; do **not** page through it. The first call is
enough to tell one match from many, and the disambiguation step lists exactly
the rows this call returned. Never use `fulltext` in Phase A: a full-text
search finds pages that merely *mention* the words and is not the name search
the user asked for.

**Phase B - the page title** (only when the name found nothing). Search the
spaced phrase in the title, in the same case forms, ORed over
`jcr:content/jcr:title` and `jcr:content/pageTitle` (two properties times the
case forms - one `group.N_property` triple each):

```json
{
  "predicates": {
    "type": "cq:Page",
    "group.p.or": "true",
    "group.1_property": "jcr:content/jcr:title",
    "group.1_property.operation": "like",
    "group.1_property.value": "%elastic%browser%",
    "group.2_property": "jcr:content/jcr:title",
    "group.2_property.operation": "like",
    "group.2_property.value": "%Elastic%Browser%",
    "group.3_property": "jcr:content/jcr:title",
    "group.3_property.operation": "like",
    "group.3_property.value": "%ELASTIC%BROWSER%",
    "group.4_property": "jcr:content/pageTitle",
    "group.4_property.operation": "like",
    "group.4_property.value": "%elastic%browser%",
    "group.5_property": "jcr:content/pageTitle",
    "group.5_property.operation": "like",
    "group.5_property.value": "%Elastic%Browser%",
    "group.6_property": "jcr:content/pageTitle",
    "group.6_property.operation": "like",
    "group.6_property.value": "%ELASTIC%BROWSER%"
  },
  "roots": ["<the host's content roots>"],
  "properties": ["jcr:content/jcr:title", "jcr:content/pageTitle"]
}
```

`property.operation=like` is `jcr:like`: `%` stands for any characters, so
`%elastic%browser%` matches the phrase anywhere in either title property,
with any separator.

**Phase C - full text** (only when the name and title found nothing). One
`aem_query` with `"predicates": { "type": "cq:Page", "fulltext": "elastic browser" }`,
the same roots and `"properties": ["jcr:content/jcr:title"]`. This is
the broadest phase - it matches pages that merely mention the words - so reach
it only when the name and title searches found nothing.

#### Asset phases

The same three phases over **assets** - `dam:Asset` nodes - scoped to the
host's **DAM roots** (from the current page context block; the default is
`/content/dam`):

- **The asset name** (always first): the name pattern in its case forms,
  `"predicates": { "type": "dam:Asset", "group.p.or": "true", "group.1_nodename": "*hero*jpg*", "group.2_nodename": "*Hero*Jpg*", "group.3_nodename": "*HERO*JPG*" }`,
  `"properties": ["jcr:content/metadata/dc:title"]`.
- **The asset title** (only when the name found nothing): the spaced phrase
  against the asset's title - `"property": "jcr:content/metadata/dc:title"`,
  `"property.operation": "like"`,
  `"property.value": "%<the phrase>%"` - once per case form, ORed in a
  `group.p.or` as in Phase B - with `"type": "dam:Asset"`, the DAM roots and
  `"properties": ["jcr:content/metadata/dc:title"]`.
- **Asset full text** (only when both found nothing): `"type": "dam:Asset"`
  with `"fulltext": "<the spaced phrase>"` and the DAM roots.

#### Disambiguation - never choose for the user

- **A scope was given (section 1)?** Narrow first: keep only the candidates
  whose `jcr:path` contains the scope as consecutive segments, ignoring case. If the search
  reported more rows than it returned (`hasMore`) and none survive, fetch
  the next page (`offset`) - at most three more - before concluding there
  is none. The scope is the user's own constraint, so narrowing by it is not
  choosing for them.
- **Exactly one candidate -> open it** (**Open it** below).
- **More than one candidate -> you MUST call `ask_user` with an option for
  every candidate you retrieved.** Pass the whole list, one option per row,
  each labelled `"<title> - <jcr:path>"` (the path alone when the title is
  absent; trim the title if the label would overrun the option length
  limit). Never sample, never pick a "representative" subset, and never ask
  the user to narrow instead of listing. The composer renders more than five
  options as a dropdown that holds them all, so a long list is expected -
  not a reason to trim it.

Do not pick the "best" match, the one on the current page, the one in the
"right" locale, or the one that looks most plausible. Do not open anything
before the answer comes back - not even the first candidate.

If the matching search returned fewer rows than it reported (`hasMore` is
`true` or `"unknown"`), add `freeInput: true` so the user can type a path
that is not in the list, and say in the question that the list covers the
first matches. Still list every row you retrieved.

#### The words as a hint - only after every exact search found nothing

Only when the page phases, the asset phases and (if given) the scope have
**all** found nothing, you may read the user's words loosely - a likely
spelling variant, a synonym, a neighbouring name. Even then **never open
anything**: tell the user that nothing is named as they wrote it, and call
`ask_user` with your best guesses (each found by a query, each labelled
with its `jcr:path`) and `freeInput: true`. If you have no guess worth
offering, ask for a clearer name or path. Open nothing until they answer.

### The path you open is copied, never composed

`browser_navigate`'s `path` **must be copied character-for-character from
the `jcr:path` of a row returned earlier in this same turn** (or be a path
the user literally wrote, or a `place` from section 2). When
you resolved a display mode, pass that same raw `jcr:path` together with
the `mode` - the application builds the browser URL from them. Never type a
path from memory, from the current page, or from a guess.

## 4. A page on a different host

`aem_query` and `aem_get_json` only read the host the browser pane is
currently on. So if the host you identified in section 1 is **not** the
current host:

- If the user gave a **concrete path**, or the target is a **standard
  place**, open it directly on that host with `browser_navigate` (pass
  `host` and the path or `place`, plus the `mode` when one was resolved) - no search
  is needed.
- If the user gave a **name or title**, first move the pane to that host
  with `browser_navigate` (pass `host` and a path - the host root `/`, or
  the content root). The pane now shows that host, and this turn continues.
  Then re-read `environment_facts` and run the search from section 3
  against the now-current host. Never invent a path on the target host and
  navigate straight to it - switching is only half the job; the search is
  the other half.

## 5. Building the URL

You never write a full URL, and with a display mode you never shape the
path either - `browser_navigate` takes a path and, when a display mode was
resolved, a `mode`, and **the application builds the browser URL**:

- **A display mode was resolved.** Pass the raw `jcr:path` in `path` and the
  `mode` value from section 1. The application owns every `.html` rule -
  never append or strip `.html` yourself when a mode is set:

  - `view` - the rendered page (`/content/wknd.html`);
  - `edit` - the page editor (`/editor.html/content/wknd.html`);
  - `sites` - the Sites console, **with no `.html`**
    (`/sites.html/content/hpe/languages/jp-apj/home`);
  - `assets` - the Assets console, also with no `.html`
    (`/assets.html/content/dam/brand`);
  - `crxde` - CRX/DE Lite with the node selected
    (`/crx/de/index.jsp#<the path>`);
  - `asset_details` - the DAM asset editor
    (`/assetdetails.html/content/dam/brand/hero.jpg`);
  - `properties` - the page-properties console.

- **No display mode.** Pass the raw page `jcr:path` - the application appends `.html` when it is needed - or, for a path the user literally wrote, that path verbatim. A standard place is never a path: use `place` (section 2).

Never include a scheme, host, or port - the application supplies the origin
from the configured host. Never pass a query or fragment with a mode - a
raw repository path carries none.

## 6. Open it

Call `browser_navigate` **once** with `host` (the configured **label**, never a URL),
`path` or `place`, and, when one was resolved, `mode`. On success it reports the URL it
opened. If it reports a failure, relay the reason to the user rather than
retrying the identical call.

Do not open a page the user did not ask for.
