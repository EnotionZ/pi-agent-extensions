# pi-agent-extensions

Dominick's personal extensions for [pi](https://github.com/earendil-works/pi-coding-agent), a coding agent CLI. Each subfolder is a self-contained extension, auto-discovered from `~/.pi/agent/extensions/`.

## Extensions

- **[agents-md-anchor](./agents-md-anchor)** - keeps project instructions effective in long sessions: pins `AGENTS-LOCAL.md` into the system prompt, re-states the "Always apply" rules (and the pinned `AGENTS-LOCAL.md` itself) after compaction or long stretches, and guards against AGENTS.md going missing from the prompt.
- **[edit-guard](./edit-guard)** - blocks an `edit` that would replace real text with a placeholder (`x`, `unused`, `TODO`, a literal `null`) meant to be fixed in a follow-up call, and a `write` that would do the same to a whole file.
- **[no-em-dash](./no-em-dash)** - keeps em dashes out of assistant replies via a prompt-level reminder plus a deterministic rewrite pass.
- **[no-watermarks](./no-watermarks)** - strips AI provenance marks from any provider's model: invisible-Unicode carriers (zero-width, bidi, tag characters, exotic spaces) from replies and written files, and agent attribution (`Co-authored-by: Claude/Codex/Cursor/Copilot/...`, "Generated with ...", session links) from commit and PR messages.
- **[scope-guard](./scope-guard)** - blocks (or transparently substitutes) shell commands prone to hanging by walking too much of the filesystem, e.g. `find /` or an unbounded recursive `grep` over `node_modules`.
- **[session-refs](./session-refs)** - keeps a per-session list of GitHub PRs and Asana tasks the session created, changed, or mentioned, shown as a `refs` widget (a button with clickable links in pi-web) and managed with `/refs`.
- **[secret-guard](./secret-guard)** - redacts secret-shaped values (API keys, tokens, credentials) out of the assistant's own reply text before it's finalized.

See each extension's own README for details, configuration, and design rationale.

## Installation

Clone or symlink a folder into `~/.pi/agent/extensions/`; pi auto-discovers any folder containing an `index.ts`/`index.js` (or a top-level `*.ts`/`*.js` file) and loads it on session start. Run `/reload` in an active session to pick up changes without restarting.
