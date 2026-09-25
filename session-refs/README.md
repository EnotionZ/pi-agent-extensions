# session-refs

Keeps a per-session list of the GitHub PRs and Asana tasks/projects the
session created, changed, or mentioned, and shows it as a `refs` widget.

- **pi-web:** a `refs` button by the chat input (the same surface pi-subagents
  uses for its `agents` tab). Tap it for a panel of clickable links with titles
  and state, e.g. `PR Qwestly/api-python#145 merged refactor(llm): ... created`.
- **Terminal:** a compact block above the editor: the summary and the 4 most
  recent items.

## What gets picked up

| Source | Counts | Action |
| --- | --- | --- |
| User and assistant messages | any `github.com/<o>/<r>/pull/<n>` or Asana task/project URL | mentioned |
| `gh pr create` | PR URLs it prints; title from `--title` when there is one | created |
| `gh pr comment/merge/edit/review/close/reopen/ready` | URL or number + `--repo` argument, else the URL it prints | updated |
| `gh pr view/checks/diff/checkout` | URL or number + `--repo` argument | mentioned |
| `gh api repos/o/r/pulls/N...` | the path (`issues/N` only when writing) | mentioned / updated |
| `asana-cli POST /tasks` (and `/tasks/<gid>/subtasks`, `/projects`) | gids in the JSON response, or a lone gid when piped through `jq` | created |
| `asana-cli GET/PUT/POST /tasks/<gid>...`, `/projects/<gid>...` | the gid in the path; name, state and permalink from the response | mentioned (GET) / updated |
| `asana-cli POST /sections/<id>/addTask` | `"task": "<gid>"` in the request body | updated |

Deliberately **not** picked up: URLs in arbitrary tool output (`cat`, `grep`,
`gh pr list`, `gh search`, Asana search/list endpoints), URLs inside heredoc
bodies (a PR body linking other PRs), `git push`'s `pull/new/<branch>` hint, and
failed Asana calls (`"errors"` in the response). Otherwise reading a changelog
would add every PR in it.

An action only goes up (mentioned < updated < created), so the list shows the
most significant thing the session did with each object.

Backtested against the 60 most recent real sessions: 17 had references, 179 in
total (50 created, 22 updated, 107 mentioned). The outlier was a release
summary that linked 65 PRs in one reply, all correctly "mentioned".

## Titles and state

New or changed refs are looked up in the background:

- PRs: `gh pr view <url> --json title,state,isDraft,url` gives open / draft /
  merged / closed.
- Asana: `asana-cli GET /tasks/<gid>` (or `/projects/<gid>`) gives the name,
  done / archived, and the real permalink, replacing the built
  `https://app.asana.com/0/0/<gid>/f` URL.

`/refs refresh` re-checks everything, e.g. after a PR merges.

## `/refs`

| Command | Does |
| --- | --- |
| `/refs` | pick a reference: insert its link into the prompt, refresh it, or remove it |
| `/refs add <url...>` | add PR/Asana URLs by hand (also restores a removed one) |
| `/refs refresh` | re-fetch titles and state |
| `/refs remove` | pick one to remove |
| `/refs clear` | remove all (asks first) |

Removal sticks: a later *mention* does not bring a ref back; creating or
changing it again does, as does `/refs add`.

## Storage

Each change is one `pi.appendEntry("session-refs", record)` (`upsert`,
`remove`, or `clear`). Custom entries are saved in the session file but never
sent to the model. The list is rebuilt from the active branch at
`session_start` and `session_tree`, so it is correct after `/reload`, a resume,
pi-web evicting an idle session, a fork, or `/tree` navigation. Records are
written at `turn_end`/`agent_end` (or at once when idle), never in the middle
of a tool batch.

## pi-web rendering constraints

These come from reading pi-web 0.9.3's compiled client and are handled in
`render.ts`:

- The panel runs lines through ansi_up. OSC 8 hyperlinks become `<a href>`
  only when the link text is printable ASCII and the URL is at most 512 ASCII
  characters; anything else would leave a raw ESC on screen. So links use an
  ASCII label (`owner/repo#n`, an ASCII task name, or the gid), and non-ASCII
  titles sit next to the link.
- The links have no `target="_blank"`, so a plain tap navigates the pi-web tab
  itself. Long-press or middle-click to open in a new tab.
- A widget of 2 or 3 lines opens by itself when the page loads. The list is
  padded to at least 4 lines so it stays a closed button.
- The panel is capped at `min(144px, 18dvh)` and scrolls, so only about 5
  lines show at once. The order is: created, then updated, then mentioned;
  within each, PRs before Asana; then first seen.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_REFS_DISABLE` | unset | `1` disables the extension |
| `PI_REFS_ENRICH` | on | `0` turns off background `gh` / `asana-cli` lookups |
| `PI_REFS_ASANA_CLI` | `~/.pi/agent/skills/asana/asana-cli` | path to the Asana CLI used for lookups |

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Hooks, background lookups, widget, `/refs` |
| `detect.ts` | Pure: URL parsing, shell splitting, `gh` / `asana-cli` interpretation |
| `store.ts` | Pure: merge rules, record replay, ordering |
| `render.ts` | Pure: widget lines, OSC 8 links, dialog labels |
| `*.test.ts` | Unit tests (46) |

```sh
cd ~/.pi/agent/extensions/session-refs
node --test *.test.ts
```

Reload with `/reload`; pi-web caches extensions per process, so restart it
(`pm2 restart pi-web`) to pick up a new extension.
