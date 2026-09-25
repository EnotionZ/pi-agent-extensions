/**
 * Pure logic for catching a placeholder where a real edit replacement belongs.
 * No pi imports, so it can be tested with `node --test`.
 *
 * The failure this exists for, seen repeatedly in a long real session: the
 * model means to rewrite a block, calls edit with the old block and a stand-in
 * replacement ("x", "unused", a literal "null"), planning to fix it in a
 * follow-up call. The edit succeeds, so nothing flags it. If the follow-up is
 * late or wrong, working text (a function signature, a paragraph) has been
 * replaced with a stray token, and later errors get diagnosed as something
 * else. An instruction against it (AGENTS-LOCAL.md) did not stop it; like the
 * other guards here, this checks the mechanical detail instead of trusting the
 * instruction.
 *
 * Deliberately narrow, because a false block costs a legitimate edit:
 *  - A missing newText is left to pi's schema validation, which rejects it.
 *  - An empty replacement is always allowed. That is how a deletion is
 *    written, and it is unambiguous.
 *  - Only replacements that are nothing but a known placeholder token count.
 *    "None", "0", "false" and other real one-word values are not on the list.
 *  - Only when the text being replaced is substantial (several lines, or a
 *    long line). Swapping one short token for another is ordinary editing.
 */

export type Verdict = { block: true; reason: string } | undefined;

/** Replacement text that is almost never meant literally in place of a real span. */
const PLACEHOLDERS = new Set([
	"x",
	"xx",
	"xxx",
	"todo",
	"tbd",
	"tk",
	"fixme",
	"unused",
	"placeholder",
	"null",
	"undefined",
	"...",
	"\u2026",
]);

/** Old text at least this long (or spanning this many lines) counts as a real span. */
const SUBSTANTIAL_CHARS = 80;
const SUBSTANTIAL_LINES = 2;

/** Existing files smaller than this are not protected from a placeholder write. */
const SUBSTANTIAL_FILE_BYTES = 200;

export function isPlaceholder(text: string): boolean {
	const bare = text
		.trim()
		.replace(/^[`"'<\[(]+|[`"'>\])]+$/g, "")
		.trim()
		.toLowerCase();
	return PLACEHOLDERS.has(bare);
}

function isSubstantial(text: string): boolean {
	return text.length >= SUBSTANTIAL_CHARS || text.split("\n").filter((l) => l.trim()).length >= SUBSTANTIAL_LINES;
}

function describe(text: string): string {
	const lines = text.split("\n").length;
	return lines > 1 ? `${lines} lines` : `${text.length} characters`;
}

interface EditLike {
	oldText?: unknown;
	newText?: unknown;
}

/** The edits an `edit` call carries, in either the multi-edit or the single-edit shape. */
function editsOf(input: Record<string, unknown>): EditLike[] {
	if (Array.isArray(input.edits)) return input.edits as EditLike[];
	if ("oldText" in input || "newText" in input) return [input as EditLike];
	return [];
}

export function checkEdit(input: Record<string, unknown>): Verdict {
	const edits = editsOf(input);
	for (const [index, edit] of edits.entries()) {
		const which = edits.length > 1 ? `edits[${index}]` : "the edit";
		const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
		// A missing or non-string newText is left to pi's own schema validation,
		// which already rejects it (seen 15 times in real sessions).
		if (typeof edit.newText !== "string") continue;
		if (edit.newText !== "" && isPlaceholder(edit.newText) && isSubstantial(oldText)) {
			return {
				block: true,
				reason:
					`Blocked: ${which} would replace ${describe(oldText)} with the placeholder ${JSON.stringify(edit.newText)}. ` +
					"Compose the complete replacement before calling edit, in this same call, rather than clearing the text now " +
					'and fixing it in a follow-up. To delete the old text on purpose, pass newText: "".',
			};
		}
	}
	return undefined;
}

/**
 * A `write` whose whole content is a placeholder, over an existing file of any
 * real size. `existingSize` returns the file's size in bytes, or undefined when
 * it does not exist.
 */
export function checkWrite(input: Record<string, unknown>, existingSize: (path: string) => number | undefined): Verdict {
	const content = input.content;
	const path = typeof input.path === "string" ? input.path : "";
	if (typeof content !== "string" || !path || !isPlaceholder(content)) return undefined;
	const size = existingSize(path);
	if (size === undefined || size < SUBSTANTIAL_FILE_BYTES) return undefined;
	return {
		block: true,
		reason:
			`Blocked: this write would replace ${path} (${size} bytes) with the placeholder ${JSON.stringify(content)}. ` +
			"Write the complete file content in this call.",
	};
}
