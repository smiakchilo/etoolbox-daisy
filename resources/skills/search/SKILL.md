---
name: search
description: MANDATORY for any request to find, search for, look up, list or show AEM pages, files, images, assets or other content - including a request that names a kind, type or format instead of a word ("Find all JPG images", "List the PDFs", "Show me the videos", "Find pages containing Waldo", "Search for Greenlake") and any request invoking `/search <terms>`. Load this skill BEFORE calling aem_query or aem_query_format_ask, and never run those tools directly for such a request - the skill holds the one-call procedure and the table rules. For content by meaning or description rather than by a word, type or path, use the `semantic-search` skill instead. When the request is to find the pages that use or contain a component (a component named by title, name, or sling:resourceType), that is the `search-component` skill, not this one; to find pages built on a template or page type, use `search-page`. Do not load it merely to explain a result that already came back; that is the query-results skill.
metadata:
  user-description: Find pages and assets by their content
---

# Running an AEM search

`aem_query` takes `predicates`: a flat map of QueryBuilder predicate keys to
string values. The application always targets the QueryBuilder endpoint on the
currently selected AEM instance — you never supply an endpoint, and you never
supply a query language. QueryBuilder predicates are the only query syntax
available here; do not write SQL2, JCR-SQL, XPath, or GraphQL.

All predicate values are strings, including numbers and booleans.

## A plain-term search

The search string is the user's request, or the text after `/search`. If the
request has no searchable terms at all, then - and only then - ask what to
search for with a normal `ask_user` question (options or free input), not with
`actions`.

**Make exactly one call: `aem_query_format_ask`, with the search string as `terms`
and the roots its subject calls for as `roots`** (the Scope rules in your
instructions name the family):

```json
{ "terms": "<search string>", "roots": ["<the host's content roots>"] }
```

`/search Waldo` names no kind of content, so it searches the **content roots**
(pages and their content). When the request is about **files or assets**, pass
the host's **DAM roots** instead; when it asks for both kinds, pass both
families. The host's content, component and DAM roots are all listed in the
current-page context block at the start of the prompt - never invent or complete
one.

If the request names a scope ("... under us/en"), keep it out of the search string
and use it as `roots` instead of the family, exactly as the user wrote it:
`{ "terms": "<search string>", "roots": ["us/en"] }`. The Scope rules in your
instructions cover the rest.

If the request is about published or not-published content, keep that out of the
search string too and add `publication` (the Publication state rules in your
instructions): `{ "terms": "<search string>", "roots": [...], "publication":
"published" }`. The search then returns pages and assets only.

That one tool does the whole search: it runs `aem_query` (full text, one page at
a time), shows the page as the chat's table, and while more results may exist
offers the user a **Load more** button, loading and appending the next page on
each click. When it returns, the table is on screen and the user is done.

### Hand-built queries

A plain term uses `terms` above. For anything more specific - a concrete path,
a property value, a type, a date or numeric range, an ordering - build the
predicate map yourself as the rest of this skill describes, and make the same
one call with it as `predicates` instead of `terms`:

```json
{
  "predicates": { "type": "cq:Page", "fulltext": "<search string>" },
  "roots": ["<the host's content roots>"]
}
```

`aem_query_format_ask` validates the map exactly as `aem_query` does and runs the
same table and **Load more** loop, with the same `roots` discipline as above.
Never pass both `terms` and `predicates`. Leave `properties` out (see "Leave the
table's columns alone"). `publication` works with hand-built predicates only when
they set `type` to `cq:Page` or `dam:Asset`.

## Always scope

An unscoped query scans the whole repository and is slow enough to time out, so
always give a scope: the `roots` the subject calls for (the Scope rules in your
instructions name the family), or a `path` predicate. `aem_query_format_ask` has
a default, but it is broader than most searches need.

Several roots are covered in one call - one query per root, rows merged:

```json
{
  "predicates": { "type": "cq:Page" },
  "roots": ["/content/wknd", "/content/shared"]
}
```

- The page size applies to each root.
- Never combine `roots` with a `path` predicate - that is rejected.

When the user names a concrete path (or says "here" or "this page", meaning the page
in the current page context), a `path` predicate is correct and is one request:

```json
{
  "path": "/content/wknd",
  "type": "cq:Page"
}
```

Use `path.exact=true` to match one node rather than a subtree, and
`path.self=true` to include the starting node itself.

## Common predicates

| Goal                  | Predicates                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| Node type             | `type` = `cq:Page`, `dam:Asset`, `nt:unstructured`, ...                                                        |
| Property equals       | `property` = `jcr:content/cq:template`, `property.value` = `...`                                               |
| Property exists       | `property` = `...`, `property.operation` = `exists`                                                            |
| Property is absent    | `property` = `...`, `property.operation` = `not`                                                               |
| Any of several values | `property.1_value`, `property.2_value`, ...                                                                    |
| Full text             | `fulltext` = `search terms`, `fulltext.relPath` = `jcr:content`                                                |
| Node name             | `nodename` = `*-draft`                                                                                         |
| Date range            | `daterange.property` = `jcr:content/cq:lastModified`, `daterange.lowerBound` = `2024-01-01T00:00:00.000+00:00` |
| Numeric range         | `rangeproperty.property` = `...`, `rangeproperty.lowerBound` = `10`                                            |
| Ordering              | `orderby` = `@jcr:content/cq:lastModified`, `orderby.sort` = `desc`                                            |

Property paths are relative to the matched node, so page properties usually
live under `jcr:content/`.

## Prefer predicates an index can serve

`fulltext` and `type` are answered from an index. `property`, `nodename`,
`range` and `daterange` are served by a *property index* an instance may not
have, and a bare `path` scope is not indexed either. When no index can serve the
query, AEM walks the repository - or the whole `path` subtree - instead. Past the
instance's node read limit it stops and returns no data; the tool reports that as
an **empty response, not as zero matches**.

- Search text with `fulltext`, not with `property` on a text field.
- Add `type` when you know the node type (`cq:Page`, `dam:Asset`, ...).
- Keep `path`/`roots` as narrow as the question allows.
- If an unindexed `property`/`nodename` search returns nothing, do not blind-
  retry it: add a `type`, narrow the scope further, or tell the user their
  instance needs an index for that property (an AEM admin task).

A `property` query narrowed to a small subtree can still succeed without an
index - it is the breadth of the traversal that aborts the query, so scoping
helps.

## Customer and third-party predicates are allowed

The predicate map is deliberately not restricted to a fixed list. If a project
has installed its own predicate evaluator, pass it exactly as its documentation
names it. The application forwards unknown predicates to AEM untouched; if the
server does not recognise one, it reports a server error, and that error is the
correct answer to relay — not a reason to silently drop the predicate.

## Nested AND / OR groups

Groups are formed with numeric prefixes. Inside a group, `p.or=true` makes the
group a disjunction; the default is a conjunction. Groups nest by repeating the
pattern.

Pages that are either articles or events, modified under `/content/wknd`:

```json
{
  "path": "/content/wknd",
  "type": "cq:Page",
  "group.p.or": "true",
  "group.1_property": "jcr:content/cq:template",
  "group.1_property.value": "/conf/wknd/settings/wcm/templates/article",
  "group.2_property": "jcr:content/cq:template",
  "group.2_property.value": "/conf/wknd/settings/wcm/templates/event"
}
```

`group.p.or`, `group.p.not` and numeric variants such as `1_group.p.or` are
ordinary predicate keys and are always accepted.

## Never set output parameters as predicates

`p.limit`, `p.offset`, `p.hits`, `p.properties`, `p.nodedepth`, `p.guessTotal`
and `p.facets` are reserved by the application. Putting one in `predicates` is
rejected with an error telling you which real field to use instead. Selecting
result fields is the `properties` argument, described below; paging is done by
the application.

## Leave the table's columns alone

The table is the whole answer, and its first column is always `Path`. Do not pass
`properties` on your own initiative: every field you add becomes another column,
and a page property such as `jcr:content/jcr:title` arrives as a `jcr:content`
column holding raw JSON.

Pass `properties` only when the user explicitly asks to see particular fields.
Then name exactly those fields, relative to the matched node
(`jcr:content/jcr:title`), and never `path` - the path is already the first
column.

## Escaping and Unicode

Values are sent as ordinary strings and are URL-encoded by the application —
do not percent-encode them yourself, and do not wrap them in quotes. Spaces,
`&`, `=`, `%`, `+`, `#`, and non-ASCII characters are all safe to pass
literally. Non-Latin titles and paths work unchanged:

```json
{ "path": "/content/wknd", "fulltext": "Weiße Röcke & Café" }
```
