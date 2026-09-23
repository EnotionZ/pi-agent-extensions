import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EM_DASH_REMINDER, appendEmDashReminder } from "./reminder.ts";

describe("EM_DASH_REMINDER", () => {
	test("names the character it's warning about", () => {
		assert.ok(EM_DASH_REMINDER.includes("\u2014"));
	});

	test("carves out code, matching the deterministic extension's own scope", () => {
		assert.match(EM_DASH_REMINDER.toLowerCase(), /code/);
	});

	test("offers concrete alternatives", () => {
		for (const word of ["period", "comma", "semicolon", "colon"]) {
			assert.ok(EM_DASH_REMINDER.toLowerCase().includes(word), `missing "${word}"`);
		}
	});

	// Regression coverage for the live-testing finding: a bare prohibition
	// ("don't use em dashes, use X/Y/Z instead") leaves no procedure for
	// *which* mark fits, so the model defaults to a comma splice. The
	// reminder needs to state the actual decision procedure, not just list
	// the marks.
	test("gives a decision procedure, not just a list of marks", () => {
		const lower = EM_DASH_REMINDER.toLowerCase();
		assert.match(lower, /colon when|colon .*explain|colon .*restat|colon .*list/, "no guidance on when to use a colon");
		assert.match(lower, /semicolon .*independent clause|independent clause.*semicolon/, "no guidance on when to use a semicolon");
		assert.match(lower, /comma .*conjunction|conjunction.*comma/, "no guidance tying comma to a following conjunction");
	});

	// Regression coverage: "code you are editing verbatim" did not cover an
	// edit's old text in a docstring or Markdown file, so the model wrote an
	// escape instead of the literal character and the edit matched nothing.
	test("tells the model to reproduce existing em dashes literally in tool-call arguments", () => {
		const lower = EM_DASH_REMINDER.toLowerCase();
		assert.match(lower, /tool-call arguments/);
		assert.match(lower, /literal character/);
		assert.match(lower, /never an escape/);
	});

	test("scopes the prohibition to reply prose", () => {
		assert.match(EM_DASH_REMINDER.toLowerCase(), /prose of your replies/);
	});

	test("explicitly warns against defaulting to a comma splice", () => {
		assert.match(EM_DASH_REMINDER.toLowerCase(), /comma splice/);
	});

	test("names at least one cataphoric setup example, matching em-dash.ts's phrase list", () => {
		const lower = EM_DASH_REMINDER.toLowerCase();
		assert.ok(
			["the problem", "the reason", "one thing"].some((phrase) => lower.includes(phrase)),
			"expected at least one concrete cataphoric-setup example",
		);
	});
});

describe("appendEmDashReminder", () => {
	test("appends the reminder after the base prompt", () => {
		const base = "You are a helpful assistant.";
		const result = appendEmDashReminder(base);
		assert.ok(result.startsWith(base));
		assert.ok(result.includes(EM_DASH_REMINDER));
	});

	test("separates base prompt and reminder with a blank line", () => {
		const result = appendEmDashReminder("Base prompt.");
		assert.equal(result, `Base prompt.\n\n${EM_DASH_REMINDER}`);
	});

	test("trims trailing whitespace off the base prompt before appending", () => {
		const result = appendEmDashReminder("Base prompt.   \n\n  ");
		assert.equal(result, `Base prompt.\n\n${EM_DASH_REMINDER}`);
	});

	test("handles an empty base prompt", () => {
		const result = appendEmDashReminder("");
		assert.equal(result, `\n\n${EM_DASH_REMINDER}`);
	});

	test("is a pure function: same input, same output", () => {
		const base = "System prompt text here.";
		assert.equal(appendEmDashReminder(base), appendEmDashReminder(base));
	});
});
