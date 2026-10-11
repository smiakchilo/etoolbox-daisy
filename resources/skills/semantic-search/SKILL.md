---
name: semantic-search
description: How to run a semantic search against a conventional AEM Author instance - recall everything the full-text index can find for a subject, judge each candidate by the meaning the request carries, and report the passing matches as a path-to-citation table. Use whenever the user asks for content by meaning, quality, topic, or description rather than by an exact word, a path, a property value, or a structured predicate - including when they invoke `/semantic-search <text>`.
metadata:
  user-description: Find content by meaning, not just matching words.
---

# Semantic search

A semantic search is **lexical recall plus meaning-based precision**. It is two
phases, and you must do both:

1. **Recall.** Search the full-text index for the subject. This is deliberately
   broad - it matches the words, not the meaning.
2. **Judge.** Read each candidate's text and decide whether it genuinely matches
   what the user meant. Only the ones that do are results.

Never present every full-text hit as an answer. The index cannot tell praise
from condemnation; you can.

## 1. Split the request into a subject and a meaning

This skill is reached two ways, and the request is the same in both:

- **The user typed `/semantic-search <text>`.** The `<text>` is handed to you as
  **your input for the turn**.
- **You loaded this skill yourself** because the request is for content by
  meaning, quality, topic, or description rather than an exact word, a path, or
  a property value.

Either way, the whole request is the input: from it you take a subject to search
and a meaning to judge against. Do not ask the user to restate it.

- input `good Waldo` -> subject `Waldo`; meaning "Waldo is good, benevolent,
  upstanding".
- input `pages about our sustainability commitments` -> subject
  `sustainability`; meaning "the company's environmental commitments".

The subject is what goes in the query. The meaning is what you judge against.
Keep them separate:

- Search the **subject**; never put the meaning words in the query. Searching
  `good Waldo` would miss "Waldo invests into charity", which is exactly the
  kind of match the user wants.
- Reduce the subject to the shortest distinctive term or two - names, nouns,
  product terms. Drop intent adjectives and verbs.
- If the subject is a phrase whose words must co-occur, it may stay a phrase,
  but still without the meaning words.

If the request has no separable subject, ask the user which word to search.

## 2. Recall with a full-text query

Use `aem_query` with a `fulltext` predicate set to the subject, scoped to the
host's **content roots** via `roots`. `fulltext` searches the full-text index
(the indexed text properties of the nodes under the scope), not one named
property.

Scope defaults to the content roots named in the current page context block
(`/content` when the host configures none). Pass them as `roots`: the tool runs
one query per root and merges the candidates, so several roots are still a
single call. Widen the roots only when the user clearly asks for it - an
unscoped query scans the repository and can time out.

Do **not** add a `type` predicate by default. Text can live on component and
asset nodes as well as pages; narrowing to `cq:Page` would hide the text you
are looking for.

Keep the candidate set small and set the limit explicitly - omitting `limit`
lets AEM return up to 50 rows. Use a page size of 50 so a full recall page can
yield up to 50 passes:

```json
{
  "predicates": { "fulltext": "Waldo" },
  "roots": ["/content/wknd"],
  "limit": 50
}
```

- Use `limit: 50`. If the user states a maximum ("/semantic-search ... max 5"),
  use that instead. Do not silently raise it.
- Read `pagination` in the result. If `hasMore` is `true` or `"unknown"`, this
  is one page, not the whole answer.

## 3. Read each candidate's text

An `aem_query` row carries only `jcr:path`, `jcr:primaryType` and `jcr:title`
unless you asked for more. That is not enough to judge meaning. Read the
candidates:

- Call `aem_get_json` for one candidate at a time, with no `properties`, so all
  of the node's own properties come back.
- A text component or an asset usually carries the text as a property on the
  node itself; judge from that value.
- If the candidate is a page and the text is not on the node, you may list its
  immediate children with `includeChildren: true` (that returns child **names**,
  not their properties) and read the child whose name suggests content. Stay
  within **one level**, only for candidates you mean to judge, and only within
  the candidate cap.
- Optimization: when you already know a text property by name (for example
  `jcr:content/jcr:description`), you may request it in the query's `properties`
  array and skip that node read. When you do not know it, read the node.

If you cannot locate the text within these bounds, say so and either drop the
candidate or mark it "matched by the index, text could not be retrieved". Never
invent or paraphrase a quote.

The bridge runs one AEM request at a time with a 90-second timeout, so do not
read more nodes than the cap allows.

## 4. Judge by meaning, not by keyword

For each candidate ask one question: does this text **support the requested
meaning about the subject**?

| Candidate text | "good Waldo" | Reason |
| --- | --- | --- |
| "Waldo is a good guy." | pass | asserts the meaning |
| "Waldo invests into charity." | pass | supports the meaning |
| "Waldo killed people." | reject | contradicts the meaning |
| "Contact Waldo for details." | reject | unrelated mention |

- A passing mention of the subject is not a match.
- A match may be worded differently from the user's request; judge the idea, not
  the phrase.
- If the evidence is ambiguous, say it is ambiguous and quote what you found.
  Do not upgrade a maybe into a yes.

## 5. Publish the passing rows as a table, then offer more

A `/semantic-search` turn produces **exactly one application-rendered table**,
built by calling `format_table`. Write no prose of your own: the application
hides your assistant text for this turn, so any explanation you write is
discarded.

Publish every passing row you have judged so far by calling `format_table` with
a `rows` array, `mode: "new"` the first time and `"append"` after:

```json
{
  "data": {
    "rows": [
      { "jcr:path": "/content/wknd/us/en/about/waldo", "property": "jcr:content/jcr:description", "citation": "Waldo is a good guy and a generous donor." }
    ]
  },
  "mode": "new"
}
```

- **`jcr:path`** is the exact path as returned. The application makes it
  clickable; write it as a bare path, not a markdown link.
- **`property`** is the property the citation came from, when you know it.
- **`citation`** is the **exact** text from that resource that supports the
  match. Quote it; do not paraphrase inside the row. If you must shorten it, use
  an ellipsis but keep every remaining word unchanged, so the quote stays
  traceable to the resource.
- If a candidate's text is longer than a sentence, quote the smallest span that
  carries the meaning.

Then decide whether to continue. **This decision is mandatory and must be made
in the same turn, before it ends: a `/semantic-search` turn that has published a
table is not finished until you have either offered the next page or established
there is none.**

- Continue while you have published **fewer than 50 passes** and the recall has
  more pages (`pagination.hasMore` is `true` or `"unknown"`). To continue, you
  **must** call `ask_user` with a single action, `actions: ["Load more"]`:

  ```json
  { "actions": ["Load more"] }
  ```

  This call is the only thing that gives the user a **Load more** button. Do not
  write the offer as prose: the application discards your assistant text for
  `/semantic-search`, so a written question is invisible, and the turn ends with
  nothing to click.

  - If the user clicks **Load more**, run the next recall page (`offset`
    increased by 50), judge it, and `format_table` the new passes with
    `mode: "append"`. Do not trim the table below the rows already published.
  - If they Stop the turn instead, the search ends.
- Stop only when one of these is true: you have published 50 or more passes, or
  the recall is exhausted (`hasMore` is `false`), or nothing passed. In those
  cases - and only those - do not call `ask_user`.

Before you end the turn, verify: **did I either call `ask_user` with
`["Load more"]`, or establish a stop condition above?** If neither is true, you
are not done.

If nothing passed, publish no table and say so plainly: report the scope and
counts. "No matching content" is a valid and useful answer - it is not a
failure.

## Read-only

You cannot change AEM. Never propose or attempt `/crx`, CRXDE, Package Manager,
the Sling POST servlet, `curl`, shell commands, files, or external tools. If the
user asks you to change content, say EToolbox Daisy is read-only and offer the
information that would support the change.
