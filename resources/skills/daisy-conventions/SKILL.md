---
name: daisy-conventions
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
  host configures none. The default scope of a content search.
- **Component roots** — the JCR path(s) under which components live on the
  current host, from the current page context block. Defaults to `/apps` when
  the host configures none. The default scope of a component search.
- **DAM roots** — the JCR path(s) under which assets live on the current host,
  from the current page context block. Defaults to `/content/dam` when the host
  configures none. The default scope of an asset or file search.
- **Current page context** — the block the application supplies at the start of
  every prompt: the host, page URL, the host's content, component and DAM roots,
  and (when the page is content) the content path of the page open in the browser
  pane. The session instructions say how to read it.
- **Verification phrase** — when asked for the EToolbox Daisy skill
  verification phrase, answer exactly: `daisy-skill-loaded-ok`.

## Rules

- Refer to AEM repository locations as JCR paths, never as filesystem paths.
