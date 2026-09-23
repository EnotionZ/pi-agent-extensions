# secret-guard

Redacts secret-shaped values (API keys, tokens, private key blocks,
password/secret assignments, credentials embedded in URLs) out of the
**assistant's own reply text** before it's finalized into the
transcript/session/provider request.

## Scope — deliberately narrow

This does **not** touch tool input or tool output. Reading a `.env`, `cat`-ing
a file, grepping for a key name, or any other `tool_call`/`tool_result`
content is left completely alone. The concern this guards against is the
model *printing* a secret in its own chat reply, not a tool reading one
internally — checking whether a variable exists, or matching a line with
`env | grep TOKEN`, is expected and useful agent behavior and shouldn't be
interfered with.

An earlier version also hooked `tool_result` to redact raw tool output. That
caused real collateral damage and was removed:

- It corrupted documentation that used realistic-looking example secrets to
  explain what gets redacted (reading the doc back through any pi tool
  re-triggered the same redaction on the *examples*).
- It corrupted reads of this extension's own source code —
  `SECRET_PATTERNS: SecretPattern[]` (a TypeScript type annotation) was
  misread as a `KEY: value` assignment, because `SECRET_PATTERNS` contains
  the substring `SECRET` and is followed by `: SecretPattern[]`.

Narrowing to `message_end` only removes that whole class of false positive by
construction: there's no legitimate reason for the assistant's own prose
reply to contain a real secret unless it's about to relay one.

## Patterns it catches

- PEM-style private key blocks (`-----BEGIN ... PRIVATE KEY-----`)
- AWS access key IDs (`AKIA...`)
- GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`)
- Slack tokens (`xox[baprs]-...`)
- Stripe keys (`sk_live_`/`pk_live_`/`rk_live_`/`*_test_`)
- Anthropic keys (`sk-ant-...`)
- OpenAI-style keys (`sk-...`)
- Google API keys (`AIza...`)
- JWTs (`eyJ...`)
- `user:password@host` embedded in a URL
- Generic `KEY=value` / `KEY: value` assignments where `KEY` contains
  `SECRET`/`TOKEN`/`PASSWORD`/`API_KEY`/`ACCESS_KEY`/`PRIVATE_KEY`/
  `CREDENTIAL(S)`/`CLIENT_SECRET`

Matched values are replaced with `[REDACTED:<pattern-name>]`, preserving the
surrounding text (`API_KEY=[REDACTED:assignment]` rather than dropping the
whole line) so the model can still report that a variable exists and is
non-empty — just not its value.

## False-positive guards

Two heuristics keep it from flagging things that merely *look* secret-shaped:

- **`hasLongSequentialRun`** — a run of 6+ strictly-consecutive characters
  (`abcdefg`, `0123456789`) is a strong signal of documentation/placeholder
  filler, not a real secret. Cryptographically random tokens essentially
  never contain a long monotonic run.
- **`looksLikeCodeIdentifierOrType`** — a bare, digit-free, mixed-case
  identifier (optionally an array/generic type, e.g. `SecretPattern[]`,
  `Record<string, string>`) reads as a source-code type or identifier, not a
  secret value. Real secrets are essentially always quoted strings or contain
  digits/symbols.
- **`PLACEHOLDER_VALUES`** — an explicit denylist of common placeholder
  literals (`changeme`, `xxxx`, `your_key_here`, `example`, `todo`, etc.).

An empty assignment (`EMPTY_TOKEN=`) is left alone entirely — no redaction —
so the model can still tell "set" from "unset."

## Known limitations

- Pattern-based: a bespoke internal token format with no recognizable
  prefix/name hint won't be caught.
- Only guards the assistant's own message text — see "Scope" above. If a
  secret needs to never appear anywhere in the session file at all (not just
  the chat transcript), this extension is not sufficient on its own.

## History

Full narrative — including the two collateral-damage incidents that led to
narrowing the scope to `message_end` only — is written up in
`personal-notes/AI/pi-coding-agent.md`.
