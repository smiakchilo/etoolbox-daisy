---
name: search-component
description: Find the pages that use a given AEM component - the component-usage search. Load this instead of the `search` skill whenever a request pairs looking or searching with a component, such as "search pages containing <component>", "which pages use <component>", "find pages with <component>" or "where is <component> used", or any phrase where a component title or name is the thing to find. Load it before acting - its body carries the exact resolution and search procedure (a plain phrase is a title to resolve against the component roots, never a resource type to invent), and the application then shows a two-column table (the owning page and the component's path within it) with no prose of your own. Use whenever the user asks which pages use, contain, or are built with a component, or where a component is used - including when they invoke `/search-component <what>`.
metadata:
  user-description: Find the pages that use a given component.
---

# Finding the pages that use a component

The job is: work out the component's **resource type**, then run **one search**
that shows the pages using it. There are two inputs, and only the first step
differs between them:

- a **resource type** (`myproject/components/content/content-block`, or the same
  with an `/apps` or `/libs` prefix), or
- a **title or name** (`Content Block`, `contentBlock`) - which must first be
  resolved to the real resource type.

This skill is reached two ways, and the component is the same in both:

- **The user typed `/search-component <what>`.** The text after the directive is
  **your input for the turn**. Do not ask the user to restate it.
- **You loaded this skill yourself** because the request is to find where a
  component is used.

The search runs through `aem_query_format_ask`, the same routine as `/search`:
one call queries, shows the table, and offers **Load more** until the user is
done. Do not call `aem_query` or `ask_user` yourself to show the result, and do
not repeat the rows.

**Write no prose of your own.** The application hides your assistant text for
this turn - the table is the whole answer - so any summary, component
explanation, or list of paths you write is discarded. Resolve the component,
make the one search call, and stop.

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
block, default `/apps`) for a `cq:Component`:

```json
{
  "predicates": {
    "type": "cq:Component",
    "property": "jcr:title",
    "property.operation": "like",
    "property.value": "%<the phrase>%"
  },
  "roots": ["<the host's component roots>"],
  "properties": ["jcr:title"],
  "limit": 50
}
```

`property.operation=like` is `jcr:like`, so `%<the phrase>%` matches it anywhere
in the title, ignoring spacing and case. Read the rows.

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
  "properties": ["jcr:title"],
  "limit": 50
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
  "roots": ["<the host's content roots, or the root the user named>"]
}
```

Pass **no** `properties`, and no other output argument. The table is exactly two
columns - `Path` (the owning page) and `Component` (the node's path within it) -
and a `properties` list merely adds columns (such as an unwanted
`sling:resourceType` column). Do not add one.

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
  `/jcr:content/`: `Path` is the **page** that owns the component, and `Component`
  is the node's path within that page (e.g. `jcr:content/root/text`). It is one
  row per component *placement*, so a page with several appears once per
  placement. This is automatic - there is no option to set.
- **`roots`** default to the host's content roots when omitted; pass `roots` only
  when the user named a different scope. Never combine `roots` with a `path`
  predicate.

A `property` predicate is served by an index or, failing that, by an Oak
traversal; on a large instance that does not index `sling:resourceType` the
search can be slow. Keep the scope as narrow as the question allows, and do not
retry a search that failed that way unchanged.

The call runs the query, paints the table of pages and their component paths, and
offers **Load more**. When it returns, the answer is on screen - do not repeat
the rows.

## Reporting

The table is the answer, and the application hides your assistant text for this
turn - so write nothing around it: no summary, no explanation of the component,
no paths of your own. If the user must choose something (which component, or
which resource type when nothing matched), ask with `ask_user`; a plain sentence
of yours is invisible.

When the search leaves an empty table, its total line says so. End the turn
there rather than explaining the search.

## Read-only

You cannot change AEM. Never propose or attempt `/crx`, CRXDE, Package Manager,
the Sling POST servlet, `curl`, shell commands, files, or external tools. If the
user asks you to change content, say EToolbox Daisy is read-only.
