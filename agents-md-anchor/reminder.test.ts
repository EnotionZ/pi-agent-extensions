import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	buildReminder,
	decideReminder,
	droppedInstructionFiles,
	extractSection,
	linkedMarkdownFiles,
	readPaths,
	REMINDER_CUSTOM_TYPE,
	resolveReadPath,
	type EntryLike,
} from "./reminder.ts";

const policy = { firstAt: 80_000, every: 80_000 };
const msg: EntryLike = { type: "message", message: { role: "user", content: [] } };
const compaction: EntryLike = { type: "compaction" };
const reminder = (tokens: number): EntryLike => ({ type: "custom_message", customType: REMINDER_CUSTOM_TYPE, details: { tokens } });

describe("decideReminder", () => {
	test("nothing below the first threshold", () => {
		assert.equal(decideReminder([msg], 79_999, policy), undefined);
	});

	test("first reminder at the threshold", () => {
		assert.equal(decideReminder([msg], 80_000, policy), "long");
	});

	test("next reminder only after `every` more tokens", () => {
		assert.equal(decideReminder([msg, reminder(85_000), msg], 150_000, policy), undefined);
		assert.equal(decideReminder([msg, reminder(85_000), msg], 165_000, policy), "long");
	});

	test("compaction after the last reminder makes one due, even with unknown tokens", () => {
		assert.equal(decideReminder([msg, compaction, msg], null, policy), "compacted");
		assert.equal(decideReminder([msg, reminder(90_000), compaction, msg], 20_000, policy), "compacted");
	});

	test("a post-compaction reminder resets the clock", () => {
		const branch = [msg, compaction, reminder(25_000), msg];
		assert.equal(decideReminder(branch, 100_000, policy), undefined);
		assert.equal(decideReminder(branch, 105_000, policy), "long");
	});

	test("unknown tokens and no compaction: wait", () => {
		assert.equal(decideReminder([msg], null, policy), undefined);
	});

	test("other extensions' custom messages are ignored", () => {
		const other = { type: "custom_message", customType: "something-else", details: { tokens: 90_000 } };
		assert.equal(decideReminder([msg, other], 90_000, policy), "long");
	});
});

const agents = `# Map

## Always apply

1. Squash before PR.
2. Read [local](AGENTS-LOCAL.md).

\`\`\`md
## Not a heading
\`\`\`

### Sub-rule
Still part of it.

## Find the right instructions

| Task | Read |
| --- | --- |
| DB | [database](agent-instructions/database.md#writes) |
| Web | [site](https://example.com/x.md) |
| Anchor | [here](#always-apply) |
| Dir | [design](_internal/docs/) |
| Spaced | [s](<agent-instructions/with%20space.md>) |
`;

describe("extractSection", () => {
	test("returns the section up to the next same-level heading, keeping subsections", () => {
		const s = extractSection(agents, "always apply")!;
		assert.ok(s.startsWith("## Always apply"));
		assert.match(s, /Squash before PR/);
		assert.match(s, /### Sub-rule\nStill part of it\./);
		assert.doesNotMatch(s, /Find the right instructions/);
	});

	test("ignores headings inside fenced code", () => {
		assert.match(extractSection(agents, "Always apply")!, /## Not a heading/);
		assert.equal(extractSection(agents, "Not a heading"), undefined);
	});

	test("last section runs to the end", () => {
		assert.match(extractSection(agents, "Find the right instructions")!, /Spaced/);
	});

	test("missing heading", () => {
		assert.equal(extractSection(agents, "Nope"), undefined);
	});
});

describe("linkedMarkdownFiles", () => {
	test("resolves relative .md links, drops URLs, anchors, and non-Markdown targets", () => {
		assert.deepEqual(linkedMarkdownFiles({ path: "/w/repo/AGENTS.md", content: agents }).sort(), [
			"/w/repo/AGENTS-LOCAL.md",
			"/w/repo/agent-instructions/database.md",
			"/w/repo/agent-instructions/with space.md",
		]);
	});
});

describe("read tracking", () => {
	const call = (name: string, p: string): EntryLike => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", name, arguments: { path: p } }] },
	});

	test("resolveReadPath handles ~, relative, and absolute", () => {
		assert.equal(resolveReadPath("~/a.md", "/w", "/home/u"), "/home/u/a.md");
		assert.equal(resolveReadPath("docs/a.md", "/w/repo", "/home/u"), "/w/repo/docs/a.md");
		assert.equal(resolveReadPath("/abs.md", "/w", "/home/u"), "/abs.md");
	});

	test("collects read tool paths only", () => {
		const got = readPaths([call("read", "a.md"), call("Read", "/b.md"), call("bash", "c.md"), msg], "/w", "/h");
		assert.deepEqual([...got].sort(), ["/b.md", "/w/a.md"]);
	});

	test("dropped = linked or SKILL.md, read earlier, not visible now, not in the prompt", () => {
		const contextFiles = [
			{ path: "/w/repo/AGENTS.md", content: agents },
			{ path: "/w/repo/AGENTS-LOCAL.md", content: "pinned" },
		];
		const everRead = new Set([
			"/w/repo/agent-instructions/database.md",
			"/w/repo/AGENTS-LOCAL.md",
			"/w/repo/src/index.ts",
			"/h/.pi/agent/skills/validate/SKILL.md",
			"/w/repo/agent-instructions/with space.md",
		]);
		const visibleRead = new Set(["/w/repo/agent-instructions/with space.md"]);
		assert.deepEqual(droppedInstructionFiles({ everRead, visibleRead, contextFiles }), [
			"/h/.pi/agent/skills/validate/SKILL.md",
			"/w/repo/agent-instructions/database.md",
		]);
	});

	test("paths are compared in canonical form", () => {
		const contextFiles = [{ path: "/private/tmp/p/AGENTS.md", content: "[db](db.md)" }];
		const canonical = (p: string) => p.replace(/^\/tmp\//, "/private/tmp/");
		const got = droppedInstructionFiles({ everRead: new Set(["/tmp/p/db.md"]), visibleRead: new Set(), contextFiles, canonical });
		assert.deepEqual(got, ["/private/tmp/p/db.md"]);
		const seen = droppedInstructionFiles({ everRead: new Set(["/tmp/p/db.md"]), visibleRead: new Set(["/private/tmp/p/db.md"]), contextFiles, canonical });
		assert.deepEqual(seen, []);
	});
});

describe("buildReminder", () => {
	const contextFiles = [{ path: "/w/repo/AGENTS.md", content: agents }];

	test("restates the section and lists dropped files", () => {
		const text = buildReminder({ reason: "long", tokens: 123_456, contextFiles, sectionHeading: "Always apply", dropped: ["/w/a.md"] });
		assert.match(text, /^<project_instructions_reminder>/);
		assert.match(text, /about 123k tokens/);
		assert.match(text, /<always_apply source="\/w\/repo\/AGENTS.md">\n## Always apply/);
		assert.match(text, /- \/w\/a.md/);
		assert.match(text, /Do not reply to it/);
	});

	test("compaction wording, and no dropped list when there is none", () => {
		const text = buildReminder({ reason: "compacted", tokens: null, contextFiles, sectionHeading: "Always apply", dropped: [] });
		assert.match(text, /just compacted/);
		assert.doesNotMatch(text, /no longer in your context/);
	});

	test("falls back to naming the files when no file has the section", () => {
		const text = buildReminder({ reason: "long", tokens: 90_000, contextFiles, sectionHeading: "Missing", dropped: [] });
		assert.doesNotMatch(text, /<always_apply/);
		assert.match(text, /They come from: \/w\/repo\/AGENTS.md\./);
	});
});

describe("buildReminder with pinned companion files", () => {
	const local = { path: "/w/repo/AGENTS-LOCAL.md", content: "Never run find /.\n\nCompose the full newText before an edit.\n" };
	const contextFiles = [{ path: "/w/repo/AGENTS.md", content: agents }, local];
	const pinned = new Set([local.path]);
	const base = { reason: "long" as const, tokens: 90_000, contextFiles, sectionHeading: "Always apply", dropped: [] };

	test("a pinned file without the section is restated in full", () => {
		const text = buildReminder({ ...base, pinned });
		assert.match(text, /<always_apply source="\/w\/repo\/AGENTS.md">/);
		assert.match(text, /<always_apply source="\/w\/repo\/AGENTS-LOCAL.md">\nNever run find \/\.\n\nCompose the full newText before an edit\.\n<\/always_apply>/);
	});

	test("a context file that was not pinned is not restated in full", () => {
		const text = buildReminder({ ...base, pinned: new Set() });
		assert.doesNotMatch(text, /Compose the full newText/);
	});

	test("a pinned file that has the section is restated by section only", () => {
		const withSection = { path: local.path, content: "Intro.\n\n## Always apply\n\nRule A.\n\n## Other\n\nNot this." };
		const text = buildReminder({ ...base, contextFiles: [withSection], pinned });
		assert.match(text, /Rule A\./);
		assert.doesNotMatch(text, /Not this\.|Intro\./);
	});

	test("a pinned file over the cap is named instead of restated", () => {
		const text = buildReminder({ ...base, pinned, pinnedMaxChars: 20 });
		assert.doesNotMatch(text, /Compose the full newText/);
		assert.match(text, /too long to restate here[\s\S]*- \/w\/repo\/AGENTS-LOCAL.md/);
	});

	test("a pinned file alone still counts as something restated", () => {
		const text = buildReminder({ ...base, contextFiles: [local], pinned });
		assert.doesNotMatch(text, /They come from/);
		assert.match(text, /re-check the rules that must always apply/);
	});
});
