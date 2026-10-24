---
name: search-component
description: Find the pages that use a given AEM component - the component-usage search. Load this instead of the `search` skill whenever a request pairs looking or searching with a component, such as "search pages containing <component>", "which pages use <component>" or "where is <component> used". Load it before acting - its body carries the exact resolution and search procedure (a plain phrase is a title to resolve against the component roots, never a resource type to invent), and the application then shows a two-column table (the owning page and the component's path within it) with no prose of your own. Use it whenever a request asks which pages use, contain, or are built with a component, or where one is used - including `/search-component <what>` and a request that also names the pages' template or another page property, since that filter only narrows the pages that contain the component. A request that only lists pages of a template or page type is `search-page`.
metadata:
  user-description: Find the pages that use a given component
table-only: true
---

# Finding the pages that use a component

**Start here - before any tool call.** The input is a component, never search
terms: do not pass it as `terms` to `aem_query_format_ask`, and do not call that
tool until step 1 has given you a resource type (it contains a `/`). Look at the
input: a value **with** a `/` is a resource type - go to phase A; a value
**without** one ("Product Module") is a title - your **first** tool call is the
phase B `aem_query` on `cq:Component`.

The job is: work out the component's **resource type**, then run **one search**
that shows the pages using it. There are two inputs, and only the first step
differs between them:

- a **resource type** (`myproject/components/content/content-block`, or the same
  with an `/apps` or `/libs` prefix), or
- a **title or name** (`Content Block`, `contentBlock`) - which must first be
  resolved to the real resource type.

The search runs through `aem_query_format_ask`, the same routine as `/search`:
one call queries, shows the table, and offers **Load more** until the user is
done. Resolve the component, make the one search call, and stop.

## Step 1 - resolve the component to its resource type

**A resource type is path-like - it contains at least one `/`**
(`myproject/components/content/content-block`,
`/apps/myproject/components/content/content-block`). **A value with no `/` in it -
"Media Library", "the content block", a single word - is a title or a name, not a
resource type**, and you must resolve it before searching. Never turn a phrase
into a resource type yourself by lower-casing it, hyphenating it or removing its
spaces: `media-library` is not a resource type until an AEM node says it is. A
guessed one yields a confident, empty answer ("no pages were found") that is
worse than searching.

Run the phases below in order, and never skip or merge them.

### Phase A - the value already has a `/` in it

It is a resource type; do not trust its prefix. An instance stores
`sling:resourceType` **either** relative to `/apps` or `/libs`
(`myproject/components/content/content-block`, the normal form) **or** as an
absolute path (`/apps/myproject/components/content/content-block`), and what you
have may be the other form from the one stored.

Search for **any** spelling (they become `property.1_value`, `property.2_value`,
... in step 2, ORed by QueryBuilder):

- starts with `/apps/` or `/libs/` -> the value itself, **and** the value with
  that prefix removed;
- otherwise -> the value itself, `/apps/<value>`, and `/libs/<value>`.

Go to step 2.

### Phase B - the value has no `/` (a title or a name)

You **must** resolve it; this step is not optional and not skippable. One
`aem_query` scans the host's **component roots** (from the current page context
block, default `/apps`) for a `cq:Component`. A component's *definition* is the
one thing that lives under the component roots - the pages that use it, in step
2, live under the content roots:

```json
{
  "predicates": {
    "type": "cq:Component",
    "property": "jcr:title",
    "property.operation": "like",
    "property.value": "%<the phrase>%"
  },
  "roots": ["<the host's component roots>"],
  "properties": ["jcr:title"]
}
```

`property.operation=like` is `jcr:like`, so `%<the phrase>%` matches it anywhere
in the title, ignoring spacing and case. Read the rows. Leave `limit` out: the
application chooses the page size.

**The resource type is the matched node's own path with its leading `/apps/` or
`/libs/` removed** - `/apps/myproject/components/content/content-block` is
`myproject/components/content/content-block`, and a node under `/libs` gives the
same relative form. Never hand a raw `jcr:path` to step 2 as if it were a
resource type.

- **Exactly one matched?** Go to step 2 with its resource type.
- **Several matched?** Do not choose for the user: call `ask_user` with one
  option per component, labelled `"<jcr:title> - <resource type>"` (the resource
  type alone when the title is absent), then go to step 2 with their choice.
- **None matched, or the match looks wrong?** Go to phase C.

### Phase C - the phrase did not resolve (only after phase B found nothing)

The title was not exact, so widen to a single distinctive word of the phrase,
matched by **title or node name** in an OR group:

```json
{
  "predicates": {
    "type": "cq:Component",
    "group.p.or": "true",
    "group.1_property": "jcr:title",
    "group.1_property.operation": "like",
    "group.1_property.value": "%<word>%",
    "group.2_nodename": "%<word>%"
  },
  "roots": ["<the host's component roots>"],
  "properties": ["jcr:title"]
}
```

Treat any match exactly as phase B (one -> step 2; several -> `ask_user`). If
this too finds nothing, ask the user for the resource type or another name with
`ask_user` (options or free input) - your own text is hidden, so a plain sentence
would never reach them - and go to step 2 only once they answer. Never search on
a guess.

If the user says the component is a stock one, it may live under `/libs`; scan
`/libs` explicitly when the host's component roots do not already include it.

**Before you go to step 2, check:** the resource type you are about to search for
contains a `/`. If it does not, you have not resolved the component - go back to
phase B.

## Step 2 - search the pages

The search must return the **component instances** themselves - that is the only
node that carries the component's own path. Make **one** `aem_query_format_ask`
call:

```json
{
  "predicates": {
    "type": "nt:unstructured",
    "property": "sling:resourceType",
    "property.1_value": "myproject/components/content/content-block",
    "property.2_value": "/apps/myproject/components/content/content-block"
  },
  "roots": ["<the host's content roots>"]
}
```

This step looks for component *instances*, which live on pages: it searches the
host's **content roots** (never the DAM roots - an asset is not a component
instance). If the request names a scope ("... under us/en"), use it as `roots`
instead, exactly as the user wrote it: `"roots": ["us/en"]`. The Scope rules in
your instructions cover the rest.

### Filtering by the page that owns the component

A request can narrow the pages as well as the component - most often by template.
Add `filters` beside `predicates`; the application applies each filter to the
**page that owns the component**, never to the component node, so a template or a
replication state keeps the instances on matching pages:

```json
{
  "predicates": {
    "type": "nt:unstructured",
    "property": "sling:resourceType",
    "property.1_value": "myproject/components/content/content-block",
    "property.2_value": "/apps/myproject/components/content/content-block"
  },
  "filters": [
    { "property": "cq:template", "value": "/conf/myproject/settings/wcm/templates/generic-page" }
  ],
  "roots": ["<the host's content roots>"]
}
```

The filters this skill offers:

| The request says | Add this filter |
| --- | --- |
| "on the <template> template", "on <template> pages" | `{ "property": "cq:template", "value": "<template path>" }` |
| published / activated / live | `{ "property": "cq:lastReplicationAction", "value": "Activate" }` |
| not published / unpublished / draft only | the same filter with `"negate": true` |
| modified after / before a date | `{ "property": "cq:lastModified", "operator": "after", "value": "<ISO date>" }` (or `before`) |
| another page property | `{ "property": "<content-node property>", "value": "<value>" }` |

- **A template named by title or name is not a path.** Load the `page-template`
  skill with the `skill` tool and follow it to resolve the phrase; never invent a
  path and never search for the title as text. A value that starts with `/` is
  already the path.
- Several templates are several `cq:template` filters that share a `group` label
  (the application ORs them).
- Publication state is defined once in your instructions' Publication state
  rules; use that filter rather than writing a replication property into
  `predicates` yourself.
- A property is named relative to the page's content node (`cq:template`,
  `cq:lastModified`), never `jcr:content/...`.
- Use a property only the page's content node carries (a template, a replication
  action, a modification date). A property a container inside the page also
  carries would match that container, not the page.
- A filter the application cannot apply exactly is refused, never dropped.

Pass **no** `properties`, and no other output argument. The table is exactly two
columns - **`Path`** (the owning page) and **`Node`** (the component node's path
within it) - and a `properties` list merely adds columns (such as an unwanted
`sling:resourceType` column). Do not add one. A page with several placements of
the component is listed once per placement, but its page path is written only on
the first of its rows: the empty cells below mean "the same page as the row
above" (the application does this - never repeat a page path yourself, and never
drop or renumber a row).

Why it is shaped this way:

- **The hits are the component instances, not the pages.** A `type=cq:Page` or
  `type=cq:PageContent` search with a `property.depth` reaches the page's content
  node and tells you nothing about *which* descendant matched - and a
  `cq:Page`-scoped depth search also descends into child pages, matching every
  ancestor. Querying the instance node directly needs no `depth` (the property is
  on the hit) and is index-served.
- **`property.1_value`, `property.2_value`, ...** carry the prefix variants from
  step 1 (all ORed).
- **The table shows each hit against its owning page.** Because the query matches
  a component by `sling:resourceType`, the table splits every hit at
  `/jcr:content/`: `Path` is the **page** that owns the component, and `Node` is
  the component node's path within that page (e.g. `jcr:content/root/text`). It
  is one row per component *placement*, so a page with several appears once per
  placement - its `Path` written only on the first of them and left blank below
  (still one numbered row each). This is automatic - there is no option to set.

A `property` predicate is served by an index or, failing that, by an Oak
traversal; on a large instance that does not index `sling:resourceType` the
search can be slow. Keep the scope as narrow as the question allows, and do not
retry a search that failed that way unchanged.

The call runs the query, paints the table of pages and their component paths, and
offers **Load more**. When it returns, the answer is on screen - do not repeat
the rows.

## Reporting

If the user must choose something (which component, or which resource type when
nothing matched), ask with `ask_user`; a plain sentence of yours is invisible.

When the search leaves an empty table, its total line says so. End the turn
there rather than explaining the search.
