# agents-md-anchor

Keeps project instructions (AGENTS.md and the files it points to) effective
through long sessions and compaction.

## The actual problem

In pi, AGENTS.md is **not** at risk of being truncated. pi loads it (from the
cwd and every ancestor, plus `~/.pi/agent/AGENTS.md`) into the system prompt's
`project_context` section. The system prompt is re-sent on every request, and
each compaction entry stores its own copy of it (`systemMessage`), so it
survives compaction too. Verified in a live compacted session.

What does get lost in a long task:

1. **Files AGENTS.md sends the agent to.** pi auto-loads only
   `AGENTS.override.md`/`AGENTS.md`/`CLAUDE.md`. `AGENTS-LOCAL.md` and the
   `agent-instructions/*.md` files a "read this next" table links to enter the
   conversation as ordinary `read` results, which compaction summarizes away.
2. **Attention.** After a few hundred thousand tokens of tool output, rules
   stated once at the very front get less weight. They are present, just
   followed less reliably.

## What it does

### 1. Pin (`before_agent_start`)

Any file named in `PI_AGENTS_ANCHOR_PIN` (default `AGENTS-LOCAL.md`) that sits
next to a loaded AGENTS.md is added to `systemPromptOptions.contextFiles`,
right after the file it accompanies. It is then part of the system prompt:
never compacted, and no longer dependent on the agent remembering to read it.

### 2. Remind (`turn_end`, `before_agent_start`)

A persisted `custom_message` is appended when:

- the context first reaches `PI_AGENTS_ANCHOR_FIRST` tokens (default 80k),
- then every further `PI_AGENTS_ANCHOR_EVERY` tokens (default 80k),
- and immediately after any compaction, whatever the size.

It restates the `## Always apply` section (heading configurable via
`PI_AGENTS_ANCHOR_SECTION`) of each loaded context file, and lists instruction
files that were read earlier but whose reads are no longer in context: files a
context file links to, and any `SKILL.md`. If no file has the section, it names
the context files instead.

A pinned companion (`AGENTS-LOCAL.md`) without that section is restated in
full, up to `PI_AGENTS_ANCHOR_PINNED_MAX` characters (default 8000, about 2k
tokens); a longer one is named rather than silently skipped. A pinned file is
short, local rules meant for every step, and before this it was never restated
at all. In a 500k-token session, every lapse was against an `AGENTS-LOCAL.md`
rule (placeholder edits, 20-50k tokens after a reminder), while every restated
`AGENTS.md` rule held. For the Qwestly workspace this takes a reminder from
about 1.1k to about 2.7k tokens, roughly 3% of a long session.

It is sent from `turn_end` only when tool results mean another request
follows, and from `before_agent_start` when a new prompt arrives in an
already-long session. The TUI shows it as one dim line; expand to see it.

Why persisted and sparse, not a request-local message on every call: a
message that moves to the tail each request is re-billed uncached every time,
while a persisted one becomes part of the cached prefix. At ~1-3k tokens every
80k it costs very little.

### 3. Guard

Checks that every file pi would load (computed at `session_start` with pi's
own `loadProjectContextFiles`) plus the pinned files is actually present:

| Stage | Check | Action |
| --- | --- | --- |
| `before_agent_start` | in `contextFiles` (by path) | put back in pi's order; warn |
| `before_agent_start` | in a prompt an *earlier* extension already replaced | append to that replacement |
| `context_with_system` | in the effective prompt (`ctx.getSystemPrompt()`) | insert as a message right after the system prompt (fixed position, cache-stable); warn |
| `before_provider_request` | anywhere in the serialized payload | warn only (payload shape is provider-specific) |

Presence is a verbatim match on the first 240 characters of the file, not the
`<project_instructions>` wrapper, so a replaced prompt that embeds the content
some other way still counts. Warnings fire once per file per session.

Normally none of these fire. They exist to prove that, and to catch an
extension that replaces the whole system prompt (`systemPrompt` from
`before_agent_start`) without project context. The payload check sees only
changes made by `before_provider_request` handlers that run before it;
transport-level rewriting (e.g. `pi-anthropic-auth`, which keeps
`project_context` byte-identical) happens after and is not checked.

## `/agents-anchor`

Shows each context file with present/missing and pinned status, the number
of reminders on this branch, and the current context size against the
thresholds.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_AGENTS_ANCHOR_DISABLE` | unset | `1` disables the extension |
| `PI_AGENTS_ANCHOR_PIN` | `AGENTS-LOCAL.md` | colon-separated companion names; empty pins nothing |
| `PI_AGENTS_ANCHOR_SECTION` | `Always apply` | heading of the section to restate |
| `PI_AGENTS_ANCHOR_FIRST` | `80000` | context tokens before the first reminder |
| `PI_AGENTS_ANCHOR_EVERY` | `80000` | context growth between reminders |
| `PI_AGENTS_ANCHOR_PINNED_MAX` | `8000` | largest pinned file (characters) restated in full when it has no such section |

`--no-context-files` / `-nc` also disables it, so a deliberate opt-out is not
undone.

## Verified live

In a scratch repo with a codeword only in `AGENTS-LOCAL.md`:

- Pinned: the model answered it from the system prompt without tools; with the
  extension disabled it answered NOT PRESENT.
- Reminder: fired after the tool results, the model continued without replying.
- Compaction (RPC `compact`): the compaction entry kept AGENTS.md and the pinned
  file; the next prompt got a `compacted` reminder listing the
  `agent-instructions/*.md` file read before compaction.
- Guard: with a test extension replacing the whole prompt, both files were
  restored and the model had both codewords; disabled, it had neither. With an
  extension that appends to `event.systemPrompt` and runs first, the pinned file
  was appended to its replacement with no warning.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Hook wiring, renderer, `/agents-anchor` |
| `context-files.ts` | Pure: pinning, restoring, presence checks |
| `reminder.ts` | Pure: when to remind, section extraction, dropped-read tracking, text |
| `*.test.ts` | Unit tests |

```sh
cd ~/.pi/agent/extensions/agents-md-anchor
node --test *.test.ts
```

Reload with `/reload`, or restart a persistent host (pi-web).
