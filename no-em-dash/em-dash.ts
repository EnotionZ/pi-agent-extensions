/**
 * Deterministic em dash -> plain-punctuation rewriter.
 *
 * Source material: a grep of every em dash (U+2014) across this workspace's
 * `plan/` and `_docs/` folders (roughly 190 occurrences, almost entirely
 * AI-generated prose in `plan/career-goals-skills.md`), plus a round of
 * manual stress-testing against constructions that corpus didn't happen to
 * contain (interjections, cataphoric setups, numeric ranges, interrupted
 * dialogue). The corpus showed a narrow set of usages:
 *
 *   1. A SPLIT dash: exactly one em dash in a sentence, joining two clauses,
 *      e.g. "...instead of real em/en dashes — the model would have read
 *      backslash characters instead of punctuation."
 *   2. A PAIRED dash: exactly two em dashes in a sentence, bracketing a
 *      parenthetical aside, e.g. "A dashboard card area in `candidate` —
 *      new — carrying the live goal cards..."
 *
 * No sentence in the corpus had three or more; every dash was written with a
 * surrounding space on each side (`word — word`, never `word—word`). The
 * rules below are built from that shape, but are written to degrade
 * sensibly for the cases the corpus didn't contain (odd counts > 1, no
 * surrounding spaces) rather than assume they can't happen.
 *
 * Design:
 *  - Code spans (`` `like this` ``) and fenced code blocks (```like this```)
 *    are left untouched. secret-guard.ts hit exactly this failure mode
 *    (touching code corrupted documentation and its own source); the same
 *    fix applies here — never rewrite inside code.
 *  - Text is split into sentences (terminal `.`/`!`/`?` followed by
 *    whitespace + capital/quote/paragraph-break). Em dashes are paired off
 *    within a sentence, left to right: dash 1 & 2 become a parenthetical
 *    pair, 3 & 4 become another pair, and so on. A trailing unpaired dash
 *    (an odd count) is handled by the split rule.
 *  - PAIRED dash -> both become commas: "A — B — C" -> "A, B, C". A comma
 *    pair is the deterministic, always-grammatical stand-in for a
 *    parenthetical aside; it's what most style guides call the safe
 *    fallback for an em-dash aside.
 *  - SPLIT dash -> the punctuation is chosen from what precedes and follows
 *    the dash, checked in this order:
 *      1. Nothing follows the dash (a trailing quote/bracket at most) ->
 *         ELLIPSIS. Not a clause join at all -- interrupted dialogue
 *         trailing off ("Wait, I didn't mean—"), which conventionally gets
 *         "...", not a comma.
 *      2. A digit immediately precedes and follows the dash -> EN DASH, no
 *         spaces. Not a clause join either -- a numeric range (3—5pm,
 *         2020—2021) written with the wrong dash character. Every rule
 *         below this one would otherwise chop the range into two unrelated
 *         "sentences".
 *      3. The clause *before* the dash ends with a cataphoric setup phrase
 *         ("the problem", "one thing", "the result", ...) -> COLON. These
 *         phrases explicitly promise an explanation/restatement/list next,
 *         which is a colon's job, not a semicolon's.
 *      4. Next clause starts with an uppercase letter -> PERIOD (the two
 *         sides read as separate sentences already; the corpus never used a
 *         capital letter after a dash for anything but a fresh sentence).
 *      5. Next clause's first word is a subordinator or coordinating
 *         conjunction ("which", "because", "so", "but", ...), OR the clause
 *         right before the dash is a bare interjection ("Sure", "Okay",
 *         ...) with no subject-verb pair of its own -> COMMA. A semicolon
 *         needs an independent clause on both sides; neither of these gives
 *         it one.
 *      6. Otherwise -> SEMICOLON (two independent clauses, closely related,
 *         no conjunction between them -- the semicolon's textbook job, and
 *         the majority case in the corpus: "...instead of punctuation; the
 *         same escapes inside `.py` string literals were harmless...").
 *  - Output spacing is always canonical for the chosen mark (", ", "; ",
 *    ". ", ": ") regardless of whether the source dash had spaces around
 *    it, so both spaced and unspaced em dashes normalize the same way. The
 *    numeric-range case is the one exception: it produces an unspaced en
 *    dash, matching normal range typography (3–5pm, not 3 – 5pm).
 */

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

// Words that open a dependent/subordinate clause or a coordinating
// conjunction. When the text right after a split dash starts with one of
// these, standard English already uses a comma there, not a semicolon.
const CLAUSE_MARKER_WORDS = new Set([
	"which",
	"that",
	"who",
	"whom",
	"whose",
	"because",
	"since",
	"although",
	"though",
	"while",
	"if",
	"when",
	"unless",
	"whereas",
	"so",
	"but",
	"and",
	"or",
	"yet",
	"nor",
	"for",
]);

// Markdown/quote characters that can precede the first "real" letter of a
// clause (bold/italic markers, code ticks, quotes, brackets) and shouldn't
// affect the uppercase/lowercase or marker-word check.
const LEADING_MARKUP_RE = /^[\s*_`~"'“‘([]+/;

// Same, but for stripping trailing markup/punctuation off the clause that
// comes *before* the dash, so "**Sure,**" or "Sure..." still matches "sure".
const TRAILING_MARKUP_RE = /[\s*_`~"'”’.,!?)\]]+$/;

// Bare interjections/acknowledgements: fragments with no subject-verb pair of
// their own. A semicolon presumes an independent clause on *both* sides, so
// when the clause immediately before the dash is one of these, that
// assumption doesn't hold -- "Sure -- here's the thing" wants a comma, the
// same way "Sure, here's the thing" would if written without a dash at all.
// Deliberately just a lookup, not a word-count cutoff: a short clause that
// *is* a full subject+verb pair ("It fails", "I agree") should still get a
// semicolon, not a comma splice.
const INTERJECTION_PHRASES = new Set([
	"sure",
	"yes",
	"no",
	"ok",
	"okay",
	"well",
	"right",
	"true",
	"fine",
	"exactly",
	"agreed",
	"fair",
	"fair enough",
	"got it",
	"of course",
	"no doubt",
	"indeed",
	"absolutely",
	"understood",
	"good",
	"great",
	"alright",
	"all right",
]);

// Cataphoric setup phrases: nouns that explicitly promise an explanation,
// restatement, or list right after them. When the clause before the dash
// contains one of these, what follows the dash is doing a colon's job
// ("the problem — X" reads exactly like "the problem: X"), not joining two
// independent clauses. Checked anywhere in the clause before the dash
// (case-insensitively, word-bounded) rather than only its literal last
// words, since the phrase is often followed by a modifier before the dash
// ("the reason is simple —", "one thing that matters —").
const CATAPHORIC_SETUP_PHRASES = new Set([
	"the problem",
	"the issue",
	"the reason",
	"the result",
	"the point",
	"the truth",
	"the catch",
	"the trick",
	"the answer",
	"the goal",
	"the plan",
	"the idea",
	"the rule",
	"the difference",
	"the deal",
	"the takeaway",
	"the bottom line",
	"the kicker",
	"the question",
	"the risk",
	"the tradeoff",
	"the trade-off",
	"the concern",
	"the upshot",
	"one thing",
	"the thing",
	"the fix",
	"the fear",
	"the worry",
	"the hope",
	"the worst part",
	"the good news",
	"the bad news",
	"the short version",
	"the long version",
	"the key",
]);

/** Does the clause immediately before the dash read as a bare interjection? */
function endsWithInterjection(before: string): boolean {
	const lastClause = lastClauseOf(before);
	return INTERJECTION_PHRASES.has(lastClause);
}

const CATAPHORIC_SETUP_RE = new RegExp(
	`\\b(${[...CATAPHORIC_SETUP_PHRASES].map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
);

/** Does the clause immediately before the dash contain a colon-cue phrase? */
function hasCataphoricSetup(before: string): boolean {
	return CATAPHORIC_SETUP_RE.test(lastClauseOf(before));
}

/**
 * The final clause of `before`: text after the last sentence-internal
 * punctuation mark (, ; :), lowercased and trimmed, or the whole
 * (already sentence-scoped) string if there is no such mark.
 */
function lastClauseOf(before: string): string {
	const stripped = before.replace(TRAILING_MARKUP_RE, "");
	const lastClauseMatch = stripped.match(/[^,;:]*$/);
	return (lastClauseMatch?.[0] ?? stripped).trim().toLowerCase();
}

interface Segment {
	/** Literal text to pass through untouched (code spans, fences). */
	literal?: string;
	/** Prose text eligible for em dash rewriting. */
	prose?: string;
}

/**
 * Split text into alternating literal (code) and prose segments so code
 * content is never rewritten. Handles fenced code blocks (```...```) and
 * inline code spans (`...`).
 */
function splitCodeAndProse(text: string): Segment[] {
	const segments: Segment[] = [];
	// Fenced blocks first (```...```, greedy across lines, non-greedy match),
	// then inline spans (`...`, no backtick inside). Alternate capture keeps
	// both kinds in one pass via a single regex with two alternatives.
	const re = /(```[\s\S]*?```|`[^`\n]*`)/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		if (match.index > lastIndex) {
			segments.push({ prose: text.slice(lastIndex, match.index) });
		}
		segments.push({ literal: match[0] });
		lastIndex = match.index + match[0].length;
	}
	if (lastIndex < text.length) {
		segments.push({ prose: text.slice(lastIndex) });
	}
	return segments;
}

/**
 * Split prose into sentence chunks, keeping the trailing whitespace/newlines
 * that follow each sentence attached to that sentence so re-joining is a
 * plain concatenation. A "sentence" ends at `.`/`!`/`?` (optionally followed
 * by closing quotes/brackets/markdown emphasis markers) followed by
 * whitespace, or at a paragraph break (blank line), or at end of string.
 */
function splitSentences(prose: string): string[] {
	const sentences: string[] = [];
	const boundaryRe = /[.!?]+(?:[)\]"'”’*_~]*)(?=\s|$)/g;
	let start = 0;
	let match: RegExpExecArray | null;
	while ((match = boundaryRe.exec(prose)) !== null) {
		const end = match.index + match[0].length;
		// Extend to swallow the run of whitespace that follows (including a
		// paragraph break), so it travels with this sentence.
		let wsEnd = end;
		while (wsEnd < prose.length && /\s/.test(prose[wsEnd])) wsEnd++;
		sentences.push(prose.slice(start, wsEnd));
		start = wsEnd;
		boundaryRe.lastIndex = wsEnd;
	}
	if (start < prose.length) sentences.push(prose.slice(start));
	return sentences;
}

function firstLetterInfo(text: string): { isUpper: boolean; firstWord: string } | null {
	const stripped = text.replace(LEADING_MARKUP_RE, "");
	const letterMatch = stripped.match(/[A-Za-z]/);
	if (!letterMatch) return null;
	const wordMatch = stripped.match(/[A-Za-z']+/);
	return {
		isUpper: letterMatch[0] === letterMatch[0].toUpperCase(),
		firstWord: (wordMatch?.[0] ?? "").toLowerCase(),
	};
}

/** Rewrite the em dashes within a single sentence chunk. */
function rewriteSentence(sentence: string): { text: string; count: number } {
	if (!sentence.includes(EM_DASH)) return { text: sentence, count: 0 };

	// Locate every em dash and the prose part it splits, ignoring the
	// whitespace that trails/leads each sentence chunk.
	const parts = sentence.split(EM_DASH);
	if (parts.length < 2) return { text: sentence, count: 0 };

	const dashCount = parts.length - 1;
	let count = 0;
	const out: string[] = [parts[0]];

	let i = 1;
	while (i <= dashCount) {
		const remainingDashes = dashCount - i + 1;
		const isPaired = remainingDashes >= 2;

		if (isPaired) {
			// Pair this dash with the next one: A — B — C -> A, B, C
			const before = out[out.length - 1];
			const middle = parts[i];
			const after = parts[i + 1];
			out[out.length - 1] = `${before.replace(/\s+$/, "")}, ${middle.trim()}`;
			out.push(`, ${after.replace(/^\s+/, "")}`);
			count += 2;
			i += 2;
			continue;
		}

		// Single trailing dash: choose the mark from what precedes/follows.
		const before = out[out.length - 1];
		const after = parts[i];
		const beforeTrimmed = before.replace(/\s+$/, "");
		const afterTrimmed = after.replace(/^\s+/, "");
		const info = firstLetterInfo(after);

		// 1. A closing quote/bracket immediately follows the dash --
		// interrupted dialogue trailing off, closed right there, not a
		// clause join. Fires whether or not the *outer* sentence keeps
		// going afterward ('...let me check the actual quer—" before
		// realizing...' is still an interruption closed by the quote; the
		// narration outside the quote doesn't change that). Only the
		// closing quote/bracket run right after the dash is consumed;
		// anything beyond it is untouched, already-punctuated prose.
		const closerMatch = afterTrimmed.match(/^["'”’)\]]+/);
		if (closerMatch || afterTrimmed.length === 0) {
			const closer = closerMatch?.[0] ?? "";
			const rest = afterTrimmed.slice(closer.length);
			out[out.length - 1] = `${beforeTrimmed}...${closer}${rest}`;
			count += 1;
			i += 1;
			continue;
		}

		// 2. Digit immediately on both sides -- a numeric range written with
		// the wrong dash, not a clause join. No spaces, matching normal
		// range typography.
		if (/\d$/.test(beforeTrimmed) && /^\d/.test(afterTrimmed)) {
			out[out.length - 1] = `${beforeTrimmed}${EN_DASH}${afterTrimmed}`;
			count += 1;
			i += 1;
			continue;
		}

		let mark: string;
		if (hasCataphoricSetup(before)) {
			// 3. "the problem — X" / "one thing — X" promises an explanation,
			// exactly what a colon is for.
			mark = ":";
		} else if (info === null) {
			// No letters after the dash and it's not the interruption case
			// above (e.g. stray punctuation) -- comma is the least
			// disruptive default.
			mark = ",";
		} else if (info.isUpper) {
			// 4. Next clause reads as a fresh sentence.
			mark = ".";
		} else if (CLAUSE_MARKER_WORDS.has(info.firstWord) || endsWithInterjection(before)) {
			// 5. Either the next clause is a subordinator/conjunction, or the
			// clause right before the dash is a bare interjection ("Sure",
			// "Okay", ...) with no subject-verb pair of its own -- a
			// semicolon needs an independent clause on both sides, so this
			// isn't one.
			mark = ",";
		} else {
			// 6. Two independent clauses, closely related, no conjunction.
			mark = ";";
		}

		out[out.length - 1] = `${beforeTrimmed}${mark} ${afterTrimmed}`;
		count += 1;
		i += 1;
	}

	return { text: out.join(""), count };
}

/**
 * Replace every em dash (U+2014) in `text` with deterministic plain
 * punctuation (comma, semicolon, colon, period, ellipsis, or en dash for
 * numeric ranges), leaving code spans and fenced code blocks untouched.
 */
export function replaceEmDashes(text: string): { text: string; count: number } {
	if (!text.includes(EM_DASH)) return { text, count: 0 };

	const segments = splitCodeAndProse(text);
	let count = 0;
	const rewritten = segments.map((seg) => {
		if (seg.literal !== undefined) return seg.literal;
		const prose = seg.prose ?? "";
		if (!prose.includes(EM_DASH)) return prose;
		const sentences = splitSentences(prose);
		return sentences
			.map((s) => {
				const r = rewriteSentence(s);
				count += r.count;
				return r.text;
			})
			.join("");
	});

	return { text: rewritten.join(""), count };
}
