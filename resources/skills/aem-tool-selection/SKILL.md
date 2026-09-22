---
name: aem-tool-selection
description: How to choose between the aem_get_json and aem_query tools when answering a question about a conventional AEM Author instance, and which operations EToolbox Daisy does not permit at all. Use before the first AEM tool call of a task, whenever a request could be answered either by reading a known path or by searching, whenever a request refers to "this page", "this host", or the current environment instead of naming a path or server, and whenever a request asks to change, create, delete, move, replicate, or activate AEM content.
---

# Choosing an AEM tool

EToolbox Daisy exposes exactly two AEM tools. Both are read-only and both run
against the AEM instance the user currently has selected in the browser pane.
You never choose the instance, the host, or the endpoint — the application
binds those. Never put a host, scheme, port, or full URL into any argument.

## Where you are

At the start of every prompt the application gives you a **current page
context** block: the AEM host, the page URL, and — when the page is content —
the JCR content path. It describes where the user's browser pane is right now,
and it is authoritative and fresh for this turn.

- "this page", "here", "this content" → the content path from that block.
- "this host", "this server", "this instance", "this environment" → the host
  from that block.
- a request that names no path and no server → this host and this page.

If the block reports no content path (the pane is on a server page that is not
content), say so and find the path with `aem_query` rather than guessing. If
there is no block at all, no AEM server is open yet; ask the user to open one.

## Pick by what you already know

Use **`aem_get_json`** when you already know the JCR path you need.

- "What is the `jcr:title` of `/content/wknd/us/en`?"
- "What template does this page use?" (you have the page path)
- "What are the child pages of `/content/wknd/us/en/magazine`?" — pass
  `includeChildren: true`.

Use **`aem_query`** when you are looking for nodes you cannot name.

- "Which pages use the article template?"
- "Find components with a missing image alt text under `/content/wknd`."
- "How many assets were modified after a given date?"

If you have a path and only need a handful of properties, `aem_get_json` is
always the better call: it is one request, it returns the node directly, and
it cannot be truncated by paging.

## Do not guess a path in order to avoid a query

Inventing a plausible-looking path and reading it is worse than searching.
A wrong path produces a confident-looking failure that looks like "the content
does not exist". If you are not certain of the path, use `aem_query` with a
`path` predicate and let the instance tell you what is actually there.

The one path you may treat as known without searching is the current page's
content path from the context block above.

## Combining the two

The normal shape of an AEM investigation is: search broadly with `aem_query`
to find candidate paths, then read the interesting ones with `aem_get_json`.
Do not try to make a single query return everything about every hit — request
the identifying fields you need to choose, then read the chosen nodes.

## This application never writes to AEM

There is no tool to create, update, delete, move, copy, reorder, version,
replicate, activate, deactivate, publish, unpublish, or roll out AEM content,
and no tool to install or modify packages, bundles, users, or permissions.
This is a deliberate product decision, not a gap you should try to route
around.

When a user asks for a change:

1. Say plainly that EToolbox Daisy is read-only against AEM.
2. Offer to gather the information that would support the change — the
   affected paths, the current values, the number of nodes involved.
3. Describe the change the user would make themselves in the AEM UI.

Do not attempt to reach AEM by any other route to perform a write. In
particular, do not propose or attempt `/crx`, CRXDE, Package Manager, the
Sling POST servlet, `curl`, shell commands, reading or writing files, or any
external tool or server. Those are not available, and suggesting them is
misleading rather than helpful.
