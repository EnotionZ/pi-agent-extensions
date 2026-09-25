import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectFromBash, findInText, jsonObjects, parseAsanaUrl, splitCommands, stripHeredocs } from "./detect.ts";

const keys = (ds: { key: string }[]) => ds.map((d) => d.key);
const brief = (ds: { key: string; action: string; title?: string }[]) => ds.map((d) => [d.key, d.action, d.title]);

describe("findInText", () => {
	test("PR URLs, normalised and deduped, trailing path ignored", () => {
		const text = "See https://github.com/Qwestly/api-python/pull/145 and https://github.com/qwestly/API-python/pull/145/files, plus https://github.com/Qwestly/candidate/pull/7#discussion_r1.";
		const found = findInText(text);
		assert.deepEqual(keys(found), ["github-pr:qwestly/api-python#145", "github-pr:qwestly/candidate#7"]);
		assert.equal(found[0]!.url, "https://github.com/Qwestly/api-python/pull/145");
		assert.equal(found[0]!.label, "Qwestly/api-python#145");
		assert.equal(found[0]!.action, "mentioned");
	});

	test("ignores pull/new/<branch> and non-PR GitHub links", () => {
		assert.deepEqual(findInText("https://github.com/o/r/pull/new/feat-x https://github.com/o/r/issues/3 https://github.com/o/r"), []);
	});

	test("Asana task and project URLs in both layouts", () => {
		const text = [
			"https://app.asana.com/0/1216663810328535/1218404968130028",
			"https://app.asana.com/0/0/1218404968130029/f",
			"https://app.asana.com/0/1216663810328535/list",
			"https://app.asana.com/1/1208967447162000/project/1216663810328536/task/1218404968130030?focus=true",
			"(https://app.asana.com/1/1208967447162000/project/1216663810328537/board).",
			"https://app.asana.com/1/1208967447162000/task/1218404968130031",
			"https://app.asana.com/0/inbox/123456789",
			"https://app.asana.com/0/home/1234567",
		].join(" ");
		assert.deepEqual(keys(findInText(text)), [
			"asana-task:1218404968130028",
			"asana-task:1218404968130029",
			"asana-project:1216663810328535",
			"asana-task:1218404968130030",
			"asana-project:1216663810328537",
			"asana-task:1218404968130031",
		]);
	});

	test("a seen Asana URL is kept as the link, without trailing punctuation", () => {
		const d = parseAsanaUrl("https://app.asana.com/0/0/1218404968130028/f.", "mentioned")!;
		assert.equal(d.url, "https://app.asana.com/0/0/1218404968130028/f");
		assert.equal(d.urlSynthetic, undefined);
	});
});

describe("shell parsing", () => {
	test("heredoc bodies are removed", () => {
		const cmd = "cat > /tmp/b.md <<'EOF'\nsee https://github.com/o/r/pull/1\ngh pr merge 9\nEOF\ngh pr create --title x";
		assert.equal(stripHeredocs(cmd), "cat > /tmp/b.md <<'EOF'\ngh pr create --title x");
	});

	test("commands split on operators, quotes kept together", () => {
		assert.deepEqual(splitCommands(`cd /tmp && gh pr create -t "a b; c" | tail -1; echo 'x|y'`), [
			["cd", "/tmp"],
			["gh", "pr", "create", "-t", "a b; c"],
			["tail", "-1"],
			["echo", "x|y"],
		]);
	});

	test("jsonObjects finds objects among other output, string-aware", () => {
		const out = 'noise {"data":{"gid":"1","name":"a } b"}} more\n{"data":[]}\n{broken';
		assert.deepEqual(jsonObjects(out), [{ data: { gid: "1", name: "a } b" } }, { data: [] }]);
	});
});

describe("detectFromBash: gh", () => {
	test("gh pr create -> created, title from the command (real transcript shape)", () => {
		const cmd = `cd /tmp/api-p5; gh pr create -R Qwestly/api-python --base "$(~/Work/qwestly-workspace/scripts/pr-base-branch.sh api-python)" --head feat/x --title "refactor(llm): move webfetch onto the direct core" --body-file /tmp/p5-body.md`;
		assert.deepEqual(brief(detectFromBash(cmd, "https://github.com/Qwestly/api-python/pull/145\n")), [
			["github-pr:qwestly/api-python#145", "created", "refactor(llm): move webfetch onto the direct core"],
		]);
	});

	test("two creates in one command: both created, no title guess", () => {
		const out = "https://github.com/Qwestly/qwestly-internal/pull/53\nhttps://github.com/Qwestly/qwestly-workspace/pull/105\n";
		const got = detectFromBash('gh pr create -t "A" -F a.md && gh pr create -t "B" -F b.md', out);
		assert.deepEqual(brief(got), [
			["github-pr:qwestly/qwestly-internal#53", "created", undefined],
			["github-pr:qwestly/qwestly-workspace#105", "created", undefined],
		]);
	});

	test("gh pr view <n> --repo builds the URL; output URLs are not trusted for view", () => {
		const out = '[{"b":"see https://github.com/Other/repo/pull/9"}]';
		const got = detectFromBash("gh pr view 53 --repo Qwestly/qwestly-internal --json reviews,comments -q '.x'", out);
		assert.deepEqual(brief(got), [["github-pr:qwestly/qwestly-internal#53", "mentioned", undefined]]);
	});

	test("gh pr view without a repo and without a URL finds nothing", () => {
		assert.deepEqual(detectFromBash("gh pr view 53 --json title", '{"title":"x"}'), []);
	});

	test("gh pr comment on the current branch takes the URL it prints", () => {
		const got = detectFromBash("gh pr comment --body-file /tmp/reply.md", "https://github.com/Qwestly/qwestly-internal/pull/53#issuecomment-5835571200\n");
		assert.deepEqual(brief(got), [["github-pr:qwestly/qwestly-internal#53", "updated", undefined]]);
	});

	test("gh pr merge <url> -> updated", () => {
		const got = detectFromBash("gh pr merge https://github.com/o/r/pull/12 --squash", "✓ Merged");
		assert.deepEqual(brief(got), [["github-pr:o/r#12", "updated", undefined]]);
	});

	test("gh api pulls endpoint; issues endpoint only when it changes something", () => {
		assert.deepEqual(keys(detectFromBash("gh api repos/o/r/pulls/5/comments", "[]")), ["github-pr:o/r#5"]);
		assert.deepEqual(detectFromBash("gh api repos/o/r/issues/5", "{}"), []);
		assert.deepEqual(brief(detectFromBash("gh api repos/o/r/issues/5/comments -f body=hi", "{}")), [["github-pr:o/r#5", "updated", undefined]]);
	});

	test("listing and searching add nothing, even with URLs in the output", () => {
		assert.deepEqual(detectFromBash("gh pr list --state open", "https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2"), []);
	});

	test("a PR URL inside a heredoc PR body is not a target", () => {
		const cmd = "gh pr create -t T -F - <<'EOF'\nFollows https://github.com/o/r/pull/1\nEOF";
		assert.deepEqual(keys(detectFromBash(cmd, "https://github.com/o/r/pull/2")), ["github-pr:o/r#2"]);
	});

	test("unrelated commands are skipped cheaply", () => {
		assert.deepEqual(detectFromBash("cat CHANGELOG.md", "https://github.com/o/r/pull/1"), []);
	});
});

describe("detectFromBash: asana-cli", () => {
	test("GET /tasks/<gid> with JSON output -> mentioned, with name", () => {
		const out = '{"data":{"gid":"1218404968130028","name":"Qwestly-internal endpoint to dump db","notes":""}}__tests__\nAGENTS.md';
		const got = detectFromBash("cd ~/.pi/agent/skills/asana && ./asana-cli GET /tasks/1218404968130028 -q 'opt_fields=name,notes'", out);
		assert.deepEqual(brief(got), [["asana-task:1218404968130028", "mentioned", "Qwestly-internal endpoint to dump db"]]);
		assert.equal(got[0]!.urlSynthetic, true);
	});

	test("GET shorthand and full API URL paths", () => {
		assert.deepEqual(keys(detectFromBash("asana-cli tasks/1218404968130028", "{}")), ["asana-task:1218404968130028"]);
		assert.deepEqual(keys(detectFromBash("asana-cli GET https://app.asana.com/api/1.0/projects/1216663810328535?opt_fields=name", "{}")), ["asana-project:1216663810328535"]);
	});

	test("POST /tasks with JSON response -> created, permalink kept", () => {
		const out = '{"data":{"gid":"1218999999999999","resource_type":"task","name":"Draft launch brief","permalink_url":"https://app.asana.com/0/1/1218999999999999"}}';
		const got = detectFromBash("./asana-cli POST /tasks -f - <<'JSON'\n{\"data\":{\"name\":\"Draft launch brief\"}}\nJSON", out);
		assert.deepEqual(brief(got), [["asana-task:1218999999999999", "created", "Draft launch brief"]]);
		assert.equal(got[0]!.url, "https://app.asana.com/0/1/1218999999999999");
		assert.equal(got[0]!.urlSynthetic, undefined);
	});

	test("POST /tasks piped through jq to a bare gid -> created", () => {
		const got = detectFromBash("./asana-cli POST /tasks -f /tmp/t.json | jq -r .data.gid", "1218888888888888\n");
		assert.deepEqual(brief(got), [["asana-task:1218888888888888", "created", undefined]]);
	});

	test("stories and attachments on a task -> that task updated, not the story gid (real transcript shape)", () => {
		const cmd = "./asana-cli POST /tasks/1218404968130028/stories -f /tmp/c.json | jq -r .data.gid; ./asana-cli POST /attachments -F parent=1218404968130028 -F file=@/tmp/a.png | jq -r .data.name";
		const got = detectFromBash(cmd, "1218877353518610\ndb-export-page-local.png\n");
		assert.deepEqual(brief(got), [["asana-task:1218404968130028", "updated", undefined]]);
	});

	test("PUT marks updated and picks up completion", () => {
		const got = detectFromBash("asana-cli PUT /tasks/1218404968130028 -d '{\"data\":{\"completed\":true}}'", '{"data":{"gid":"1218404968130028","completed":true,"name":"X"}}');
		assert.deepEqual(brief(got), [["asana-task:1218404968130028", "updated", "X"]]);
		assert.equal(got[0]!.state, "done");
	});

	test("addTask reads the task gid from the request body", () => {
		const cmd = "./asana-cli POST /sections/1216663810328542/addTask -f - <<'JSON'\n{\"data\":{\"task\":\"1218404968130028\"}}\nJSON";
		assert.deepEqual(brief(detectFromBash(cmd, '{"data":{}}')), [["asana-task:1218404968130028", "updated", undefined]]);
	});

	test("errors, deletes, list and search endpoints add nothing", () => {
		assert.deepEqual(detectFromBash("asana-cli GET /tasks/1218404968130028", '{"errors":[{"message":"Not Found"}]}'), []);
		assert.deepEqual(detectFromBash("asana-cli DELETE /tasks/1218404968130028", '{"data":{}}'), []);
		assert.deepEqual(detectFromBash("asana-cli GET /workspaces/1/tasks/search -q text=x", '{"data":[{"gid":"1218404968130028"}]}'), []);
		assert.deepEqual(detectFromBash("asana-cli GET /users/me", '{"data":{"gid":"1208967447162670","name":"Dom"}}'), []);
	});

	test("subtask creation: new subtask created, parent updated", () => {
		const got = detectFromBash("asana-cli POST /tasks/1218607224490503/subtasks -d '{}'", '{"data":{"gid":"1218700000000000","resource_type":"task","name":"Sub"}}');
		assert.deepEqual(brief(got), [
			["asana-task:1218700000000000", "created", "Sub"],
			["asana-task:1218607224490503", "updated", undefined],
		]);
	});
});
