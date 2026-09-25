import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asanaTask, githubPr } from "./detect.ts";
import { itemLine, link, plainLine, renderWidget, summary, tidy } from "./render.ts";
import type { Ref } from "./store.ts";

const ref = (d: ReturnType<typeof githubPr>, extra: Partial<Ref> = {}, at = 1): Ref => ({ ...d, firstAt: at, lastAt: at, ...extra });
const strip = (s: string) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");

// The exact OSC 8 pattern ansi_up 6 (pi-web) accepts; anything else leaves a raw ESC.
const ANSI_UP_OSC8 = /\x1b\]8;[\x20-\x3a\x3c-\x7e]*;([\x21-\x7e]{0,512})(?:\x1b\\|\x07)([\x20-\x7e]+)\x1b\]8;;(?:\x1b\\|\x07)/;

describe("link", () => {
	test("produces an OSC 8 link ansi_up can parse", () => {
		const m = ANSI_UP_OSC8.exec(link("https://github.com/o/r/pull/1", "o/r#1"))!;
		assert.equal(m[1], "https://github.com/o/r/pull/1");
		assert.equal(m[2], "o/r#1");
	});

	test("falls back to plain text for non-ASCII text, bad or non-http URLs", () => {
		assert.equal(link("https://x.test/a", "caf\u00e9"), "caf\u00e9");
		assert.equal(link("javascript:alert(1)", "x"), "x");
		assert.equal(link("not a url", "x"), "x");
		assert.equal(link(`https://x.test/${"a".repeat(600)}`, "x"), "x");
	});

	test("non-ASCII URL characters are percent-encoded rather than dropped", () => {
		assert.match(link("https://x.test/caf\u00e9", "x"), /caf%C3%A9/);
	});
});

describe("lines", () => {
	const p = ref(githubPr("Qwestly", "candidate", 412, "created"), { title: "Fix login redirect", state: "merged" });
	const t = ref(asanaTask("1218404968130028", "mentioned"), { title: "Ship the export page", state: "done" }, 2);
	const tNonAscii = ref(asanaTask("1218404968130029", "updated"), { title: "R\u00e9sum\u00e9 import \u2014 v2" }, 3);

	test("PR line links the label and shows state, title, action", () => {
		const line = itemLine(p);
		assert.equal(ANSI_UP_OSC8.exec(line)![2], "Qwestly/candidate#412");
		assert.equal(strip(line), "PR Qwestly/candidate#412 merged Fix login redirect created");
	});

	test("ASCII Asana names are the link; non-ASCII names sit outside it", () => {
		assert.equal(ANSI_UP_OSC8.exec(itemLine(t))![2], "Ship the export page");
		const line = itemLine(tNonAscii);
		assert.equal(ANSI_UP_OSC8.exec(line)![2], "1218404968130029");
		assert.match(strip(line), /R\u00e9sum\u00e9 import \u2014 v2 updated$/);
	});

	test("titles are stripped of control characters and truncated", () => {
		assert.equal(tidy("a\x1b[31mb\n\nc"), "a [31mb c");
		assert.equal(tidy("x".repeat(100), 10).length, 10);
	});

	test("summary and plain dialog line", () => {
		assert.equal(summary([p, t, tNonAscii]), "1 PR, 2 Asana tasks");
		assert.equal(plainLine(p), "PR Qwestly/candidate#412 - Fix login redirect (merged, created)");
	});

	test("rich widget: header, every item, padded to 4 lines so pi-web keeps it closed", () => {
		const one = renderWidget([p], "rich")!;
		assert.equal(one.length, 4);
		assert.match(strip(one[0]!), /^1 PR \u00b7 \/refs to manage$/);
		assert.equal(renderWidget([p, t, tNonAscii, p, p], "rich")!.length, 6);
	});

	test("compact widget: most recent items and a count of the rest", () => {
		const many = Array.from({ length: 6 }, (_, i) => ref(githubPr("o", "r", i + 1, "mentioned"), {}, i));
		const lines = renderWidget(many, "compact", 3)!;
		assert.deepEqual(lines.slice(1, 4).map((l) => ANSI_UP_OSC8.exec(l)![2]), ["o/r#4", "o/r#5", "o/r#6"]);
		assert.equal(strip(lines[4]!), "\u2026 3 more");
	});

	test("no refs clears the widget", () => {
		assert.equal(renderWidget([], "rich"), undefined);
	});
});

test("Asana lines name the kind once", () => {
	const t = ref(asanaTask("1218404968130028", "created"));
	assert.equal(plainLine(t), "Task 1218404968130028 (created)");
	assert.equal(strip(itemLine(t)), "Task 1218404968130028 created");
});
