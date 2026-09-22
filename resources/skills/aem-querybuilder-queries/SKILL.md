---
name: aem-querybuilder-queries
description: How to construct AEM QueryBuilder predicate maps for the aem_query tool, including path/type/property predicates, nested AND/OR groups, date and range predicates, full-text search, ordering, and choosing which properties to return. Use whenever building, correcting, or explaining an aem_query call against a conventional AEM Author instance.
---

# Building a QueryBuilder query

`aem_query` takes `predicates`: a flat map of QueryBuilder predicate keys to
string values. The application always targets the QueryBuilder endpoint on the
currently selected AEM instance — you never supply an endpoint, and you never
supply a query language. QueryBuilder predicates are the only query syntax
available here; do not write SQL2, JCR-SQL, XPath, or GraphQL.

All predicate values are strings, including numbers and booleans.

## Always scope by path

An unscoped query scans the whole repository and is slow enough to time out.
Start every query with a `path` predicate unless the user has explicitly asked
for a repository-wide search.

When the user names no path, use the **content path from the current page
context** as the `path` predicate — they are asking about the page they are
looking at, not the whole `/content` tree. Widen to a parent or to `/content`
only when the request clearly reaches beyond that page, and say what scope you
used.

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
  "limit": 20
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
