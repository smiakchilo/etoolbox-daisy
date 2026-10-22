---
name: semantic-search
description: How to run a semantic search against a conventional AEM Author instance - recall everything the full-text index can find for a subject, judge each candidate by the meaning the request carries, and show the passing matches as a path-to-citation table, using the aem_semantic_search tool. Use whenever the user asks for content by meaning, quality, topic, or description rather than by an exact word, a path, a property value, or a structured predicate - including when they invoke `/semantic-search <text>`.
metadata:
  user-description: Find content by meaning, not just matching words
---

# Semantic search

A semantic search is **lexical recall plus meaning-based precision**. The
application does all of the mechanics with the `aem_semantic_search` tool: it
queries AEM one page of hits at a time, reads the content of **every** hit, shows
the table (with its **Total** line counting the relevant matches), and offers the user a **Load more** button.
**Your only job is to judge which candidates match.**

## 1. Split the request into terms and a context

From the user's request take:

- **`terms`** - the search phrase AEM's full-text index looks for: the shortest
  distinctive term or two (names, nouns, product terms), **without** the meaning
  words. Searching `good Waldo` would miss "Waldo invests into charity".
- **`context`** - the meaning a result must carry to count, as a short sentence.

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

## 3. Judge every candidate, and call back

The result lists numbered candidates - **every** hit of the page - each with
excerpts of its content:

```
[1] /content/wknd/us/en/about/waldo
    (1) jcr:content/jcr:description: "Waldo is a good guy and a generous donor."
[2] /content/wknd/us/en/news/incident
    (1) jcr:content/root/text/text: "Waldo killed people."
```

Judge **each one**, by meaning, not by keyword:

| Candidate text                | "good Waldo" | Reason                  |
|-------------------------------|--------------|-------------------------|
| "Waldo is a good guy."        | match        | asserts the meaning     |
| "Waldo invests into charity." | match        | supports the meaning    |
| "Waldo killed people."        | no match     | contradicts the meaning |
| "Contact Waldo for details."  | no match     | unrelated mention       |

- A passing mention of the subject is not a match; an ambiguous one is not a
  match either.
- A match may be worded differently from the request; judge the idea.
- Judge only from the excerpts given. A candidate whose content could not be
  read, or has no readable text, is not a match.

Then call the tool again with the `searchId` from the result and the numbers of
**all** matching candidates (`[]` when none match):

```json
{ "searchId": "<searchId>", "matches": [1, 4, 7] }
```

To cite a different excerpt than the first, use `{ "candidate": 4, "excerpt": 2 }`
for that entry. Make that call before anything else - no text, no other tool.

## 4. Repeat until it says finished

The application shows your matches, a **Total** line counting them (or "Did not
find any relevant results so far"), and the **Load more** button itself. When the user clicks it, your call
returns the **next** candidates: judge every one of them and call back again,
exactly as in section 3. Keep going for as long as candidates come back.

**You never decide to stop.** Do not stop because a page looked weak or long,
or because you think the user has seen enough. The search ends only when the
result says it is **finished** (AEM has no more results, or the user did not
load more). Then end your turn without writing anything.
