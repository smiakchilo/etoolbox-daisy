---
name: search
description: How to run an AEM search with the aem_query tool - invoke `/search <terms>` for an immediate full-text search, or construct QueryBuilder predicate maps for path/type/property predicates, nested AND/OR groups, date and range predicates, ordering, and choosing which properties to return. Use whenever searching, correcting, or explaining an aem_query call against a conventional AEM Author instance.
metadata:
  user-description: Find pages and assets by their content.
---

# Running an AEM search

`aem_query` takes `predicates`: a flat map of QueryBuilder predicate keys to
string values. The application always targets the QueryBuilder endpoint on the
currently selected AEM instance — you never supply an endpoint, and you never
supply a query language. QueryBuilder predicates are the only query syntax
available here; do not write SQL2, JCR-SQL, XPath, or GraphQL.

All predicate values are strings, including numbers and booleans.

## Invoked as `/search <terms>`

You are invoked as `/search <terms>`, and the user's term(s) are handed to you
as **your input for the turn** - the directive that invokes this skill says so,
and the term(s) follow it. **That input is the search string.** Run the search
for it immediately; do not ask the user what to search for, and do not answer by
explaining this skill.

A `/search` turn produces **exactly one application-rendered table**, built by
calling the tools in order. Write no prose of your own: the application hides
your assistant text for this turn, so any explanation you write is discarded.

**All three steps below are mandatory and in order.** A `/search` turn is **not
finished** when the table is on screen - that is the halfway point. It ends only
after step 3, and the normal case is that step 3 calls `ask_user` with
`["Load more"]`. Ending the turn after step 2 - a table, but no `ask_user` and no
check of `hasMore` - is a failure of this skill: the user is left staring at one
page of results with no way to reach the rest. Do not do it.

1. **Query.** Call `aem_query` with a `fulltext` predicate set to the input, the
   host's content roots as `roots`, `properties: []` (so each hit returns only
   its `jcr:path`), `limit: 50`, and `offset` starting at `0`:

   ```json
   {
     "predicates": { "fulltext": "<terms>" },
     "roots": ["/content/wknd"],
     "properties": [],
     "limit": 50,
     "offset": 0
   }
   ```

2. **Present.** Call `format_table` with this result's JSON as `data` and
   `mode: "new"` on the first page, `"append"` on every later page:

   ```json
   { "data": { "rows": [ { "jcr:path": "/content/wknd/us/en" } ], "pagination": { "total": { "accuracy": "estimated", "value": 42 } } }, "mode": "new" }
   ```

   Pass the result **verbatim**; do not reformat or rename anything. The
   application renders the total line and the `# | Path` table.

3. **Offer more - this step must run before your turn ends.** After
   `format_table`, read the `aem_query` result's `pagination.hasMore` and act on
   it **now**, in this same turn:

   - If `hasMore` is `true` or `"unknown"`, you **must** call `ask_user` with
     exactly one action, `actions: ["Load more"]`:

     ```json
     { "actions": ["Load more"] }
     ```

     This call is the only thing that gives the user a **Load more** button. A
     written question - "there are more results, shall I load them?" - is **not**
     a substitute: the application discards your prose for `/search`, so the user
     sees nothing and the turn ends with nothing to click. The button appears
     only if you call `ask_user`.

   - If the user clicks **Load more**, repeat from step 1 with `offset`
     increased by `50`, then `format_table` with `mode: "append"` - and then run
     this step again on the new result.
   - If they Stop the turn instead, the search ends.
   - **Only** if `hasMore` is `false` is there nothing to load. Then, and only
     then, do not ask.

   Before you end a `/search` turn, verify: **did I either call `ask_user` with
   `["Load more"]`, or see `hasMore === false`?** If neither is true, you are not
   done - call `ask_user` with `["Load more"]`. When in doubt, ask: an
   unnecessary Load more is harmless, a missing one strands the user on page 1.

If the input is empty, then - and only then - ask what to search for with a
normal `ask_user` question (options or free input), not with `actions`.

`/search` is only the shortcut for a plain term. For anything more specific - a
concrete path, a property value, a date or numeric range - build the predicate
map yourself as the rest of this skill describes; still present the result with
`format_table`. A hand-built query is still a `/search` turn, so it still ends
with step 3: offer **Load more** whenever `hasMore` is not `false`.

## Always scope

An unscoped query scans the whole repository and is slow enough to time out.
Start every query from a scope unless the user has explicitly asked for a
repository-wide search.

The current page context block names the host's **content roots** (default
`/content`). Pass them to `aem_query` as `roots`. The tool runs one query per
root and merges the rows, so a host with several content roots is covered in a
single call:

```json
{
  "predicates": { "type": "cq:Page" },
  "roots": ["/content/wknd", "/content/shared"],
  "limit": 50
}
```

- `limit` and `offset` apply to each root, and the effective roots are reported
  back. Never combine `roots` with a `path` predicate — that is rejected.
- Use `roots` whenever the user names no path, or asks about the environment as
  a whole. Widen the roots only when the request clearly reaches beyond them,
  and say what scope you used.

When the user names a concrete path (or you want the single page from the
current page context), a `path` predicate is still correct and is one request:

```json
{
  "path": "/content/wknd",
  "type": "cq:Page"
}
```

Use `path.exact=true` to match one node rather than a subtree, and
`path.self=true` to include the starting node itself.

## Common predicates

| Goal | Predicates |
| --- | --- |
| Node type | `type` = `cq:Page`, `dam:Asset`, `nt:unstructured`, ... |
| Property equals | `property` = `jcr:content/cq:template`, `property.value` = `...` |
| Property exists | `property` = `...`, `property.operation` = `exists` |
| Property is absent | `property` = `...`, `property.operation` = `not` |
| Any of several values | `property.1_value`, `property.2_value`, ... |
| Full text | `fulltext` = `search terms`, `fulltext.relPath` = `jcr:content` |
| Node name | `nodename` = `*-draft` |
| Date range | `daterange.property` = `jcr:content/cq:lastModified`, `daterange.lowerBound` = `2024-01-01T00:00:00.000+00:00` |
| Numeric range | `rangeproperty.property` = `...`, `rangeproperty.lowerBound` = `10` |
| Ordering | `orderby` = `@jcr:content/cq:lastModified`, `orderby.sort` = `desc` |

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
rejected with an error telling you which real field to use instead. Use the
`limit`, `offset` and `properties` arguments of the tool.

## Ask for the properties you need

`properties` selects which fields come back per hit. Omit it and you get
compact identifying fields — enough to tell hits apart and to follow up with
`aem_get_json`, not the whole subtree.

```json
{
  "predicates": { "path": "/content/wknd", "type": "cq:Page" },
  "properties": ["jcr:content/jcr:title", "jcr:content/cq:lastModified"],
  "limit": 50
}
```

Request a narrow projection deliberately. Asking for many properties across
many hits is the main way a result becomes too large to return.

## Escaping and Unicode

Values are sent as ordinary strings and are URL-encoded by the application —
do not percent-encode them yourself, and do not wrap them in quotes. Spaces,
`&`, `=`, `%`, `+`, `#`, and non-ASCII characters are all safe to pass
literally. Non-Latin titles and paths work unchanged:

```json
{ "path": "/content/wknd", "fulltext": "Weiße Röcke & Café" }
```
