/**
 * Repairs a literal `\uXXXX` escape-sequence artifact back into the real
 * character, in prose content a tool is about to write to disk.
 *
 * Why this exists: the reminder (reminder.ts) tells the model not to use em
 * dashes in its replies, and separately that tool-call arguments needing to
 * reproduce an *existing* special character should use the literal
 * character, never an escape. In practice this is a hard needle to thread
 * while generating: across multiple real sessions, the model has written
 * the literal six characters `\`, `u`, `2`, `0`, `1`, `4` instead of the
 * actual U+2014 character while drafting new Markdown prose that *wanted* a
 * real dash (not reproducing anything), and the same mistake recurs for
 * other codepoints too, not just dashes; a session that also needed a
 * checkmark (U+2705) in a status table wrote `\u2705` the same way. The
 * reminder alone does not prevent it; only grepping the result after the
 * fact caught it. This is a deterministic backstop for exactly that failure,
 * the same design principle as em-dash.ts itself: don't rely on the model
 * getting a mechanical text detail right on every generation, verify and fix
 * it. Originally scoped to just the em/en dash codepoints; generalized to
 * any 4-hex-digit escape once the same typo showed up for other characters,
 * since the risk profile (see scope below) doesn't depend on which
 * codepoint it is.
 *
 * Scope, deliberately narrow:
 *  - Only the write tool's `content` and the edit tool's `newText` are ever
 *    touched here, never `oldText`. `oldText` has to match a file's existing
 *    bytes to find its target; if the model mistakenly wrote an escape there
 *    instead of a real character, mutating it here (with no way to check
 *    against the file) could make it match something it shouldn't, or
 *    silently paper over a real mismatch. `oldtext-repair.ts` handles that
 *    case separately, with a different safety mechanism (verified against
 *    the actual file bytes) that this module doesn't have available.
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

/** Any 4-hex-digit `\uXXXX` escape -- covers every BMP codepoint, not just
 *  the em/en dash this guard started out fixing (checkmarks, curly quotes,
 *  bullets, ellipses have all shown up the same way in practice). */
const ESCAPE_PATTERN = /\\u([0-9a-fA-F]{4})/g;

const PROSE_EXTENSIONS = [".md", ".mdx", ".markdown", ".txt"];

/** Does this path look like prose rather than source code? */
export function isProsePath(path: string): boolean {
	const lower = path.toLowerCase();
	return PROSE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Decode a single `\uXXXX` match to its real character. */
function decodeEscape(hex: string): string {
	return String.fromCharCode(parseInt(hex, 16));
}

/**
 * Replace literal `\uXXXX` escape-sequence text with the real character,
 * outside of code spans/fences. Returns the text unchanged (by
 * reference-equal value, though not reference-identical) when there's
 * nothing to do.
 */
export function repairEscapedUnicode(text: string): { text: string; count: number } {
	if (!ESCAPE_PATTERN.test(text)) return { text, count: 0 };
	ESCAPE_PATTERN.lastIndex = 0;

	const segments = splitCodeAndProse(text);
	let count = 0;
	const rewritten = segments.map((seg) => {
		if (seg.literal !== undefined) return seg.literal;
		const prose = seg.prose ?? "";
		return prose.replace(ESCAPE_PATTERN, (_match, hex) => {
			count += 1;
			return decodeEscape(hex);
		});
	});

	return { text: rewritten.join(""), count };
}

/** Back-compat alias: the guard used to only handle em/en dashes. Kept so
 *  any external caller written against the old name keeps working. */
export const repairEscapedDashes = repairEscapedUnicode;
