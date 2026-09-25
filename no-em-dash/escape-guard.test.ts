import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { repairEscapedDashes, isProsePath } from "./escape-guard.ts";

describe("isProsePath", () => {
	test("markdown paths are prose", () => {
		for (const p of ["notes.md", "plan/foo.md", "README.mdx", "docs/x.markdown"]) {
			assert.ok(isProsePath(p), p);
		}
	});

	test("plain text paths are prose", () => {
		assert.ok(isProsePath("notes.txt"));
	});

	test("source code paths are not prose", () => {
		for (const p of ["em-dash.ts", "script.py", "index.js", "data.json", "README"]) {
			assert.ok(!isProsePath(p), p);
		}
	});

	test("case-insensitive extension match", () => {
		assert.ok(isProsePath("NOTES.MD"));
	});
});

describe("repairEscapedDashes", () => {
	test("no-op on text without the escape sequence", () => {
		const s = "Nothing to fix here — this already has a real dash.";
		const result = repairEscapedDashes(s);
		assert.equal(result.text, s);
		assert.equal(result.count, 0);
	});

	test("repairs a literal em dash escape into the real character", () => {
		const result = repairEscapedDashes("The plan works \\u2014 mostly.");
		assert.equal(result.text, "The plan works \u2014 mostly.");
		assert.equal(result.count, 1);
	});

	test("repairs a literal en dash escape into the real character", () => {
		const result = repairEscapedDashes("pages 12\\u201314");
		assert.equal(result.text, "pages 12\u201314");
		assert.equal(result.count, 1);
	});

	test("repairs multiple occurrences", () => {
		const result = repairEscapedDashes("One \\u2014 two \\u2014 three.");
		assert.equal(result.text, "One \u2014 two \u2014 three.");
		assert.equal(result.count, 2);
	});

	// The exact regression this guard exists for: documentation that
	// legitimately quotes the escape sequence as an example, inside
	// backticks, must survive untouched, or the guard corrupts the very
	// text explaining the bug.
	test("leaves an intentional backtick-quoted example alone", () => {
		const s = "it wrote a literal `\\u2014` escape sequence instead of the character.";
		const result = repairEscapedDashes(s);
		assert.equal(result.text, s);
		assert.equal(result.count, 0);
	});

	test("leaves a fenced code block's escape sequence alone", () => {
		const s = "```ts\nconst EM_DASH = \"\\u2014\";\n```\nExplained above \\u2014 see the block.";
		const result = repairEscapedDashes(s);
		assert.ok(result.text.includes('"\\u2014"'), "fenced code should be untouched");
		assert.ok(result.text.includes("Explained above \u2014 see the block."));
		assert.equal(result.count, 1);
	});

	test("mixed: one intentional (backtick) and one accidental (bare prose)", () => {
		const s = "The bug: writing `\\u2014` instead of \\u2014 the real character.";
		const result = repairEscapedDashes(s);
		assert.equal(result.text, "The bug: writing `\\u2014` instead of \u2014 the real character.");
		assert.equal(result.count, 1);
	});

	test("idempotent: running twice does nothing extra the second time", () => {
		const once = repairEscapedDashes("Broken \\u2014 text.");
		const twice = repairEscapedDashes(once.text);
		assert.equal(twice.count, 0);
		assert.equal(twice.text, once.text);
	});
});
