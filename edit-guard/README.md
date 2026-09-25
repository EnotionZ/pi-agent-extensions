# edit-guard

Blocks an edit that replaces real text with a placeholder, before it runs.

## The problem

Meaning to rewrite a block, the model sometimes calls `edit` with the old
block and a stand-in replacement ("x", "unused", "PLACEHOLDER", a literal
"null"), planning to write the real text in a follow-up call. The edit
succeeds, so nothing flags it. If the follow-up is late, skipped, or itself
wrong, the file is left with a stray token where a function signature or a
paragraph used to be, and the errors that follow get diagnosed as something
else.

`AGENTS-LOCAL.md` forbids this in so many words. A 500k-token session broke the
rule twice anyway, a few tens of thousands of tokens after the last reminder.
An instruction does not land on every generation; a check does.

## What it blocks

| Call | Blocked when | Always allowed |
| --- | --- | --- |
| `edit` | a `newText` that is only a placeholder token replaces an `oldText` of 2+ non-blank lines or 80+ characters | `newText: ""` (a deliberate deletion); a placeholder replacing a short token; any real text |
| `write` | the whole `content` is a placeholder and the file already exists at 200+ bytes | new files, tiny files, any real content |

Placeholders: `x`, `xx`, `xxx`, `todo`, `tbd`, `tk`, `fixme`, `unused`,
`placeholder`, `null`, `undefined`, `...`, `…`, any case, optionally wrapped in
quotes, backticks, or brackets. Real one-word values such as `None`, `0` and
`false` are not on the list.

A missing `newText` is left to pi's own schema validation, which already
rejects it.

The model gets a reason back ("would replace 4 lines with the placeholder
\"x\"... compose the complete replacement in this same call") and retries.

## Evidence

Replayed over every `edit` call in the local session history (862 calls, 78
sessions), it flags 5: three `PLACEHOLDER` edits on 2026-09-20 and the `x` and
`unused` edits from 2026-09-25, all instances of this mistake. No legitimate
edit is flagged. None of the 246 recorded `write` calls had placeholder-only
content.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PI_EDIT_GUARD_DISABLE` | `1` disables the extension |

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | `tool_call` hook wiring |
| `placeholder.ts` | Pure: what counts as a placeholder and a substantial span |
| `placeholder.test.ts` | Unit tests |

```sh
cd ~/.pi/agent/extensions/edit-guard
node --test *.test.ts
```

Reload with `/reload`, or restart a persistent host (pi-web).
