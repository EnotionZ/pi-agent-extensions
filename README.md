# pi-agent-extensions

Dominick's personal extensions for [pi](https://github.com/earendil-works/pi-coding-agent), a coding agent CLI. Each subfolder is a self-contained extension, auto-discovered from `~/.pi/agent/extensions/`.

## Extensions

- **[no-em-dash](./no-em-dash)** - keeps em dashes out of assistant replies via a prompt-level reminder plus a deterministic rewrite pass.
- **[scope-guard](./scope-guard)** - blocks (or transparently substitutes) shell commands prone to hanging by walking too much of the filesystem, e.g. `find /` or an unbounded recursive `grep` over `node_modules`.
- **[secret-guard](./secret-guard)** - redacts secret-shaped values (API keys, tokens, credentials) out of the assistant's own reply text before it's finalized.

See each extension's own README for details, configuration, and design rationale.

## Installation

Clone or symlink a folder into `~/.pi/agent/extensions/`; pi auto-discovers any folder containing an `index.ts`/`index.js` (or a top-level `*.ts`/`*.js` file) and loads it on session start. Run `/reload` in an active session to pick up changes without restarting.
