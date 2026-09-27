import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { repairOldText } from "./oldtext-repair.ts";

describe("repairOldText", () => {
	test("no-op when oldText has no escape sequence", () => {
		const file = "Some plain text.";
		const result = repairOldText("Some plain text.", file);
		assert.equal(result.repaired, false);
		assert.equal(result.text, "Some plain text.");
	});

	test("no-op when oldText already matches the file as-is", () => {
		const file = "It wrote a literal \\u2014 escape, verbatim.";
		const oldText = "a literal \\u2014 escape";
		const result = repairOldText(oldText, file);
		assert.equal(result.repaired, false);
		assert.equal(result.text, oldText);
	});

	test("repairs an em dash escape when the real dash is the unique match", () => {
		const file = "The plan works \u2014 mostly, and ships tomorrow.";
		const oldText = "The plan works \\u2014 mostly";
		const result = repairOldText(oldText, file);
		assert.equal(result.repaired, true);
		assert.equal(result.text, "The plan works \u2014 mostly");
		assert.ok(file.includes(result.text));
	});

	test("repairs a checkmark escape the same way", () => {
		const file = "| 1 | HSTS | \u2705 Remediated |\n| 2 | CSP | \u2705 Remediated |";
		const oldText = "| 1 | HSTS | \\u2705 Remediated |";
		const result = repairOldText(oldText, file);
		assert.equal(result.repaired, true);
		assert.equal(result.text, "| 1 | HSTS | \u2705 Remediated |");
	});

	test("does not repair when the decoded candidate matches nowhere", () => {
		const file = "No special characters here at all.";
		const oldText = "Missing \\u2014 dash";
		const result = repairOldText(oldText, file);
		assert.equal(result.repaired, false);
		assert.equal(result.text, oldText);
	});

	test("does not repair when the decoded candidate matches more than once (ambiguous)", () => {
		const file = "First \u2014 one. Second \u2014 one.";
		const oldText = "\\u2014 one.";
		const result = repairOldText(oldText, file);
		assert.equal(result.repaired, false, "ambiguous match must be left alone, same as the edit tool's own rule");
		assert.equal(result.text, oldText);
	});

	test("repairs multiple distinct escapes within the same oldText", () => {
		const file = "Contact: \u201cquoted\u201d \u2014 done.";
		const oldText = 'Contact: \\u201cquoted\\u201d \\u2014 done.';
		const result = repairOldText(oldText, file);
		assert.equal(result.repaired, true);
		assert.equal(result.text, 'Contact: \u201cquoted\u201d \u2014 done.');
	});

	test("applies to non-prose file types too (unlike escape-guard.ts's newText repair)", () => {
		// A .ts file whose comment legitimately contains a real em dash;
		// escape-guard.ts would never touch this (not a prose path), but
		// oldText verification against real bytes makes it safe here.
		const file = "// The result \u2014 not the input \u2014 is what matters.\nexport const x = 1;";
		const oldText = "// The result \\u2014 not the input \\u2014 is what matters.";
		const result = repairOldText(oldText, file);
		assert.equal(result.repaired, true);
		assert.equal(result.text, "// The result \u2014 not the input \u2014 is what matters.");
	});
});
