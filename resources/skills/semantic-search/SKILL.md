---
name: semantic-search
description: How to run a semantic search against a conventional AEM Author instance - recall everything the full-text index can find for a subject, judge each candidate by the meaning the request carries, and show the passing matches as a path-to-citation table, using the aem_semantic_search tool. Use whenever the user asks for content by meaning, quality, topic, or description rather than by an exact word, a path, a property value, or a structured predicate - including when they invoke `/semantic-search <text>`.
metadata:
  user-description: Find content by meaning, not just matching words.
---

# Semantic search

A semantic search is **lexical recall plus meaning-based precision**. The
application does all of the mechanics with the `aem_semantic_search` tool: it
queries AEM one page of hits at a time, reads the content of **every** hit, shows
the table (with its **Total** line counting the relevant matches), and offers the user a **Load more** button.
**Your only job is to judge which candidates match.**

Write no prose of your own: the application hides your assistant text for this
turn, so any explanation you write is discarded.

## 1. Split the request into terms and a context

This skill is reached two ways, and the request is the same in both:

- **The user typed `/semantic-search <text>`.** The `<text>` is handed to you as
  **your input for the turn**.
- **You loaded this skill yourself** because the request is for content by
  meaning, quality, topic, or description.

Either way, the whole request is the input. Do not ask the user to restate it.
From it take:

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

Make one call:

```json
{ "terms": "Waldo", "context": "Waldo is good, benevolent, upstanding" }
```

Pass `roots` only when the user named a scope; never pass `limit` unless the
user asked for a page size.

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

Never call `aem_query`, `aem_get_json` or `ask_user` yourself
for a semantic search, and never write the results as text.

## Read-only

You cannot change AEM. Never propose or attempt `/crx`, CRXDE, Package Manager,
the Sling POST servlet, `curl`, shell commands, files, or external tools. If the
user asks you to change content, say EToolbox Daisy is read-only and offer the
information that would support the change.
