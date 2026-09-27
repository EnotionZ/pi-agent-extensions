/**
 * Repairs a literal `\uXXXX` escape-sequence artifact in an `edit` tool's
 * `oldText`, verified against the real target file rather than guessed at.
 *
 * The recurring failure this exists for: the model, trying to reproduce an
 * existing em dash, checkmark, curly quote, or other special character
 * that's genuinely present in the file it's editing, types the literal
 * escape-sequence text (`\u2014`, `\u2705`, ...) instead of the real glyph.
 * `oldText` then fails to match anything, and the edit call comes back
 * "text not found" -- a safe failure (nothing is corrupted), but one that
 * has recurred across many real sessions, each time needing a manual
 * re-read-and-retry to recover from.
 *
 * escape-guard.ts already repairs this exact mistake, but deliberately only
 * in `newText`/`content` -- never `oldText` -- because it has no way to
 * check a guess against the file being edited, and repairing `oldText`
 * blind could turn a safe failure into a silent wrong-span match. This
 * module closes that gap with a mechanism escape-guard.ts doesn't have:
 * it reads the actual file the edit targets and only accepts the repair
 * when doing so takes `oldText` from "matches nowhere" to "matches exactly
 * once" in the file's real bytes. That's a much stronger guarantee than the
 * prose/code-span heuristics escape-guard.ts relies on for `newText` --
 * the repaired text has to be an exact, singular substring of the real
 * file, not merely a plausible-looking one -- so it applies to any file
 * type, not just prose paths, and to any escaped codepoint, not just dashes.
 *
 * If the original `oldText` already matches (nothing to repair), or the
 * repaired candidate matches zero or more than one location, this leaves
 * `oldText` untouched and the edit tool's own matching takes it from there
 * (including its normal "not found" / "ambiguous" errors).
 */

const ESCAPE_PATTERN = /\\u([0-9a-fA-F]{4})/g;

function decodeEscapes(text: string): string {
	return text.replace(ESCAPE_PATTERN, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** How many non-overlapping times does `needle` occur in `haystack`? Stops
 *  counting past 2 -- callers only care whether it's exactly one. */
function occurrences(haystack: string, needle: string, cap = 2): number {
	if (needle === "") return 0;
	let count = 0;
	let index = 0;
	for (;;) {
		const found = haystack.indexOf(needle, index);
		if (found === -1) break;
		count += 1;
		if (count >= cap) break;
		index = found + needle.length;
	}
	return count;
}

/**
 * Attempt to repair `oldText` against the real content of the file it's
 * meant to match. Returns the original `oldText` unchanged, with
 * `repaired: false`, whenever the repair isn't unambiguously safe.
 */
export function repairOldText(oldText: string, fileContent: string): { text: string; repaired: boolean } {
	if (!ESCAPE_PATTERN.test(oldText)) return { text: oldText, repaired: false };
	ESCAPE_PATTERN.lastIndex = 0;

	// Already matches as-is (e.g. the file itself legitimately contains the
	// literal escape text) -- nothing to do, and repairing it would be wrong.
	if (fileContent.includes(oldText)) return { text: oldText, repaired: false };

	const candidate = decodeEscapes(oldText);
	if (candidate === oldText) return { text: oldText, repaired: false };

	if (occurrences(fileContent, candidate) === 1) {
		return { text: candidate, repaired: true };
	}
	return { text: oldText, repaired: false };
}
