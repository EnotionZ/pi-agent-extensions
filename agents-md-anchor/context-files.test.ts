import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	ensureExpected,
	fingerprint,
	insertAfterSystem,
	missingFrom,
	missingFromPayload,
	renderProjectInstructions,
	renderRestoreMessage,
	withCompanions,
} from "./context-files.ts";

const global = { path: "/home/u/.pi/agent/AGENTS.md", content: "# Global\nBe nice." };
const root = { path: "/w/repo/AGENTS.md", content: "# Repo map\n\n## Always apply\n1. Squash before PR." };
const sub = { path: "/w/repo/app/AGENTS.md", content: "# App\nUse pnpm." };
const paths = (files: { path: string }[]) => files.map((f) => f.path);

describe("ensureExpected", () => {
	test("no-op when everything is present", () => {
		const r = ensureExpected([global, root, sub], [global, root, sub]);
		assert.deepEqual(paths(r.files), paths([global, root, sub]));
		assert.deepEqual(r.added, []);
	});

	test("restores a missing file in pi's order", () => {
		const r = ensureExpected([global, sub], [global, root, sub]);
		assert.deepEqual(paths(r.files), paths([global, root, sub]));
		assert.deepEqual(paths(r.added), [root.path]);
	});

	test("restores everything when the list is empty", () => {
		const r = ensureExpected([], [global, root]);
		assert.deepEqual(paths(r.files), paths([global, root]));
	});

	test("keeps extra files other extensions added, and matches by path not content", () => {
		const extra = { path: "/x/EXTRA.md", content: "extra" };
		const stale = { ...root, content: "older copy pi loaded" };
		const r = ensureExpected([stale, extra], [root]);
		assert.deepEqual(r.files, [stale, extra]);
		assert.deepEqual(r.added, []);
	});
});

describe("withCompanions", () => {
	const disk: Record<string, string> = {
		"/w/repo/AGENTS-LOCAL.md": "local rules",
		"/w/repo/app/NOTES.md": "notes",
	};
	const read = (p: string) => disk[p];

	test("pins a companion right after the file it sits next to", () => {
		const r = withCompanions([global, root, sub], ["AGENTS-LOCAL.md"], read);
		assert.deepEqual(paths(r.files), [global.path, root.path, "/w/repo/AGENTS-LOCAL.md", sub.path]);
		assert.deepEqual(r.pinned, [{ path: "/w/repo/AGENTS-LOCAL.md", content: "local rules" }]);
	});

	test("multiple companion names, missing ones skipped", () => {
		const r = withCompanions([root, sub], ["AGENTS-LOCAL.md", "NOTES.md"], read);
		assert.deepEqual(paths(r.files), [root.path, "/w/repo/AGENTS-LOCAL.md", sub.path, "/w/repo/app/NOTES.md"]);
	});

	test("does not duplicate a companion already present", () => {
		const already = { path: "/w/repo/AGENTS-LOCAL.md", content: "local rules" };
		const r = withCompanions([root, already], ["AGENTS-LOCAL.md"], read);
		assert.equal(r.files.length, 2);
		assert.deepEqual(r.pinned, []);
	});

	test("a file is never its own companion", () => {
		const r = withCompanions([root], ["AGENTS.md"], () => "x");
		assert.deepEqual(paths(r.files), [root.path]);
	});

	test("no companion names pins nothing", () => {
		assert.deepEqual(withCompanions([root], [], read).pinned, []);
	});
});

describe("presence checks", () => {
	const prompt = `preamble\n\n<project_instructions path="${root.path}">\n${root.content}\n</project_instructions>`;

	test("fingerprint is a verbatim, trimmed prefix", () => {
		assert.equal(fingerprint("  \n# Title\nbody\n"), "# Title\nbody");
		assert.equal(fingerprint("x".repeat(1000)).length, 240);
	});

	test("missingFrom finds files absent from the prompt text", () => {
		assert.deepEqual(paths(missingFrom(prompt, [root, sub])), [sub.path]);
	});

	test("an empty file is never reported missing", () => {
		assert.deepEqual(missingFrom("", [{ path: "/e.md", content: "   " }]), []);
	});

	test("missingFromPayload works through JSON escaping (Anthropic shape)", () => {
		const payload = { system: [{ type: "text", text: prompt }], messages: [] };
		assert.deepEqual(paths(missingFromPayload(payload, [root, sub])), [sub.path]);
	});

	test("missingFromPayload works for quotes and newlines (OpenAI shape)", () => {
		const tricky = { path: "/q.md", content: 'Say "hi"\n\tthen \\ leave' };
		const payload = { instructions: `x ${tricky.content} y` };
		assert.deepEqual(missingFromPayload(payload, [tricky]), []);
		assert.deepEqual(paths(missingFromPayload({ instructions: "nope" }, [tricky])), ["/q.md"]);
	});

	test("unserializable payload reports nothing rather than throwing", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		assert.deepEqual(missingFromPayload(cyclic, [root]), []);
	});
});

describe("restore message", () => {
	test("wraps each file like pi's project context", () => {
		const text = renderRestoreMessage([root]);
		assert.match(text, /<project_instructions path="\/w\/repo\/AGENTS.md">\n# Repo map/);
		assert.ok(missingFrom(text, [root]).length === 0);
	});

	test("inserted after the leading system messages", () => {
		const msgs = [{ role: "system" }, { role: "system" }, { role: "user" }, { role: "assistant" }];
		const out = insertAfterSystem(msgs, { role: "restore" });
		assert.deepEqual(out.map((m) => m.role), ["system", "system", "restore", "user", "assistant"]);
		assert.equal(msgs.length, 4, "input not mutated");
	});

	test("inserted at the front when there is no system message", () => {
		assert.deepEqual(insertAfterSystem([{ role: "user" }], { role: "restore" }).map((m) => m.role), ["restore", "user"]);
	});
});

describe("renderProjectInstructions", () => {
	test("matches pi's project_context rendering and is recognised by missingFrom", () => {
		const text = renderProjectInstructions([root, sub]);
		assert.ok(text.startsWith("Project-specific instructions and guidelines:\n\n<project_instructions"));
		assert.deepEqual(missingFrom(text, [root, sub]), []);
	});
});
