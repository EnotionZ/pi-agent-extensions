import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createScopeChecker, tokenize } from "./scope-check.ts";

const HOME = "/Users/tester";
const PROJECT = "/Users/tester/Work/repo"; // has node_modules and .git
const VENDORED = new Set([PROJECT, "/Users/tester/Work/repo/packages/contracts"]);

const checker = createScopeChecker({
	homeDir: HOME,
	extraDeny: ["/Volumes/Big", "~/huge"],
	hasVendorDirs: (dir) => VENDORED.has(dir),
});

const check = (cmd: string, cwd = PROJECT) => checker.checkShellCommand(cmd, undefined, cwd);
const blocked = (cmd: string, cwd = PROJECT) => {
	const v = check(cmd, cwd);
	return v !== undefined && "block" in v;
};
const allowed = (cmd: string, cwd = PROJECT) => assert.equal(check(cmd, cwd), undefined, cmd);
const blocks = (cmd: string, cwd = PROJECT) => assert.ok(blocked(cmd, cwd), `expected block: ${cmd}`);

describe("tokenize", () => {
	test("splits on operators and strips quotes", () => {
		assert.deepEqual(
			tokenize(`cd 'a b' && grep -n "x y" f | wc -l; echo done`).map((s) => s.words),
			[["cd", "a b"], ["grep", "-n", "x y", "f"], ["wc", "-l"], ["echo", "done"]],
		);
	});

	test("drops redirection targets", () => {
		assert.deepEqual(tokenize(`find . -name x 2> /dev/null >out.txt 2>&1`)[0].words, ["find", ".", "-name", "x"]);
		assert.deepEqual(tokenize(`echo a>b`)[0].words, ["echo", "a"]);
	});

	test("attaches heredoc bodies as data", () => {
		const segs = tokenize(`python3 - <<'EOF'\nprint("find /")\nEOF\necho after`);
		assert.deepEqual(segs[0], { words: ["python3", "-"], heredocs: ['print("find /")'] });
		assert.deepEqual(segs[1].words, ["echo", "after"]);
	});

	test("command substitution starts a new command", () => {
		assert.deepEqual(
			tokenize(`x=$(find / -mtime 1)`).map((s) => s.words),
			[["x="], ["find", "/", "-mtime", "1"]],
		);
	});
});

describe("regressions: false positives that used to block", () => {
	test("heredoc containing TS // comments, then a grep", () => {
		allowed(`python3 - <<'EOF'\ns = """\n  // \`hasOwnProperty\` guard\n"""\nEOF\ngrep -n "def " file.py`);
	});

	test("perl substitution containing ': /' then a piped grep", () => {
		allowed(`perl -pi -e 's/"input": \\{ ?"type": /"input": {"kb_type": /' f.json && npm run verify 2>&1 | grep -E "passed|failed"`);
	});

	test("sed substitution containing ': /' then a grep on a file", () => {
		allowed(`cd sub && sed -i '' 's/"input": {"type": /"input": {"kb_type": /' f.json && grep -c '"kb_type"' f.json`);
	});

	test("a scanner name inside a commit message", () => {
		allowed(`git commit -m "find the / bug in grep -r handling"`);
	});

	test("piped non-recursive grep from a broad cwd", () => {
		allowed(`npm test 2>&1 | grep -E "passed"`, HOME);
	});

	test("redirect to /dev/null is not a target", () => {
		allowed(`find . -name '*.ts' 2> /dev/null`);
	});

	test("git subcommands", () => {
		allowed(`git ls-files | head`);
		allowed(`git grep -n foo`);
		allowed(`git -C api-python ls-tree origin/main packages/contracts`);
	});

	test("plain ls of a broad directory lists one level", () => {
		allowed(`ls /`);
		allowed(`ls -la ~`);
	});

	test("recursive grep with -e pattern scoped to a clean subdirectory", () => {
		allowed(`grep -rn -e pattern src`);
	});

	test("a grep pattern that looks like a path", () => {
		allowed(`grep -rn "/" src`);
	});
});

describe("still allowed", () => {
	test("rg and fd are exempt", () => {
		allowed(`rg foo /`);
		allowed(`fd -e ts . ~`);
	});

	test("project-scoped searches", () => {
		allowed(`grep -rn TODO scripts/`);
		allowed(`grep -rn --exclude-dir=node_modules --exclude-dir=.git TODO .`);
		allowed(`ls ~/.pi/agent/extensions`);
		allowed(`find src -name '*.ts' -exec wc -l {} +`);
		allowed(`du -sh ~/Work/repo`);
		allowed(`tree -L 2 ~`);
	});

	test("xargs grep takes its targets from stdin", () => {
		allowed(`rg -l foo | xargs grep -rn bar`);
	});

	test("heredoc fed to a non-shell is data", () => {
		allowed(`python3 - <<'EOF'\nimport os; os.system("find / -mtime 1")\nEOF`);
	});
});

describe("still blocked", () => {
	test("find on a broad root with non-translatable predicates", () => {
		blocks(`find / -name foo -exec rm {} \\;`);
		blocks(`find ~ -mtime -1`);
		blocks(`find $HOME -size +1M`);
		blocks(`sudo find / -newer x`);
		blocks(`find /Library -type f`);
	});

	test("cd into a broad root, then a relative scan", () => {
		blocks(`cd ~ && find . -mtime -1`);
		blocks(`cd / && grep -r foo`);
	});

	test("session cwd is itself broad", () => {
		blocks(`find . -mtime -1`, HOME);
		blocks(`grep -rn foo`, HOME);
	});

	test("recursive grep over vendor dirs", () => {
		blocks(`grep -rn TODO .`);
		blocks(`grep -R TODO`);
		blocks(`grep --recursive TODO packages/contracts`);
		blocks(`cd ../repo && grep -rl foo .`, "/Users/tester/Work/other");
	});

	test("recursive grep over a broad root", () => {
		blocks(`grep -r foo ~`);
		blocks(`FOO=1 grep -rI foo /`);
	});

	test("other walkers", () => {
		blocks(`du -sh ~`);
		blocks(`du -d 1 /`);
		blocks(`ls -R /`);
		blocks(`ls -laR ~`);
		blocks(`tree ~`);
		blocks(`ag foo /`);
	});

	test("hidden inside substitutions, pipelines and shells", () => {
		blocks(`echo $(find / -mtime 1)`);
		blocks(`x=\`grep -r foo ~\``);
		blocks(`echo start; find / -mtime 1 | head`);
		blocks(`bash -c "find / -mtime 1"`);
		blocks(`bash <<'EOF'\nfind / -mtime 1\nEOF`);
		blocks(`diff <(find / -mtime 1) other`);
	});

	test("PI_SCOPE_EXTRA_DENY prefixes", () => {
		blocks(`du -sh /Volumes/Big/sub`);
		blocks(`find ~/huge/x -mtime 1`);
	});
});

describe("no rewriting", () => {
	test("a simple find -name on a broad root is blocked, not substituted", () => {
		const v = check(`find / -name '*.ts'`);
		assert.ok(v && "block" in v);
		assert.doesNotMatch(v.reason, /mdfind/);
		blocks(`find ~ -maxdepth 3 -type f -iname "*report*"`);
	});

	test("the suggestion points at a scoped search", () => {
		const v = check(`find / -name x`);
		assert.match(v!.reason, /Scope the search/);
	});
});

describe("built-in tool paths", () => {
	test("broad paths blocked, subpaths allowed", () => {
		assert.ok(checker.checkToolPath("/", PROJECT));
		assert.ok(checker.checkToolPath("~", PROJECT));
		assert.equal(checker.checkToolPath("~/Work", PROJECT), undefined);
		assert.equal(checker.checkToolPath("src", PROJECT), undefined);
	});
});
