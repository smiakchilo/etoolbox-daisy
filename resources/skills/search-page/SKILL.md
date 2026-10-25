---
name: search-page
description: Find the pages built on a given page template or page component - the page-type search. Load this instead of the `search` skill whenever the thing the pages share is a template or a page resource type, such as "pages on the <name> template", "show me pages on <template title>", "which pages use template <path>", "pages created from <template>", "find pages of type <page component>" or "pages with sling:resourceType <x>". Both static and editable templates are supported, and a template may be given by path, name or title. Load it before acting - its body carries the exact procedure (a template name is looked up in the template list, never guessed or searched as free text), and the application then shows the table of pages with no prose of your own. Use it whenever the user asks which pages use or are based on a template or a page component, including when they invoke `/search-page <what>`. A request for pages that contain a component is `search-component`, not this skill.
metadata:
  user-description: Find the pages built on a given template or page type
table-only: true
---

# Finding the pages of a template or page type

**Start here - before any tool call.** The input is a template or a page type,
never search terms: do not pass it as `terms` to `aem_query_format_ask`. Look at
the input: a template given as a path (it starts with `/`) goes straight to step 3;
a template **name or title** means your **first** tool call is the step 1 template
listing; a page resource type is handled by step 2. Call `aem_query_format_ask` only
once you hold the template path and/or the resource type.

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

**Anything else is a name or title.** Load the `page-template` skill with the
`load_skill` tool and follow it: it lists the templates under `/conf` and `/apps`,
keeps the project's, matches the phrase and asks you when the choice is
ambiguous. Use the path (or paths) it gives you. Never search for the phrase as
text and never invent a path.

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

Make **one** `aem_query_format_ask` call over `cq:Page`, adding one filter for
each input you have. Filters on different properties are ANDed; filters that
share a `group` are ORed:

```json
{
  "predicates": { "type": "cq:Page" },
  "filters": [
    { "property": "cq:template", "value": "/conf/myproject/settings/wcm/templates/generic-page" },
    { "group": "page type", "property": "sling:resourceType", "value": "myproject/components/pages/page-generic" },
    { "group": "page type", "property": "sling:resourceType", "value": "/apps/myproject/components/pages/page-generic" }
  ],
  "roots": ["<the host's content roots>"]
}
```

Name a page property **relative to the page's content node**: `cq:template` and
`sling:resourceType`, never `jcr:content/cq:template`. Both spellings of a
resource type are two filters in one `group`, because a page stores either one.
Several templates are several `cq:template` filters sharing their own group
label.

Search the host's **content roots**; if the request names a scope ("... under
us/en"), use it as `roots` exactly as the user wrote it.

Rules for this call:

- `type` is always `cq:Page`. **Never** query `nt:unstructured` or `jcr:content`
  nodes - their hits are `.../jcr:content` paths, not pages.
- Pass **no** `properties`: the table is the `Path` column of the pages.
- Never write these property conditions into `predicates` yourself, and do not use
  `like`, `%` or `nodename` for a template or a resource type.
- When the request asks for published or not-published pages, add the filter the
  Publication state rules in your instructions name.
- On an instance that does not index these properties the search can be slow. Keep
  the scope as narrow as the question allows and do not retry a failed search
  unchanged.

The call runs the query, paints the table and offers **Load more**. When it
returns, the answer is on screen - do not repeat the rows.

## Reporting

If the user must choose something (which template, which page component), ask with
`ask_user`; a plain sentence of yours is invisible. An empty result says so in its
total line. End the turn there rather than explaining the search.
