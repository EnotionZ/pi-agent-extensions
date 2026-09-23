# scope-guard

Blocks shell commands that are prone to hanging
by walking far more of the filesystem than intended — either by literally
targeting a broad root (`/`, `~`, `/System`, ...) or by recursively grepping a
directory that contains `node_modules`/`.git` without excluding them.

This exists because telling an agent "don't run `find /`" in `AGENTS.md` is
only a prompt-level hint — it can be ignored, forgotten after context
compaction, or never seen by a subagent that spins up mid-task. This enforces
it at the runtime level via a `tool_call` hook, regardless of what the model
was told.

## What it does

### How a command is read

The command is tokenized roughly the way a shell would (quotes, escapes,
`| || & && ; ( ) $( \``, process substitution, redirections, heredocs) and
split into simple commands. Each restricted scanner is then judged only on
**its own path arguments**, against a cwd that follows any `cd` earlier in the
command. Redirection targets (`2> /dev/null`) are never arguments; heredoc
bodies are data unless they are fed to a shell (`bash <<EOF`), and `bash -c
"..."` is analysed recursively.

An earlier version matched a scanner name anywhere in the command and then any
whitespace-preceded `/...` anywhere in the command, so `sed 's/a: /b/' f &&
npm test | grep passed`, a TypeScript `//` comment inside a heredoc, or a
commit message saying "find the / bug" were all blocked as "grep targeting
`/`". Those cases are pinned in `scope-check.test.ts`.

### 1. Broad-root guard

Blocks a walker when its target path (or the cwd, when it has none) resolves
to a broad root:

| Command | Judged when |
| --- | --- |
| `find` | always, on its starting points |
| `grep`/`egrep`/`fgrep` | only when recursive (`-r`, `-R`, `--recursive`, `-d recurse`); a plain grep reads files or stdin |
| `ls` | only with `-R`; `ls /` or `ls ~` lists one level and returns instantly |
| `tree` | unless `-L` bounds the depth |
| `du` | always; `-s`/`-d` still walk everything |
| `ag` | always (recursive by default) |
| built-in `find`/`grep`/`ls` tools | on their `path` argument |

Broad roots:

- `/` (filesystem root)
- a bare home directory (`~` or `/Users/you`)
- `/Users` or `/home` themselves (not a subpath of them)
- `/etc`, `/var`, `/usr`, `/opt`, `/System`, `/Library`, `/Applications`,
  `/proc`, `/sys`, `/dev`, `/private`, `/Volumes`

Anywhere else is fair game — this is not a project sandbox, it only stops the
"walked the whole disk and locked up" failure mode.

`fd`/`rg` are exempt entirely: they're already the fast, `.gitignore`-aware
alternative this guard would otherwise point you toward.

**It only blocks; it never rewrites.** The block reason tells the agent to
scope the search to a likely directory and use `fd`/`rg`/`find`/`grep` there.
An earlier version rewrote a simple `find <broad-root> -name X` into an
`mdfind` (Spotlight) query. That was dropped: Spotlight lags newly created
files and skips some paths (`.git` internals, some volumes), so the
substituted query could return nothing for a file that exists, which the agent
reads as "not found" rather than "blocked". Seen in practice with a file
created minutes earlier.

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
that has `node_modules` is fine, because `scripts/` itself doesn't. Argument
parsing skips flags and their values (`-e PATTERN`, `-m N`, `--include=...`)
to find the real targets. `xargs grep -r ...` with no explicit target takes
its targets from stdin, so it is not judged against the cwd.

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

## Layout and tests

| File | |
| --- | --- |
| `index.ts` | wires the checker into pi's `tool_call` hook |
| `scope-check.ts` | pure tokenizer and checker (`createScopeChecker`, `tokenize`) |
| `scope-check.test.ts` | regressions, still-allowed, still-blocked, no-rewrite |

```bash
node --test *.test.ts
```

Extensions only load at session start or `/reload` (or a host restart under
pm2), so test the module directly rather than through a live session.

## Known limitations

- The tokenizer is best-effort, not a real shell parser. A command
  substitution inside double quotes (`"$(find / ...)"`) stays part of the
  quoted word and is not analysed; `eval` and scripts run from files are not
  followed.
- `cd` tracking is linear: a `cd` inside a subshell `( ... )` is treated as if
  it persisted.

## History

Went through several iterations before landing here — the full narrative
(including a nasty pm2/`pi-web` host-level extension-caching bug that made
edits look like they weren't taking effect) is written up in
`personal-notes/AI/pi-coding-agent.md`. Short version: v1 tried to keep the
agent inside a workspace root (too restrictive, wrong default under a hosted
process); v2–v3 dropped that in favor of only blocking genuinely broad roots
and added the `mdfind` substitution; v4 added the recursive-grep check and
fixed a `process.cwd()` vs. `ctx.cwd()` bug that made the guard judge every
session against the *host* process's directory instead of the session's real
one under a persistently-running host like `pi-web`/pm2. v5 replaced the
whole-command regex matching with a shell-aware tokenizer (per-command
arguments, redirections, heredocs, `cd` tracking) after `sed`/`perl`
substitutions and heredoc comments were blocked as "grep targeting `/`", and
dropped the `mdfind` substitution after it silently missed a real file.
