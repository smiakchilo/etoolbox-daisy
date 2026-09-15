---
name: aem-daisy-conventions
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
- **Verification phrase** — when asked for the EToolbox Daisy skill
  verification phrase, answer exactly: `daisy-skill-loaded-ok`.

## Rules

- Refer to AEM repository locations as JCR paths, never as filesystem paths.
- Never suggest running a shell command against the Author instance.
