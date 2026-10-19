---
name: remember
description: Write down what the user asks you to remember, memoise or keep in mind as a memo for later conversations. Use for "remember that...", "keep in mind...", "memoise...", "from now on..." and /remember <what>.
metadata:
  user-description: Remember an instruction or a fact for later conversations
---

# Remembering what the user asks

The input is what the user wants remembered. Write it down with **one** `memo` call,
`trigger: "request"`, then confirm in one short sentence what you remembered.

1. **Keep the user's meaning.** The memo text is the user's instruction, phrased as a
   short imperative a later conversation can follow ("List every matching path in the
   table, not only the first"). Do not add rules they did not state, and do not drop a
   condition they did ("on the Acme hosts", "for component searches").
2. **Title** - a few words naming the lesson.
3. **Skill or general.** Pass `skill` only when the instruction is plainly about a skill
   loaded in this conversation (for example, how search results should look after a
   `/search`). Anything else is general: leave `skill` out.
4. **Ask only when it matters.** If the input is empty, ask what to remember. If it is
   genuinely unclear what the user means, or whether it belongs to a skill, ask once
   with `ask_user` (offer the phrasings or the choices you are weighing). An obvious
   case is written without asking.
5. If `memo` refuses because self-learning is switched off, tell the user once that it
   can be switched on in Settings and do not retry.
