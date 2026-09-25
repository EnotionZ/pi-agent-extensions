/**
 * Invisible-Unicode carrier removal ("Layer A").
 *
 * A TypeScript port of `service/scripts/text_unicode.py` from
 * https://github.com/guillaumemeyer/watermarks-remover (MIT). Strips the
 * edit-based carriers a model can hide in text: zero-width characters, bidi
 * overrides, tag characters, variation selectors, noncharacters, reserved
 * default-ignorables, private-use code points, stray format (Cf) controls,
 * and exotic space homoglyphs (normalized to U+0020).
 *
 * The part worth porting faithfully is not the strip list but the
 * preservation rules: the same code points are load-bearing in context
 * (ZWJ inside an emoji sequence, ZWNJ in Persian, VS16 after an emoji base,
 * tag characters inside a subdivision flag, directional marks in RTL prose,
 * Mongolian/Khmer/Hangul fillers after their own script). Stripping those
 * visibly changes the text, so they are kept, and everything else goes.
 *
 * Pure, dependency-free, and safe to unit test without a pi session.
 * Keep escapes (`\u200B`) rather than literal invisible characters in this
 * file and its tests: the extension's own write guard would strip literals.
 */

export interface CleanOptions {
	/** Replace exotic spaces (NBSP, NNBSP, thin space, ...) with U+0020. */
	normalizeSpaces?: boolean;
	/**
	 * Strip private-use code points. Default true. Turned off for files:
	 * Nerd Font / Powerline icons live in the PUA, and a shell-prompt config
	 * full of them is a real thing to write, not a carrier.
	 */
	stripPrivateUse?: boolean;
}

export interface CleanResult {
	text: string;
	/** Code points removed. */
	removed: number;
	/** Code points replaced (space homoglyphs). */
	replaced: number;
	/** Counts by kind, e.g. `{ zero_width: 3, space: 1 }`. */
	kinds: Record<string, number>;
}

const STRIP_CODEPOINTS = new Set<number>([
	0x00ad, // soft hyphen
	0x034f, // combining grapheme joiner
	0x061c, // Arabic letter mark
	0x115f, 0x1160, // Hangul choseong/jungseong fillers
	0x17b4, 0x17b5, // Khmer inherent vowels
	0x180b, 0x180c, 0x180d, 0x180e, 0x180f, // Mongolian FVS1-3, vowel separator, FVS4
	0x200b, 0x200c, 0x200d, // ZWSP, ZWNJ, ZWJ
	0x200e, 0x200f, // LRM, RLM
	0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE, RLE, PDF, LRO, RLO
	0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner, invisible math operators
	0x2066, 0x2067, 0x2068, 0x2069, // LRI, RLI, FSI, PDI
	0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, // deprecated format controls
	0xfeff, // BOM / ZWNBSP
	0xfe00, 0xfe01, 0xfe02, 0xfe03, 0xfe04, 0xfe05, 0xfe06, 0xfe07,
	0xfe08, 0xfe09, 0xfe0a, 0xfe0b, 0xfe0c, 0xfe0d, 0xfe0e, 0xfe0f, // VS1-16
	0x3164, 0xffa0, // Hangul fillers
	0xfff9, 0xfffa, 0xfffb, // interlinear annotation
]);

const SPACE_HOMOGLYPHS = new Set<number>([
	0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
	0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
]);

const BIDI = new Set<number>([
	0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);
/** Marks and isolates are legitimate in mixed RTL/LTR prose; keep them. */
const PRESERVABLE_BIDI = new Set<number>([0x061c, 0x200e, 0x200f, 0x2066, 0x2067, 0x2068, 0x2069]);
const ZW_FAMILY = new Set<number>([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e]);
const EMOJI_GLUE = new Set<number>([0x200d, 0xfe0e, 0xfe0f]);
const SCRIPT_JOINERS = new Set<number>([0x200c, 0x200d]);
const ORTHOGRAPHIC_CF = new Set<number>([
	0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x08e2, 0x110bd, 0x110cd,
]);
const MONGOLIAN_FVS = new Set<number>([0x180b, 0x180c, 0x180d, 0x180f]);
const KHMER_VOWELS = new Set<number>([0x17b4, 0x17b5]);
const HANGUL_FILLERS = new Set<number>([0x115f, 0x1160, 0x3164, 0xffa0]);

/** Egyptian / Duployan / musical format controls: [controls, their script]. */
const LAYOUT_CF: [number, number, number, number][] = [
	[0x13430, 0x1343f, 0x13000, 0x143ff],
	[0x1bca0, 0x1bca3, 0x1bc00, 0x1bca3],
	[0x1d173, 0x1d17a, 0x1d100, 0x1d1ff],
];

const RE_LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const RE_LETTER = /^\p{L}$/u;
const RE_FORMAT = /^\p{Cf}$/u;

const inRange = (cp: number, lo: number, hi: number) => cp >= lo && cp <= hi;

const isVsSupplement = (cp: number) => inRange(cp, 0xe0100, 0xe01ef);
const isTagChar = (cp: number) => inRange(cp, 0xe0001, 0xe007f);
const isFlagTag = (cp: number) => inRange(cp, 0xe0020, 0xe007f);
const isNoncharacter = (cp: number) => inRange(cp, 0xfdd0, 0xfdef) || (cp & 0xfffe) === 0xfffe;
const isReservedIgnorable = (cp: number) =>
	cp === 0x2065 ||
	cp === 0xe0000 ||
	inRange(cp, 0xfff0, 0xfff8) ||
	inRange(cp, 0xe0080, 0xe00ff) ||
	inRange(cp, 0xe01f0, 0xe0fff);
const isPrivateUse = (cp: number) =>
	inRange(cp, 0xe000, 0xf8ff) || inRange(cp, 0xf0000, 0xffffd) || inRange(cp, 0x100000, 0x10fffd);
const isVariationSelector = (cp: number) =>
	isVsSupplement(cp) || inRange(cp, 0xfe00, 0xfe0f) || MONGOLIAN_FVS.has(cp);

function isEmojiBase(cp: number): boolean {
	return (
		inRange(cp, 0x1f000, 0x1faff) ||
		inRange(cp, 0x2190, 0x25ff) ||
		inRange(cp, 0x2600, 0x27bf) ||
		inRange(cp, 0x2b00, 0x2bff) ||
		[0x203c, 0x2049, 0x2139, 0x2934, 0x2935].includes(cp) ||
		[0x00a9, 0x00ae, 0x2122, 0x3030, 0x303d, 0x3297, 0x3299].includes(cp) ||
		cp === 0x23 ||
		cp === 0x2a ||
		inRange(cp, 0x30, 0x39) // keycap bases
	);
}

function joiningScript(cp: number): string | undefined {
	if (!RE_LETTER_OR_MARK.test(String.fromCodePoint(cp))) return undefined;
	if (inRange(cp, 0x0600, 0x08ff)) return "arabic";
	if (inRange(cp, 0x0900, 0x0dff)) return "indic";
	if (inRange(cp, 0x0f00, 0x109f)) return "south-asian";
	if (inRange(cp, 0x1780, 0x17ff)) return "khmer";
	if (inRange(cp, 0x1800, 0x18af)) return "mongolian";
	return undefined;
}

const isCjkIdeograph = (cp: number) =>
	inRange(cp, 0x3400, 0x4dbf) ||
	inRange(cp, 0x4e00, 0x9fff) ||
	inRange(cp, 0xf900, 0xfaff) ||
	inRange(cp, 0x20000, 0x323af);
const isLetterIn = (cp: number, lo: number, hi: number) =>
	inRange(cp, lo, hi) && RE_LETTER.test(String.fromCodePoint(cp));
const isHangulJamo = (cp: number) =>
	inRange(cp, 0x1100, 0x11ff) ||
	inRange(cp, 0xa960, 0xa97c) ||
	inRange(cp, 0xd7b0, 0xd7c6) ||
	inRange(cp, 0x3131, 0x318e) ||
	inRange(cp, 0xffa1, 0xffdc);

/** Glue does not advance the "previous kept base", so ZWJ chains stay bound. */
const isGlue = (cp: number) =>
	EMOJI_GLUE.has(cp) ||
	isVariationSelector(cp) ||
	SCRIPT_JOINERS.has(cp) ||
	isFlagTag(cp) ||
	MONGOLIAN_FVS.has(cp) ||
	KHMER_VOWELS.has(cp) ||
	HANGUL_FILLERS.has(cp);

function isStrip(cp: number, stripPrivateUse: boolean): boolean {
	return (
		STRIP_CODEPOINTS.has(cp) ||
		isVsSupplement(cp) ||
		isTagChar(cp) ||
		isNoncharacter(cp) ||
		isReservedIgnorable(cp) ||
		(stripPrivateUse && isPrivateUse(cp))
	);
}

function stripKind(cp: number): string {
	if (isTagChar(cp)) return "tag_chars";
	if (isNoncharacter(cp)) return "noncharacter";
	if (isReservedIgnorable(cp)) return "reserved_ignorable";
	if (isVariationSelector(cp)) return "variation_selector";
	if (BIDI.has(cp)) return "bidi";
	if (ZW_FAMILY.has(cp)) return "zero_width";
	if (isPrivateUse(cp)) return "private_use";
	return "format";
}

/** Indices (into the code point array) inside complete subdivision-flag tag runs. */
function validFlagTagIndices(cps: number[]): Set<number> {
	const valid = new Set<number>();
	let i = 0;
	while (i < cps.length) {
		if (cps[i] !== 0x1f3f4) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < cps.length && inRange(cps[j], 0xe0020, 0xe007e)) j++;
		if (j > i + 1 && j < cps.length && cps[j] === 0xe007f) {
			for (let k = i + 1; k <= j; k++) valid.add(k);
			i = j + 1;
		} else {
			i++;
		}
	}
	return valid;
}

/** Indices of complete LRE/RLE ... PDF pairs (overrides stay strippable). */
function validBidiEmbeddingIndices(cps: number[]): Set<number> {
	const valid = new Set<number>();
	const stack: [number, number][] = [];
	cps.forEach((cp, index) => {
		if (cp === 0x202a || cp === 0x202b || cp === 0x202d || cp === 0x202e) {
			stack.push([cp, index]);
		} else if (cp === 0x202c) {
			const top = stack.pop();
			if (top && (top[0] === 0x202a || top[0] === 0x202b)) {
				valid.add(top[1]);
				valid.add(index);
			}
		}
	});
	return valid;
}

type Decision = { action: "keep" } | { action: "strip"; kind: string } | { action: "replace"; kind: string };

const KEEP: Decision = { action: "keep" };

function decide(
	cp: number,
	prevKept: number | undefined,
	prevInput: number | undefined,
	nextInput: number | undefined,
	validFlagTag: boolean,
	validBidiEmbedding: boolean,
	opts: Required<CleanOptions>,
): Decision {
	if (validBidiEmbedding || PRESERVABLE_BIDI.has(cp)) return KEEP;

	if (prevInput !== undefined) {
		if (isVsSupplement(cp) && isCjkIdeograph(prevInput)) return KEEP;
		if (MONGOLIAN_FVS.has(cp) && inRange(prevInput, 0x1800, 0x18af)) return KEEP;
		if (inRange(cp, 0xfe00, 0xfe0d) && isCjkIdeograph(prevInput)) return KEEP;
	}

	if (EMOJI_GLUE.has(cp)) {
		if ((cp === 0xfe0e || cp === 0xfe0f) && prevInput !== undefined && isEmojiBase(prevInput)) return KEEP;
		if (
			cp === 0x200d &&
			prevKept !== undefined &&
			nextInput !== undefined &&
			isEmojiBase(prevKept) &&
			isEmojiBase(nextInput)
		)
			return KEEP;
	}

	if (SCRIPT_JOINERS.has(cp) && prevInput !== undefined && nextInput !== undefined) {
		const a = joiningScript(prevInput);
		if (a !== undefined && a === joiningScript(nextInput)) return KEEP;
	}
	if (isFlagTag(cp) && validFlagTag) return KEEP;
	if (MONGOLIAN_FVS.has(cp) && prevKept !== undefined && isLetterIn(prevKept, 0x1800, 0x18af)) return KEEP;
	if (KHMER_VOWELS.has(cp) && prevKept !== undefined && isLetterIn(prevKept, 0x1780, 0x17ff)) return KEEP;
	if (HANGUL_FILLERS.has(cp) && prevKept !== undefined && isHangulJamo(prevKept)) return KEEP;
	if (ORTHOGRAPHIC_CF.has(cp)) return KEEP;
	for (const [cLo, cHi, sLo, sHi] of LAYOUT_CF) {
		if (
			inRange(cp, cLo, cHi) &&
			((prevInput !== undefined && inRange(prevInput, sLo, sHi)) ||
				(nextInput !== undefined && inRange(nextInput, sLo, sHi)))
		)
			return KEEP;
	}

	if (isStrip(cp, opts.stripPrivateUse)) return { action: "strip", kind: stripKind(cp) };
	if (opts.normalizeSpaces && SPACE_HOMOGLYPHS.has(cp)) return { action: "replace", kind: "space" };
	if (!SPACE_HOMOGLYPHS.has(cp) && RE_FORMAT.test(String.fromCodePoint(cp))) {
		return { action: "strip", kind: "format" };
	}
	return KEEP;
}

/**
 * Anything outside printable ASCII + common whitespace could be a carrier.
 * Cheap pre-check so the common all-ASCII case never builds a code point array.
 */
const MAYBE_SUSPICIOUS = /[^\x09\x0a\x0d\x20-\x7e]/;

export function cleanInvisibleUnicode(text: string, options: CleanOptions = {}): CleanResult {
	const opts: Required<CleanOptions> = {
		normalizeSpaces: options.normalizeSpaces ?? true,
		stripPrivateUse: options.stripPrivateUse ?? true,
	};
	if (!MAYBE_SUSPICIOUS.test(text)) return { text, removed: 0, replaced: 0, kinds: {} };

	const cps = Array.from(text, (ch) => ch.codePointAt(0) as number);
	const flagTags = validFlagTagIndices(cps);
	const bidiPairs = validBidiEmbeddingIndices(cps);
	const out: string[] = [];
	const kinds: Record<string, number> = {};
	let removed = 0;
	let replaced = 0;
	let prevKept: number | undefined;

	for (let i = 0; i < cps.length; i++) {
		const cp = cps[i];
		const d = decide(cp, prevKept, cps[i - 1], cps[i + 1], flagTags.has(i), bidiPairs.has(i), opts);
		if (d.action === "keep") {
			out.push(String.fromCodePoint(cp));
			if (!isGlue(cp)) prevKept = cp;
		} else if (d.action === "replace") {
			out.push(" ");
			replaced++;
			kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
			prevKept = 0x20;
		} else {
			removed++;
			kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
		}
	}

	if (removed === 0 && replaced === 0) return { text, removed: 0, replaced: 0, kinds: {} };
	return { text: out.join(""), removed, replaced, kinds };
}
