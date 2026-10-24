---
name: semantic-search
description: How to run a semantic search against a conventional AEM Author instance - recall everything the full-text index can find for a subject, ask the active model whether each candidate carries the requested meaning, and show the passing matches as a path-to-citation table, using the aem_semantic_search tool. Use whenever the user asks for content by meaning, quality, topic, or description rather than by an exact word, a path, a property value, or a structured predicate - including when they invoke `/semantic-search <text>`.
metadata:
  user-description: Find content by meaning, not just matching words
table-only: true
---

# Semantic search

A semantic search is **lexical recall plus meaning-based precision**. The
application runs the whole search with one `aem_semantic_search` call: it
queries AEM page by page, reads every hit, asks the active model whether each
candidate matches the requested meaning, and shows the table (with its **Total**
line counting the relevant matches) and the user's **Load more** button itself.

**Your only job is to turn the request into `terms` and a `context`.** You never
see candidates, never decide which ones match, and never call the tool back with verdicts.

## 1. Split the request into terms and a context

From the user's request take:

- **`terms`** - the search phrase AEM's full-text index looks for: the shortest
  distinctive term or two (names, nouns, product terms), **without** the meaning
  words. Searching `good Waldo` would miss "Waldo invests into charity".
- **`context`** - the meaning a result must carry to count, as a short sentence.
  The application gives this sentence to the model with each candidate.

Examples:

- `good Waldo` -> terms `Waldo`; context "Waldo is good, benevolent, upstanding".
- `pages about our sustainability commitments` -> terms `sustainability`;
  context "the company's environmental commitments".

If the request has no separable search phrase, ask the user which word to
search with a normal `ask_user` question (options or free input).

## 2. Start the search

Make one call, with the roots its subject calls for:

```json
{
  "terms": "Waldo",
  "context": "Waldo is good, benevolent, upstanding",
  "roots": ["<the host's content roots>"]
}
```

A semantic search is usually about pages and their content, so it searches the
**content roots** unless the request is about **files or assets** - then pass the
host's **DAM roots** - or asks for both kinds, when you pass both families. The
host's content, component and DAM roots are listed in the current-page context
block at the start of the prompt; never invent or complete one.

If the request names a scope ("... under us/en"), it belongs in neither `terms` nor
`context`: use it as `roots` instead of the family, exactly as the user wrote it
(`{ ..., "roots": ["us/en"] }`). The Scope rules in your instructions cover the
rest.

Whether the content is published belongs in neither `terms` nor `context` either:
when the request asks for published or not-published content, add the filter the
Publication state rules in your instructions name to this first call (`"filters":
[{ "property": "cq:lastReplicationAction", "value": "Activate" }]`). The
candidates are then pages and assets only.

## 3. Wait for the tool

The application queries and reads the next pages, asks the model about their hits, and paints
the table and "Load more" while the call is still running. **Nothing is expected
of you until the call returns**:

- Do not call `aem_semantic_search`, `aem_query`, `ask_user` or any other tool
  for this search while it runs.
- Do not write a summary, explanation or list of results - the table is the
  whole answer.
- The tool returns only when the search is **finished** (AEM has no more
  results, the user stopped loading more, or the search failed). If it failed,
  report the failure; otherwise end your turn without writing anything.

The application asks the active model about each page; an answer that is
unusable is retried, and a search whose pages still cannot be answered fails rather than
silently dropping matches.
