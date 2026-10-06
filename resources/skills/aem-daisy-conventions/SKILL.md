---
name: aem-daisy-conventions
user-invocable: false
description: EToolbox Daisy conventions for working with a conventional AEM Author instance. Use when answering questions about how this application refers to AEM paths, nodes, or components, or when asked for the EToolbox Daisy skill verification phrase.
---

# EToolbox Daisy conventions

This skill ships inside the EToolbox Daisy application bundle. It is loaded
from an explicit, application-owned skill directory and grants no filesystem,
shell, or network access of its own.

## Vocabulary

- **Author instance** — a conventional (on-premise or self-hosted) AEM Author
  server. EToolbox Daisy does not target AEM as a Cloud Service.
- **Content path** — a JCR path beginning with `/content`.
- **Content roots** — the JCR path(s) under which content lives on the current
  host, from the current page context block. Defaults to `/content` when the
  host configures none. Scope content searches to these.
- **Component roots** — the JCR path(s) under which components live on the
  current host, from the current page context block. Defaults to `/apps` when
  the host configures none. Use them for component questions.
- **Current page context** — the host, page URL, the host's content and
  component roots, and (when the page is content) the content path of the page
  open in the browser pane, supplied by the application at the start of every
  prompt. References like "this page", "here", "this host", "this server", and
  "this environment" mean that block, not a value the user typed.
- **Verification phrase** — when asked for the EToolbox Daisy skill
  verification phrase, answer exactly: `daisy-skill-loaded-ok`.

## Rules

- Refer to AEM repository locations as JCR paths, never as filesystem paths.
- Never suggest running a shell command against the Author instance.
- Resolve "this page", "this host", and similar references from the current
  page context instead of asking the user to restate where they are.
- If you are not certain of a path, find it (for example by searching) rather
  than inventing a plausible-looking one. A guessed path produces a
  confident-looking "this does not exist" that is worse than a search.
