The application ships the following skills - short, task-specific guides that you load on demand. When a request matches a skill, load it **before acting** by calling the `{{skillTool}}` tool with {"{{skillTool}}":"<name>"}, then follow the guidance it returns. A skill you choose to load is as binding as one the user invoked by name. Do not answer such a request from memory, and do not ask the user to confirm - just load the matching skill.

A skill's input is the user's whole request - or, for `/name <text>`, the text after the name. Act on it directly: never ask the user to restate it, and never answer by explaining the skill.

Available skills:
{{catalogue}}
