# no-em-dash

Keeps em dashes (—) out of assistant replies, using two layers instead of
one, added in this order after testing each in isolation.

## Why two layers

**Prompt layer** (`reminder.ts`, `before_agent_start`) appends a short
instruction to the system prompt every turn, asking the model not to
produce em dashes at all. Tested alone (deterministic layer disabled): it
reliably stops the literal character, but doesn't guarantee the
*construction* it steers into is grammatical. A sentence that would
naturally have used a paired em dash for a parenthetical aside came out as
a comma splice instead, because avoiding a character mid-generation isn't
the same as knowing what that em dash should deterministically become.

**Rewrite layer** (`em-dash.ts`, `message_end`) deterministically rewrites
any em dash that gets through anyway, choosing a period, comma, semicolon,
colon, ellipsis, or en dash from the surrounding grammar. This is the layer
that guarantees the outcome. The prompt layer just makes it fire less often,
and nudges the model toward constructions this layer doesn't have to fix.

Both layers are scoped to the assistant's own prose: the reminder carves
out tool-call arguments (edit old text, file contents, commands), where an
existing em dash must be reproduced as the literal character, and the
rewriter skips fenced code blocks and inline code spans entirely. Neither touches tool
input/output, following the pattern in `../secret-guard/`, which hit a real
failure mode doing exactly that (corrupted documentation and its own source
by rewriting tool output instead of just the assistant's reply text).

## The rewrite rules (`em-dash.ts`)

Source material: every em dash across this workspace's `plan/` and `_docs/`
folders (~190 occurrences, mostly AI-generated prose), plus manual
stress-testing for constructions the corpus didn't happen to contain. Every
sentence had either exactly one em dash (joining two clauses) or exactly
two (bracketing a parenthetical aside); never three or more.

- **Paired dashes** (`A — B — C`) → both become commas: `A, B, C`.
- **Single dash**, checked in this order:
  1. Nothing follows but a trailing quote/bracket → **ellipsis**.
     Interrupted dialogue trailing off (`"Wait, I didn't mean—"`), not a
     clause join.
  2. A digit on both sides → **en dash, no spaces**. A numeric range
     (`3—5pm`, `2020—2021`) written with the wrong dash character.
  3. The clause before the dash ends with a cataphoric setup phrase
     ("the problem", "one thing", "the result", ...) → **colon**. These
     promise an explanation/list next, a colon's job, not a semicolon's.
  4. Next clause starts uppercase → **period** (reads as a fresh sentence).
  5. Next clause starts with a subordinator/conjunction ("which", "because",
     "so", "but", ...), or the clause before the dash is a bare
     interjection ("Sure", "Okay", ...) with no clause of its own →
     **comma**. A semicolon needs an independent clause on both sides;
     neither of these gives it one.
  6. Otherwise → **semicolon** (two independent, closely related clauses,
     no conjunction between them).

Output spacing is always canonical for the chosen mark, regardless of
whether the source dash had spaces around it (`word — word` and
`word—word` both normalize the same way), except the numeric-range case,
which produces an unspaced en dash to match normal range typography.

## The reminder (`reminder.ts`)

A fixed instruction appended to the system prompt on every turn via
`before_agent_start`, not stuffed into `AGENTS.md`/`AGENTS-LOCAL.md`. A rule
stated once early in a long conversation is competing for attention with
everything that came after it; the system prompt goes out fresh, at a fixed
prominent position, on every provider request for the turn, so it doesn't
have that problem.

The reminder states the *same decision procedure* `em-dash.ts` encodes
(colon for a cataphoric setup, period for a new sentence, comma before a
conjunction, semicolon for two independent clauses), not just "don't use
em dashes." That's not incidental: live testing with only a bare
prohibition ("use a period, comma, semicolon, or colon instead, whichever
fits") showed the model reliably avoids the character but has no procedure
for *which* mark to use instead, and defaults to the cheapest one, almost
always a comma, producing comma splices exactly where a dash would have
been a colon ("Here's the catch, the retry logic assumes..." instead of
"Here's the catch: ..."). The rewrite layer can't catch that after the
fact, because it only ever sees text that already contains an em dash;
text the model routed around a dash to produce never reaches it. Giving
the model the procedure up front closes that gap at the source instead.

### Tool-call arguments

The carve-out used to say only "not about code you are reading, quoting, or
editing verbatim". In a live session that did not cover an `Edit` whose old
text had to match a docstring or Markdown line containing an em dash: it did
not read as "code", so the model avoided the character and wrote an escape
(`\\u2014`), which reached the tool as a literal backslash sequence and matched
nothing. Several edits failed that way. The rewrite layer was not involved,
since it only rewrites `text` blocks at `message_end` and never sees tool
calls. The reminder now names tool-call arguments and says to write the
literal character there, and `reminder.test.ts` pins that wording.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Registers all three hooks on the `ExtensionAPI` |
| `em-dash.ts` | Pure rewrite logic, `replaceEmDashes(text)` |
| `em-dash.test.ts` | Tests for the rewrite rules |
| `reminder.ts` | Pure prompt-building logic, `appendEmDashReminder(prompt)` |
| `reminder.test.ts` | Tests for the reminder |
| `escape-guard.ts` | Pure repair logic, `repairEscapedDashes(text)` / `isProsePath(path)` |
| `escape-guard.test.ts` | Tests for the escape-sequence repair |

Run `node --test *.test.ts` in this folder for the current count; it has grown several times
during testing and will likely grow again.

## A third layer: the escape-sequence guard (`tool_call`)

The reminder's tool-call-argument carve-out (see [The reminder](#the-reminder-reminderts)) turned
out not to be enough on its own. Across one real session, drafting new Markdown prose that legitimately
wanted a real em dash (not reproducing anything -- this is a plan/docs corpus that uses em dashes as
house style), the model wrote the literal six characters `\u2014` instead of the actual character
three separate times. Each one was only caught by grepping the result afterward.

`escape-guard.ts` closes that gap the same way `em-dash.ts` closes the equivalent one for chat
replies: don't rely on the instruction landing every time, verify and repair mechanically. It hooks
`tool_call` for `write` and `edit`, and before the tool executes:

- Repairs `write`'s `content` and `edit`'s `newText` -- the fields that become what's actually on
  disk -- but never `edit`'s `oldText`, which has to match existing bytes; a wrong one just fails the
  edit visibly ("text not found"), which needs no fix and would be actively dangerous to "fix" by
  guessing.
- Only for prose paths (`.md`, `.mdx`, `.markdown`, `.txt`). A literal `"\u2014"` inside a `.ts`/`.py`
  string literal is the normal, correct way to encode that character in source code; this guard can't
  tell "meant literally" from "meant as a mistake" inside code, so it doesn't try.
- Only outside code spans/fences within that prose (reusing `em-dash.ts`'s own `splitCodeAndProse`),
  so a document that quotes the escape sequence as a documented example -- inside backticks, the
  convention this workspace already uses -- survives untouched. (This paragraph is exactly that kind
  of example, which is why `\u2014` above stays inside backticks throughout this section.)

Kept as a folder (not a single top-level `*.ts` file) specifically so the
logic in `em-dash.ts`/`reminder.ts` can be imported and unit-tested without
a running pi session. Extensions only load at session start / `/reload`,
which makes a fast edit-test loop on the underlying files worth having.

## Running the tests

```sh
cd ~/.pi/agent/extensions/no-em-dash
node --test *.test.ts
```

No dependencies needed; Node 22+ strips TypeScript types natively and ships
a built-in test runner.

## Reloading after an edit

`/reload` in an active session, or restart the host process if it's a
persistently-running one (e.g. pi-web).

## Disabling

The loader only discovers folders containing `index.ts`/`index.js` (or
top-level `*.ts`/`*.js` files). Renaming the folder removes it from
discovery without touching its contents:

```sh
mv ~/.pi/agent/extensions/no-em-dash ~/.pi/agent/extensions/no-em-dash.disabled
```

then `/reload`. Move it back the same way to re-enable.
