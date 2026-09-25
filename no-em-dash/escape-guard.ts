/**
 * Repairs a literal `\u2014`/`\u2013` escape-sequence artifact back into the
 * real character, in prose content a tool is about to write to disk.
 *
 * Why this exists: the reminder (reminder.ts) tells the model not to use em
 * dashes in its replies, and separately that tool-call arguments needing to
 * reproduce an *existing* em dash should use the literal character, never an
 * escape. In practice this is a hard needle to thread while generating —
 * across one real session, the model producing this file wrote the literal
 * six characters `\`, `u`, `2`, `0`, `1`, `4` instead of the actual U+2014
 * character three separate times while drafting new Markdown prose that
 * *wanted* a real dash (not reproducing anything). The reminder alone did
 * not prevent it; only grepping the result after the fact caught it each
 * time. This is a deterministic backstop for exactly that failure, the same
 * design principle as em-dash.ts itself: don't rely on the model getting a
 * mechanical text detail right on every generation, verify and fix it.
 *
 * Scope, deliberately narrow:
 *  - Only the write tool's `content` and the edit tool's `newText` are ever
 *    touched — never `oldText`. `oldText` has to match a file's existing
 *    bytes to find its target; if the model mistakenly wrote an escape there
 *    instead of a real dash, mutating it could make it match something it
 *    shouldn't (or silently paper over a real mismatch). Left alone, a wrong
 *    `oldText` just fails the edit visibly ("text not found") instead of
 *    corrupting anything — a safe failure mode that doesn't need a fix.
 *  - Only prose paths (`.md`, `.mdx`, `.markdown`, `.txt`): a literal
 *    `"\u2014"` inside a `.ts`/`.py`/`.js`/`.json` string literal is the
 *    normal, correct way to encode that character in source code and must
 *    never be rewritten. This guard has no way to tell "meant literally" from
 *    "meant as a mistake" inside code, so it doesn't try; it only acts where
 *    the observed failure actually happened.
 *  - Only outside code spans/fences within that prose, reusing em-dash.ts's
 *    own code/prose split. A document *describing* this exact bug (like the
 *    one that prompted writing this guard) legitimately quotes the escape
 *    sequence inside backticks as an example -- e.g. "wrote a literal
 *    `\u2014` escape sequence" -- and that has to survive untouched, or the
 *    guard would corrupt the very documentation that explains it.
 */

import { splitCodeAndProse } from "./em-dash.ts";

const ESCAPE_PATTERN = /\\u201[34]/g;

const PROSE_EXTENSIONS = [".md", ".mdx", ".markdown", ".txt"];

/** Does this path look like prose rather than source code? */
export function isProsePath(path: string): boolean {
	const lower = path.toLowerCase();
	return PROSE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const REPLACEMENTS: Record<string, string> = {
	"\\u2014": "\u2014",
	"\\u2013": "\u2013",
};

/**
 * Replace literal `\u2014`/`\u2013` escape-sequence text with the real
 * character, outside of code spans/fences. Returns the text unchanged (by
 * reference-equal value, though not reference-identical) when there's
 * nothing to do.
 */
export function repairEscapedDashes(text: string): { text: string; count: number } {
	if (!ESCAPE_PATTERN.test(text)) return { text, count: 0 };
	ESCAPE_PATTERN.lastIndex = 0;

	const segments = splitCodeAndProse(text);
	let count = 0;
	const rewritten = segments.map((seg) => {
		if (seg.literal !== undefined) return seg.literal;
		const prose = seg.prose ?? "";
		return prose.replace(ESCAPE_PATTERN, (match) => {
			count += 1;
			return REPLACEMENTS[match] ?? match;
		});
	});

	return { text: rewritten.join(""), count };
}
