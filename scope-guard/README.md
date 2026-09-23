# scope-guard

Blocks (or transparently substitutes) shell commands that are prone to hanging
by walking far more of the filesystem than intended — either by literally
targeting a broad root (`/`, `~`, `/System`, ...) or by recursively grepping a
directory that contains `node_modules`/`.git` without excluding them.

This exists because telling an agent "don't run `find /`" in `AGENTS.md` is
only a prompt-level hint — it can be ignored, forgotten after context
compaction, or never seen by a subagent that spins up mid-task. This enforces
it at the runtime level via a `tool_call` hook, regardless of what the model
was told.

## What it does

### 1. Broad-root guard (`find`/`grep`/`ag`/`ls`/`du`/`tree`)

Blocks a command (or the built-in `find`/`grep`/`ls` tools) when the target
path — or the shell's cwd, if no path argument is given — resolves to one of:

- `/` (filesystem root)
- a bare home directory (`~` or `/Users/you`)
- `/Users` or `/home` themselves (not a subpath of them)
- `/etc`, `/var`, `/usr`, `/opt`, `/System`, `/Library`, `/Applications`,
  `/proc`, `/sys`, `/dev`, `/private`, `/Volumes`

Anywhere else is fair game — this is not a project sandbox, it only stops the
"walked the whole disk and locked up" failure mode.

`fd`/`rg` are exempt entirely: they're already the fast, `.gitignore`-aware
alternative this guard would otherwise point you toward.

**Auto-substitution for `find`:** a simple `find <broad-root> [-maxdepth N]
[-type f|d] -name|-iname '<pattern>'` — no `-exec`, no other predicates, no
pipes/chains — gets transparently rewritten to the `mdfind` (Spotlight)
equivalent and actually executed, capped at 50 results, instead of just being
refused. A trailing notice (`[scope-guard] substituting "..." with "..."`) is
appended to the tool result so the substitution is visible and can't be lost
to truncation. Anything more complex than that shape (content search,
`-exec`, non-trivial predicates) is too risky to auto-translate and is just
blocked with a suggestion.

### 2. Unbounded recursive `grep` guard

A plain `grep -r`/`-R` over a directory containing `node_modules` or `.git`
reads the *contents* of every file under those trees before any output
filtering happens. Piping through `| grep -v node_modules` afterward only
hides matching *lines* — it doesn't stop `grep` from walking in and reading
them in the first place. This is a more common real-world stall than typing
`find /`: it looks like it should work, and doesn't.

Blocked when:
- the command contains a `grep` invocation with a recursive flag (`-r`, `-R`,
  or combined like `-rlo`), **and**
- it doesn't already use grep's own exclusion flags (`--exclude-dir`,
  `--exclude`), **and**
- the actual target directory (grep's own path argument if given, otherwise
  the shell's cwd) contains `node_modules` or `.git` as an immediate child.

Target-aware, not just cwd-aware: `grep -rn TODO scripts/` from a repo root
that has `node_modules` is fine, because `scripts/` itself doesn't. Best-effort
argument parsing (`extractGrepTargets`) skips flags and their values to find
the real target; it deliberately tolerates misparsing shell redirects like
`2>/dev/null` as a stray extra target, since that only produces a harmless
nonexistent path — it never causes an under-detection.

**Escape hatch:** if a search genuinely needs to look inside `node_modules` or
`.git` (a specific vendored package), targeting that path directly (or `cd`ing
into it first) satisfies the check — a specific vendored subpath is a
legitimate narrow target, not a broad, unbounded one.

## Configuration

`PI_SCOPE_EXTRA_DENY` — colon-separated extra path prefixes to treat as broad,
e.g. a large mounted volume you never want scanned:

```bash
PI_SCOPE_EXTRA_DENY="/Volumes/BigDrive:/mnt/nas"
```

## Known limitations

- The `find`→`mdfind` translator only understands `-maxdepth`/`-mindepth`,
  `-type`, `-name`/`-iname`, `-print`/`-print0`. Anything else (predicates,
  `-exec`, pipes, `;`/`&`) falls back to a hard block rather than risk a wrong
  translation.
- `mdfind` reflects the Spotlight index, not a live filesystem view — it can
  miss recently created files or paths excluded from indexing (some network
  volumes, `.git` internals).
- Grep target extraction is a best-effort tokenizer, not a real shell parser.
  It doesn't understand full quoting/escaping edge cases; when in doubt it
  favors *not* under-detecting real risk over being byte-perfect.

## History

Went through several iterations before landing here — the full narrative
(including a nasty pm2/`pi-web` host-level extension-caching bug that made
edits look like they weren't taking effect) is written up in
`personal-notes/AI/pi-coding-agent.md`. Short version: v1 tried to keep the
agent inside a workspace root (too restrictive, wrong default under a hosted
process); v2–v3 dropped that in favor of only blocking genuinely broad roots
and added the `mdfind` substitution; this version adds the recursive-grep
check and fixes a `process.cwd()` vs. `ctx.cwd()` bug that made the guard
judge every session against the *host* process's directory instead of the
session's real one under a persistently-running host like `pi-web`/pm2.
