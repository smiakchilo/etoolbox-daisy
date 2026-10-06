---
name: aem-semantic-search
description: How to answer a "semantic search" request against a conventional AEM Author instance - recall everything the full-text index can find for a subject, judge each candidate by meaning, and report the matches with a path-to-citation table. Use whenever the user says "semantic search" and supplies a subject plus a meaning to match, rather than a path, a property value, or a structured predicate.
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

A semantic search gives you a subject and a meaning to look for:

- "semantic search **good Waldo**" -> subject `Waldo`; meaning "Waldo is good,
  benevolent, upstanding".
- "semantic search **pages about our sustainability commitments**" -> subject
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
lets AEM return up to 50 rows, which is more than you should probe:

```json
{
  "predicates": { "fulltext": "Waldo" },
  "roots": ["/content/wknd"],
  "limit": 10
}
```

- Use `limit: 10`. If the user states a maximum ("semantic search max 5"), use
  that instead. Do not silently raise it.
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

## 5. Report a path -> citation table

Return only the candidates that passed, one row each, with two columns:

| Resource | Citation |
| --- | --- |
| `/content/wknd/us/en/about/waldo` | "Waldo is a good guy and a generous donor." |

- **Resource** is the exact `jcr:path` as returned, written as a bare path
  beginning with `/`. Do not wrap it in a markdown link or a code span, and do
  not append `.html`. When the browser pane has an active host, the application
  turns a bare AEM path into a link that opens the resource.
- **Citation** is the **exact** text from that resource that supports the match.
  Quote it; do not paraphrase inside the column. If you must shorten it, use an
  ellipsis but keep every remaining word unchanged, so the quote stays traceable
  to the resource.
- If a candidate's text is longer than a sentence, quote the smallest span that
  carries the meaning.

After the table, state in one short paragraph:

- the scope you actually searched ("under /content/wknd");
- how many candidates you examined, matched and rejected;
- the page status: if `hasMore` is true, say more candidates exist and offer the
  next page; if `total` accuracy is `estimated` or `unknown`, say so.

If nothing passed, say so plainly and report the scope and counts. "No matching
content" is a valid and useful answer - it is not a failure.

## Read-only

You cannot change AEM. Never propose or attempt `/crx`, CRXDE, Package Manager,
the Sling POST servlet, `curl`, shell commands, files, or external tools. If the
user asks you to change content, say EToolbox Daisy is read-only and offer the
information that would support the change.
