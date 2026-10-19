---
name: search-page
description: Find the pages built on a given page template or page component - the page-type search. Load this instead of the `search` skill whenever the thing the pages share is a template or a page resource type, such as "pages on the <name> template", "show me pages on <template title>", "which pages use template <path>", "pages created from <template>", "find pages of type <page component>" or "pages with sling:resourceType <x>". Both static and editable templates are supported, and a template may be given by path, name or title. Load it before acting - its body carries the exact procedure (a template name is looked up in the template list, never guessed or searched as free text), and the application then shows the table of pages with no prose of your own. Use it whenever the user asks which pages use or are based on a template or a page component, including when they invoke `/search-page <what>`. A request for pages that contain a component is `search-component`, not this skill.
metadata:
  user-description: Find the pages built on a given template or page type
---

# Finding the pages of a template or page type

The job: identify the **template path** and/or the **page resource type**, then make
**one** `aem_query_format_ask` call over `cq:Page`. Inputs, any of which may be
given (several are combined with AND):

- a **template** - a path (`/conf/myproject/settings/wcm/templates/generic-page`),
  or a name or title (`UC Basic`, `generic-page`), static or editable;
- a **page resource type** (`myproject/components/pages/page-generic`, with or
  without an `/apps` or `/libs` prefix).

Three things are easy to confuse. Keep them apart:

- a **template** is a `cq:Template` node, under `/conf/.../templates/` (editable) or
  `/apps/.../templates/` (static) - its path is what a page stores in `cq:template`;
- a **page component** lives under the component roots, usually in a `.../pages/`
  folder - its resource type is what a page stores in `sling:resourceType`;
- a **page** is a `cq:Page` node under the content roots. The pages are the answer.

Never answer with templates or components: the table must list **pages**.

## Step 1 - find the template (only when one was given)

**A value that starts with `/`** is already a template path - go to step 3.

**Anything else is a name or title.** Do not search for it as text and do not
invent a path. List the templates and pick from the list - one `aem_query` call
exactly like this, changing nothing:

```json
{
  "predicates": { "type": "cq:Template" },
  "roots": ["/conf", "/apps"],
  "properties": [
    "jcr:content/jcr:title",
    "structure/jcr:content/sling:resourceType",
    "jcr:content/sling:resourceType"
  ],
  "limit": 200
}
```

Then read the rows yourself:

- **Ignore** every row whose path contains `/template-types/` - those are not
  templates.
- **Keep the project's templates.** A template belongs to the project when its
  page resource type (`structure/jcr:content/sling:resourceType` for an editable
  template, `jcr:content/sling:resourceType` for a static one) lies under one of
  the host's **component roots** (from the current page context block, default
  `/apps`). A resource type is stored relative (`myproject/components/...`) or
  absolute (`/apps/myproject/components/...`), so compare both spellings against a
  root such as `/apps/myproject`. If this leaves nothing, keep every template.
- **Match the phrase** against each kept template's node name (the last path
  segment) and its `jcr:title`, ignoring case, spaces, hyphens, underscores and
  the words "template" and "page". `UC Basic` matches `hpe-uc-basic`.

Then:

- **Exactly one match?** Use its path.
- **Several?** Do not choose for the user: call `ask_user` with one option per
  template, labelled `"<jcr:title> - <path>"`, plus an `All of them` option.
- **None?** Call `ask_user` (free input) for another name or a template path -
  your own text is hidden. Never search on a guess.

## Step 2 - page resource type (only when one was given)

A resource type is path-like - it contains at least one `/`. A value without a `/`
is a page component's title or name: find it with one `aem_query`
(`type=cq:Component`, `fulltext=<the phrase>`, roots = the component roots,
`properties` = `jcr:title`), pick the component whose path contains `/pages/` or
whose title says "page", and use its path without the leading `/apps/` or `/libs/`.
Several candidates -> `ask_user`. Never lower-case, hyphenate or invent one.

When only a **template** was given, you need no resource type: the template's path
alone selects its pages.

A stored resource type is relative **or** absolute, so use every spelling: for a
value starting with `/apps/` or `/libs/`, the value and the value with that prefix
removed; otherwise the value, `/apps/<value>` and `/libs/<value>`.

## Step 3 - search the pages

Make **one** `aem_query_format_ask` call. Include a property group only for an
input you have. The groups are ANDed; the values inside a group are ORed:

```json
{
  "predicates": {
    "type": "cq:Page",
    "1_property": "jcr:content/cq:template",
    "1_property.1_value": "/conf/myproject/settings/wcm/templates/generic-page",
    "2_property": "jcr:content/sling:resourceType",
    "2_property.1_value": "myproject/components/pages/page-generic",
    "2_property.2_value": "/apps/myproject/components/pages/page-generic"
  },
  "roots": ["<the host's content roots>"]
}
```

Several templates are further `1_property.N_value` entries. Search the host's
**content roots**; if the request names a scope ("... under us/en"), use it as
`roots` exactly as the user wrote it.

Rules for this call:

- `type` is always `cq:Page`. **Never** query `nt:unstructured` or `jcr:content`
  nodes - their hits are `.../jcr:content` paths, not pages.
- Pass **no** `properties`: the table is the `Path` column of the pages.
- Keep the property paths exactly as shown: `jcr:content/cq:template` and
  `jcr:content/sling:resourceType`. Do not use `like`, `%` or `nodename`.
- On an instance that does not index these properties the search can be slow. Keep
  the scope as narrow as the question allows and do not retry a failed search
  unchanged.

The call runs the query, paints the table and offers **Load more**. When it
returns, the answer is on screen - do not repeat the rows.

## Reporting

If the user must choose something (which template, which page component), ask with
`ask_user`; a plain sentence of yours is invisible. An empty result says so in its
total line. End the turn there rather than explaining the search.
