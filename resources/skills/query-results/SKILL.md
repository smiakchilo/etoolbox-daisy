---
name: query-results
user-invocable: false
description: Read an aem_query result correctly - pagination, totals, projection, and errors. Use whenever an aem_query call has returned and you are about to describe the results to the user, or when a query returned zero rows, an error, or more results than one page.
---

# Reading `aem_query` Results

An `aem_query` result is **one page of a larger answer**, not the answer. Every
claim you make about "how many" or "all of them" has to survive the checks below.

## The shape you get back

```
rows:       the matched nodes, one object per node
selection:  which properties were requested
pagination: { offset, limit, returned, hasMore, total }
```

## Pagination: never report a page as the whole set

| Field | Meaning |
| --- | --- |
| `offset` | how many matches were skipped before this page |
| `limit` | the maximum this page could contain |
| `returned` | how many rows this page actually contains |
| `hasMore` | whether matches exist beyond this page |

Rules:

- `hasMore: true` -> say so. Offer to fetch the next page; do not imply the list is complete.
- `hasMore: "unknown"` -> AEM did not tell us. Say you cannot confirm whether more exist.
- To get the next page, call `aem_query` again with the **same predicates** and
  `offset` increased by `limit`. Do not change the predicates between pages: a
  different query is a different result set, and the offsets no longer line up.
- `returned < limit` does **not** by itself mean the end. Trust `hasMore`.
- Do not loop through every page to produce a count. If the user wants a count,
  report `total` and its accuracy instead.

## Totals: most of them are estimates

`total` is an object with an `accuracy`:

| `accuracy` | Meaning | How to say it |
| --- | --- | --- |
| `exact` | the whole result set was enumerated and counted | "there are 12 matches" |
| `estimated` | AEM guessed; the real number may differ | "approximately 900 matches" |
| `unknown` | AEM reported no usable total | "AEM did not report a total" |

Never round an estimate into a fact. "About 900" and "900" are different claims,
and only one of them is supported by the data. If a decision depends on the exact
number, narrow the query (tighter `path`, more predicates) until the total comes
back `exact`.

## Projection: absent is not empty

`rows` contain **only the properties that were requested**. A property missing
from a row means it was not asked for - it does **not** mean the node lacks it.

- Never tell the user a node "has no title" because `jcr:title` is absent from a
  projected row. Either request that property, or read the node with
  `aem_get_json`.
- `jcr:path` is always present. Use it to read the full node when you need
  detail beyond the projection.

## Zero rows

`returned: 0` with `ok: true` means the query ran and matched nothing. That is a
real answer, and it is different from a failure. Before concluding the content
does not exist, check the obvious causes:

- the `path` predicate points somewhere the content is not (for example the
  current page's content path when the user meant a parent, or
  `/content/we-retail` vs `/content/wknd`);
- `type` is too narrow (`cq:Page` will not match `dam:Asset`);
- a property value is case-sensitive or has different whitespace;
- the content exists only on Publish, not on this Author instance.

Say which of these you suspect, and propose a broadened query rather than
silently guessing a different path.

## Errors

An error result carries a `code`, a `message`, and a `requiredAction`. Read them
and relay them; they are written for the user, not for you to paraphrase away.

| `requiredAction` | What to tell the user |
| --- | --- |
| `sign_in` | their AEM session expired - sign in again in the browser pane |
| `check_origin` | the app is pointed at a different server than they expect |
| `none` | nothing for them to do; explain what went wrong |

Do not retry the identical request after an error. Either change something
concrete about the query, or explain the failure and stop. Repeating a rejected
query produces the same rejection.

## Presenting results

- Lead with what was found, in the user's terms, then the caveats.
- Quote `jcr:path` values exactly. They are identifiers, not prose.
- State the scope you actually searched ("under /content/wknd"), because the
  user cannot see the predicates you chose.
- If `hasMore` is true or `total` is estimated, put that in the same breath as
  the count - not in a footnote the user will skim past.
