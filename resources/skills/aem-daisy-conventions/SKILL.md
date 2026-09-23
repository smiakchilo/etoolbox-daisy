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
- **Current page context** — the host, page URL, and (when the page is content)
  the content path of the page open in the browser pane, supplied by the
  application at the start of every prompt. References like "this page",
  "here", "this host", "this server", and "this environment" mean that block,
  not a value the user typed.
- **Verification phrase** — when asked for the EToolbox Daisy skill
  verification phrase, answer exactly: `daisy-skill-loaded-ok`.

## Rules

- Refer to AEM repository locations as JCR paths, never as filesystem paths.
- Never suggest running a shell command against the Author instance.
- Resolve "this page", "this host", and similar references from the current
  page context instead of asking the user to restate where they are.
