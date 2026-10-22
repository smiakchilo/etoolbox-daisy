---
name: page-template
user-invocable: false
description: Resolve a page template given by name or title to its JCR path, for a search that filters pages by template. Load it when a request names a template (pages on <template>, or pages containing a component on <template>) and the template is not already a path, before calling aem_query_format_ask. It lists the templates under /conf and /apps, keeps the project's, matches the phrase and asks the user when the choice is ambiguous. Not for finding the pages themselves.
---

# Resolving a page template

**A value that starts with `/`** is already a template path. Use it as it is and
return.

**Anything else is a name or title.** Do not search for it as text and do not
invent a path. List the templates and pick from the list - one `aem_query` call
exactly like this, changing nothing:

```json
{
  "predicates": { "type": "cq:Template" },
  "roots": ["/conf", "/apps"],
  "properties": [
    "jcr:content/jcr:title",
    "structure/jcr:content/sling:resourceType",
    "jcr:content/sling:resourceType"
  ]
}
```

Then read the rows yourself. If the result says `hasMore`, repeat the same call
with `offset` set to `pagination.offset + pagination.returned` until the phrase is
matched or every page is read - the template you need is often not on the first
page (the application chooses the page size; never set `limit` yourself).

- **Ignore** every row whose path contains `/template-types/` - those are not
  templates.
- **Keep the project's templates.** A template belongs to the project when its
  page resource type (`structure/jcr:content/sling:resourceType` for an editable
  template, `jcr:content/sling:resourceType` for a static one) lies under one of
  the host's **component roots** (from the current page context block, default
  `/apps`). A resource type is stored relative (`myproject/components/...`) or
  absolute (`/apps/myproject/components/...`), so compare both spellings against a
  root such as `/apps/myproject`. If this leaves nothing, keep every template.
- **Match the phrase** against each kept template's node name (the last path
  segment) and its `jcr:title`, ignoring case, spaces, hyphens, underscores and
  the words "template" and "page". `UC Basic` matches `hpe-uc-basic`.

Then:

- **Exactly one match?** Return its path.
- **Several?** Do not choose for the user: call `ask_user` with one option per
  template, labelled `"<jcr:title> - <path>"`, plus an `All of them` option. Use
  every path only when the user chooses `All of them`.
- **None?** Call `ask_user` (free input) for another name or a template path -
  your own text is hidden. Never continue on a guess.

Return only the template path (or paths); the calling skill decides what to
search for. A template with several matched paths becomes that many filters
sharing one `group` in the caller's search.
