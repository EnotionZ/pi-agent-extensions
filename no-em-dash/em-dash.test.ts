import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { replaceEmDashes } from "./em-dash.ts";

const EM = "\u2014";

function rw(s: string): string {
	return replaceEmDashes(s).text;
}

describe("no-op cases", () => {
	test("text with no em dash passes through unchanged", () => {
		const s = "Nothing to see here, just plain text with a comma.";
		assert.equal(rw(s), s);
		assert.equal(replaceEmDashes(s).count, 0);
	});

	test("empty string", () => {
		assert.equal(rw(""), "");
	});
});

describe("split dash -> period (next clause starts uppercase)", () => {
	test("single sentence, capitalized continuation", () => {
		const s = `The escapes were resolved at parse time ${EM} Python did that automatically.`;
		assert.equal(rw(s), "The escapes were resolved at parse time. Python did that automatically.");
	});

	test("counts one replacement", () => {
		const s = `A ${EM} B is capitalized.`;
		assert.equal(replaceEmDashes(s).count, 1);
	});
});

describe("split dash -> semicolon (independent clause, no conjunction)", () => {
	test("real corpus sentence: backslash escapes", () => {
		const s =
			`was written with literal escape-sequence text instead of real em/en dashes ${EM} ` +
			`the model would have read backslash characters instead of punctuation.`;
		assert.equal(
			rw(s),
			"was written with literal escape-sequence text instead of real em/en dashes; the model would have read backslash characters instead of punctuation.",
		);
	});

	test("real corpus sentence: cardinality", () => {
		const s = `guarantees exactly one row per member per goal ${EM} a stopgap that catches the drift rather than causing it.`;
		assert.equal(
			rw(s),
			"guarantees exactly one row per member per goal; a stopgap that catches the drift rather than causing it.",
		);
	});

	test("lowercase continuation starting with an article", () => {
		const s = `set_goal_metadata writes no version row ${EM} an empty diff in the history is noise.`;
		assert.equal(rw(s), "set_goal_metadata writes no version row; an empty diff in the history is noise.");
	});
});

describe("split dash -> comma (clause marker word follows)", () => {
	const cases: Array<[string, string]> = [
		[`the row holds wins ${EM} which is precisely the cardinality wanted.`, "the row holds wins, which is precisely the cardinality wanted."],
		[`removing it removes the card ${EM} because the card's state lives on that row.`, "removing it removes the card, because the card's state lives on that row."],
		[`a blank line is highest priority ${EM} so it splits there first.`, "a blank line is highest priority, so it splits there first."],
		[`not one per member forever ${EM} but a bounded set.`, "not one per member forever, but a bounded set."],
		[`the number is precise ${EM} and it should stay that way.`, "the number is precise, and it should stay that way."],
	];
	for (const [input, expected] of cases) {
		test(`marker word: ${input.split(EM)[1].trim().split(" ")[0]}`, () => {
			assert.equal(rw(input), expected);
		});
	}
});

describe("split dash -> comma (bare interjection precedes the dash)", () => {
	// A semicolon presumes an independent clause on both sides. "Sure",
	// "Okay", "Well", etc. aren't clauses at all, so they shouldn't get one
	// even though what follows doesn't start with a marker word.
	const cases: Array<[string, string]> = [
		[`Sure ${EM} here's a paragraph.`, "Sure, here's a paragraph."],
		[`Okay ${EM} that makes sense.`, "Okay, that makes sense."],
		[`Well ${EM} that changes things.`, "Well, that changes things."],
		[`Got it ${EM} moving on now.`, "Got it, moving on now."],
		[`Of course ${EM} that's the whole point.`, "Of course, that's the whole point."],
	];
	for (const [input, expected] of cases) {
		test(`interjection: ${input.split(EM)[0].trim()}`, () => {
			assert.equal(rw(input), expected);
		});
	}

	test("a genuine short independent clause still gets a semicolon, not a comma splice", () => {
		const s = `It fails ${EM} nothing else changed.`;
		assert.equal(rw(s), "It fails; nothing else changed.");
	});

	test("markdown emphasis around the interjection is still recognized", () => {
		const s = `**Sure** ${EM} that works.`;
		assert.equal(rw(s), "**Sure**, that works.");
	});
});

describe("paired dash -> commas (parenthetical aside)", () => {
	test("real corpus sentence: dashboard card area", () => {
		const s = `A dashboard card area in candidate ${EM} new ${EM} carrying the live goal cards.`;
		assert.equal(rw(s), "A dashboard card area in candidate, new, carrying the live goal cards.");
	});

	test("real corpus sentence: two doors", () => {
		const s = `The member clicks a card ${EM} "I want a raise" ${EM} or says it in chat.`;
		assert.equal(rw(s), `The member clicks a card, "I want a raise", or says it in chat.`);
	});

	test("counts two replacements for one pair", () => {
		const s = `A ${EM} B ${EM} C.`;
		assert.equal(replaceEmDashes(s).count, 2);
	});
});

describe("multi-sentence text", () => {
	test("each sentence's dashes are resolved independently", () => {
		const s =
			`First point stands alone ${EM} nothing more to add. ` +
			`Second point has an aside ${EM} a short one ${EM} in the middle. ` +
			`Third starts fresh ${EM} New sentence follows.`;
		assert.equal(
			rw(s),
			"First point stands alone; nothing more to add. " +
				"Second point has an aside, a short one, in the middle. " +
				"Third starts fresh. New sentence follows.",
		);
	});
});

describe("odd counts greater than one (not seen in corpus, must still degrade sensibly)", () => {
	test("three dashes: first pair becomes a parenthetical, trailing one splits", () => {
		const s = `A ${EM} B ${EM} C ${EM} because D.`;
		assert.equal(rw(s), "A, B, C, because D.");
	});

	test("four dashes: two parenthetical pairs", () => {
		const s = `A ${EM} B ${EM} C ${EM} D ${EM} E.`;
		assert.equal(rw(s), "A, B, C, D, E.");
	});
});

describe("spacing normalization", () => {
	test("no spaces around dash still resolves and gets canonical spacing", () => {
		const s = `wait${EM}really?`;
		// "really?" starts lowercase, not a marker word -> semicolon
		assert.equal(rw(s), "wait; really?");
	});

	test("asymmetric spacing (space on one side only)", () => {
		const s = `done ${EM}so move on.`;
		assert.equal(rw(s), "done, so move on.");
	});
});

describe("code is left untouched", () => {
	test("inline code span containing an em dash is preserved verbatim", () => {
		const s = `Use the literal \`a${EM}b\` token here ${EM} it is intentional.`;
		assert.equal(rw(s), `Use the literal \`a${EM}b\` token here; it is intentional.`);
	});

	test("fenced code block containing an em dash is preserved verbatim", () => {
		const s = "```\nconst x = 'a" + EM + "b';\n```\n" + `Explained above ${EM} see the block.`;
		const expected = "```\nconst x = 'a" + EM + "b';\n```\n" + "Explained above; see the block.";
		assert.equal(rw(s), expected);
	});

	test("no em dash left anywhere outside code after rewriting realistic prose", () => {
		const s =
			`The claim sweep carries both ${EM} found in review rather than in the design. ` +
			`\`user_projects\` needs its own step ${EM} a blanket \`updateMany\` fails when the claimed ${EM} unclaimed pair diverges.`;
		const { text, count } = replaceEmDashes(s);
		assert.ok(count > 0);
		// Strip code spans before asserting no dash remains, so a deliberately
		// dash-containing code token wouldn't produce a false failure here.
		const withoutCode = text.replace(/`[^`]*`/g, "");
		assert.ok(!withoutCode.includes(EM), `unexpected em dash left in: ${withoutCode}`);
	});
});

describe("split dash -> colon (cataphoric setup phrase precedes the dash)", () => {
	// "the problem", "one thing", etc. explicitly promise an explanation or
	// list right after them -- a colon's job, not a semicolon's, even when
	// there's a modifier between the setup noun and the dash.
	const cases: Array<[string, string]> = [
		[`There is only one thing that matters ${EM} results.`, "There is only one thing that matters: results."],
		[`The plan has three phases ${EM} design, then build, then ship.`, "The plan has three phases: design, then build, then ship."],
		[`The reason is simple ${EM} nobody checked.`, "The reason is simple: nobody checked."],
		[`Here's the catch ${EM} it only works offline.`, "Here's the catch: it only works offline."],
	];
	for (const [input, expected] of cases) {
		test(`setup phrase: ${input.split(EM)[0].trim()}`, () => {
			assert.equal(rw(input), expected);
		});
	}

	test("a setup phrase with no dash is left alone (no false positive)", () => {
		const s = "The problem was fixed quickly.";
		assert.equal(rw(s), s);
	});
});

describe("numeric ranges -> en dash, no clause punctuation", () => {
	test("digits on both sides of the dash", () => {
		const s = `Office hours are 3${EM}5.`;
		assert.equal(rw(s), "Office hours are 3\u20135.");
	});

	test("four-digit year range", () => {
		const s = `Fiscal years 2020${EM}2021 were merged.`;
		assert.equal(rw(s), "Fiscal years 2020\u20132021 were merged.");
	});

	test("digit range keeps no surrounding spaces even if the source dash had them", () => {
		const s = `pages 12 ${EM} 14`;
		assert.equal(rw(s), "pages 12\u201314");
	});

	test("one non-digit side is NOT treated as a range", () => {
		const s = `We shipped v2 ${EM} finally.`;
		assert.equal(rw(s), "We shipped v2; finally.");
	});
});

describe("interrupted dialogue -> ellipsis", () => {
	test("dash at the very end of the text", () => {
		const s = `Wait, I didn't mean${EM}`;
		assert.equal(rw(s), "Wait, I didn't mean...");
	});

	test("dash followed only by a closing quote", () => {
		const s = `"Wait, I didn't mean${EM}"`;
		assert.equal(rw(s), `"Wait, I didn't mean..."`);
	});

	test("dash followed by real content is NOT treated as interrupted", () => {
		const s = `Wait, I didn't mean ${EM} it came out wrong.`;
		assert.equal(rw(s), "Wait, I didn't mean; it came out wrong.");
	});

	// Regression: a quote closing right after the dash is still an
	// interruption even when the *outer* sentence keeps going past the
	// closing quote with its own, already-punctuated narration. An earlier
	// version only checked whether the entire rest of the sentence was
	// nothing but trailing quotes, so this fell through to the semicolon
	// default and split "quer" mid-word ("quer; \"") instead of closing the
	// interrupted word with an ellipsis.
	test("interruption closed by a quote, with narration continuing outside it", () => {
		const s =
			`I started reading the runbook, then stopped and said, "wait, this doesn't match the dashboard, let me check the actual quer${EM}" ` +
			`before realizing the query itself was fine; it was the cache that was stale.`;
		assert.equal(
			rw(s),
			'I started reading the runbook, then stopped and said, "wait, this doesn\'t match the dashboard, let me check the actual quer..." ' +
				"before realizing the query itself was fine; it was the cache that was stale.",
		);
	});
});

describe("idempotency", () => {
	test("running twice produces the same result as running once", () => {
		const s = `First run resolves this ${EM} the second run should find nothing left to do.`;
		const once = rw(s);
		const twice = rw(once);
		assert.equal(once, twice);
		assert.equal(replaceEmDashes(once).count, 0);
	});
});
