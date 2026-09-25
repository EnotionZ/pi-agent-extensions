import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asanaTask, githubPr } from "./detect.ts";
import { ENTRY_TYPE, merge, recordsFrom, replay, type RefRecord, visible } from "./store.ts";

const pr = githubPr("Qwestly", "candidate", 412, "mentioned");
const up = (at: number, ref: RefRecord extends infer R ? (R extends { op: "upsert"; ref: infer D } ? D : never) : never): RefRecord => ({ v: 1, op: "upsert", at, ref });

describe("merge", () => {
	test("first sighting creates the ref", () => {
		const r = merge(undefined, pr, 10)!;
		assert.equal(r.firstAt, 10);
		assert.equal(r.action, "mentioned");
	});

	test("a repeat changes nothing", () => {
		const r = merge(undefined, pr, 10)!;
		assert.equal(merge(r, pr, 20), undefined);
	});

	test("action only goes up; title and state update", () => {
		const r1 = merge(undefined, { ...pr, action: "created" }, 10)!;
		assert.equal(merge(r1, pr, 20), undefined, "mention after create is not news");
		const r2 = merge(r1, { ...pr, title: "Fix login", state: "open" }, 30)!;
		assert.equal(r2.action, "created");
		assert.equal(r2.title, "Fix login");
		assert.equal(r2.firstAt, 10);
		assert.equal(r2.lastAt, 30);
	});

	test("a real URL replaces a built one, never the reverse", () => {
		const built = merge(undefined, asanaTask("1218404968130028", "mentioned"), 1)!;
		assert.equal(built.urlSynthetic, true);
		const real = merge(built, asanaTask("1218404968130028", "mentioned", "https://app.asana.com/0/5/1218404968130028"), 2)!;
		assert.equal(real.url, "https://app.asana.com/0/5/1218404968130028");
		assert.equal(real.urlSynthetic, undefined);
		assert.equal(merge(real, asanaTask("1218404968130028", "mentioned"), 3), undefined);
	});

	test("removed stays removed on a mention, comes back on update or manual add", () => {
		const removed = { ...merge(undefined, pr, 1)!, removed: true };
		assert.equal(merge(removed, pr, 2), undefined);
		assert.equal(merge(removed, { ...pr, action: "updated" }, 3)!.removed, undefined);
		const manual = merge(removed, { ...pr, manual: true }, 4)!;
		assert.equal(manual.removed, undefined);
		assert.equal(manual.manual, undefined, "manual is a record flag, not ref state");
	});
});

describe("replay", () => {
	test("rebuilds the same list the live merges produced", () => {
		const records: RefRecord[] = [
			up(1, pr),
			up(2, { ...pr, action: "created", title: "Fix login" }),
			up(3, asanaTask("1218404968130028", "updated")),
			{ v: 1, op: "remove", at: 4, key: "asana-task:1218404968130028" },
			up(5, asanaTask("1218404968130028", "mentioned")),
		];
		const refs = replay(records);
		const shown = visible(refs);
		assert.deepEqual(shown.map((r) => [r.key, r.action, r.title]), [["github-pr:qwestly/candidate#412", "created", "Fix login"]]);
		assert.equal(refs.get("asana-task:1218404968130028")!.removed, true);
	});

	test("clear hides everything; later activity brings items back", () => {
		const refs = replay([up(1, pr), { v: 1, op: "clear", at: 2 }, up(3, { ...pr, action: "updated" })]);
		assert.equal(visible(refs).length, 1);
		assert.equal(visible(replay([up(1, pr), { v: 1, op: "clear", at: 2 }])).length, 0);
	});

	test("visible: by action, then PRs before Asana, then first seen", () => {
		const refs = replay([
			up(1, asanaTask("1111111111", "mentioned")),
			up(2, githubPr("o", "r", 2, "mentioned")),
			up(3, githubPr("o", "r", 1, "mentioned")),
			up(4, asanaTask("2222222222", "created")),
			up(5, githubPr("o", "r", 9, "updated")),
		]);
		assert.deepEqual(visible(refs).map((r) => r.label), ["2222222222", "o/r#9", "o/r#2", "o/r#1", "1111111111"]);
	});
});

describe("recordsFrom", () => {
	test("keeps only this extension's well-formed records", () => {
		const good = up(1, pr);
		const entries = [
			{ type: "message" },
			{ type: "custom", customType: "other", data: good },
			{ type: "custom", customType: ENTRY_TYPE, data: good },
			{ type: "custom", customType: ENTRY_TYPE, data: { v: 2, op: "upsert", at: 1, ref: pr } },
			{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, op: "remove", at: 1 } },
			{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, op: "clear", at: 2 } },
		];
		assert.deepEqual(recordsFrom(entries), [good, { v: 1, op: "clear", at: 2 }]);
	});
});
