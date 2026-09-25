import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkEdit, checkWrite, isPlaceholder } from "./placeholder.ts";

const block = "quote comes back with their em dashes turned into other punctuation.\nWhat the agent does not touch\nis text it did not write.";

describe("isPlaceholder", () => {
	test("known placeholder tokens, any case, bare or wrapped", () => {
		for (const t of ["x", "X", "xxx", "TODO", "tbd", "unused", "null", "undefined", "...", "\u2026", "`x`", '"unused"', "<placeholder>", "[TODO]", "  x \n"]) {
			assert.ok(isPlaceholder(t), JSON.stringify(t));
		}
	});

	test("real values and real text are not placeholders", () => {
		for (const t of ["", "None", "0", "false", "true", "y", "the fixed sentence.", "x = 1", "TODO: wire the retry"]) {
			assert.ok(!isPlaceholder(t), JSON.stringify(t));
		}
	});
});

describe("checkEdit", () => {
	// The three shapes from the session that motivated this guard.
	test("blocks a placeholder replacing a multi-line span", () => {
		for (const newText of ["x", "unused", "PLACEHOLDER"]) {
			const verdict = checkEdit({ path: "a.md", edits: [{ oldText: block, newText }] });
			assert.ok(verdict?.block, newText);
			assert.match(verdict!.reason, /placeholder/);
			assert.match(verdict!.reason, /newText: ""/);
		}
	});

	test("a literal \"null\" string standing in for a block is blocked", () => {
		assert.ok(checkEdit({ path: "a.py", edits: [{ oldText: "def f():\n    pass", newText: "null" }] })?.block);
	});

	test("a missing or non-string newText is left to pi's schema validation", () => {
		assert.equal(checkEdit({ path: "a.py", edits: [{ oldText: block }] }), undefined);
		assert.equal(checkEdit({ path: "a.py", edits: [{ oldText: block, newText: null }] }), undefined);
	});

	test("names which edit in a multi-edit call", () => {
		const verdict = checkEdit({ path: "a.md", edits: [{ oldText: "a", newText: "b" }, { oldText: block, newText: "TODO" }] });
		assert.match(verdict!.reason, /edits\[1\]/);
	});

	test("an empty replacement is a deliberate deletion and is allowed", () => {
		assert.equal(checkEdit({ path: "a.md", edits: [{ oldText: block, newText: "" }] }), undefined);
	});

	test("a placeholder replacing a short token is ordinary editing", () => {
		assert.equal(checkEdit({ path: "a.ts", edits: [{ oldText: "const y = 1;", newText: "x" }] }), undefined);
		assert.equal(checkEdit({ path: "a.json", edits: [{ oldText: '"value": 3', newText: "null" }] }), undefined);
	});

	test("real replacements pass, however long the old text", () => {
		assert.equal(checkEdit({ path: "a.md", edits: [{ oldText: block, newText: "The rewritten paragraph." }] }), undefined);
		assert.equal(checkEdit({ path: "a.py", edits: [{ oldText: "x = compute(a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p)", newText: "None" }] }), undefined);
	});

	test("the single-edit input shape is checked too", () => {
		assert.ok(checkEdit({ path: "a.md", oldText: block, newText: "x" })?.block);
	});

	test("input with no edits is left alone", () => {
		assert.equal(checkEdit({ path: "a.md" }), undefined);
	});
});

describe("checkWrite", () => {
	const size = (bytes: number | undefined) => () => bytes;

	test("blocks a placeholder over an existing file of real size", () => {
		const verdict = checkWrite({ path: "notes.md", content: "TODO" }, size(5000));
		assert.ok(verdict?.block);
		assert.match(verdict!.reason, /5000 bytes/);
	});

	test("allows a placeholder for a new or tiny file", () => {
		assert.equal(checkWrite({ path: "new.md", content: "TODO" }, size(undefined)), undefined);
		assert.equal(checkWrite({ path: "tiny.md", content: "x" }, size(10)), undefined);
	});

	test("allows real content over any file", () => {
		assert.equal(checkWrite({ path: "notes.md", content: "# Notes\n\nReal content." }, size(5000)), undefined);
	});
});
