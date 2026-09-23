/**
 * The instruction injected into the system prompt every turn. Kept short
 * on purpose: this gets sent on every provider request for the turn, so
 * it's a small, permanent token cost rather than a one-time one.
 *
 * Explicitly scoped to prose, not code, mirroring the deterministic
 * extension's own carve-out (see ../no-em-dash/em-dash.ts) -- an em dash
 * inside a code block being read, quoted, or edited verbatim is not the
 * assistant "using" one.
 *
 * An earlier version just said "don't use em dashes, use a period, comma,
 * semicolon, or colon instead, whichever fits." Live testing with the
 * rewrite layer disabled showed that's not enough: told only what to avoid,
 * with no procedure for what to do instead, the model defaulted to the
 * cheapest fix on hand, almost always a comma, even in spots that clearly
 * wanted a colon ("Here's the catch, the retry logic assumes..." instead of
 * "Here's the catch: ...") or a semicolon. That produces comma splices the
 * rewrite layer can't catch, because it only ever sees text that already
 * contains an em dash; text the model routed around a dash to produce never
 * reaches it. So this version gives the model the same decision procedure
 * em-dash.ts already encodes, in prose, instead of a bare prohibition.
 */
export const EM_DASH_REMINDER =
	"Do not use em dashes (\u2014) anywhere in your response text. When you would reach for one, pick the mark that actually fits, the same way you would if you were never tempted to use a dash there: a colon when what follows explains, restates, or lists what you just named (\"the problem\", \"the reason\", \"one thing\"); a period when what follows is really a separate sentence; a comma only when a conjunction or relative pronoun follows (\"which\", \"because\", \"so\", \"but\", \"and\"...); and a semicolon otherwise, when joining two independent clauses with no conjunction between them. Do not default to a comma splice. This is about the prose you write, not about code you are reading, quoting, or editing verbatim.";

/**
 * Append the reminder to a system prompt for one turn. Idempotent within a
 * single call; not deduped across turns because `before_agent_start` hands
 * us a freshly rendered prompt each time; there is nothing to accumulate.
 */
export function appendEmDashReminder(systemPrompt: string): string {
	return `${systemPrompt.replace(/\s+$/, "")}\n\n${EM_DASH_REMINDER}`;
}
