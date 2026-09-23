/**
 * Pure analysis behind scope-guard: decides whether a shell command would walk a
 * filesystem-wide root (or recursively grep through node_modules/.git).
 *
 * It only ever blocks; it never rewrites. An earlier version turned a simple
 * `find / -name X` into an `mdfind` (Spotlight) query, but Spotlight lags new
 * files and skips some paths, so a substituted query could return nothing for a
 * file that exists, which reads as "not found" rather than "blocked".
 *
 * Kept separate from index.ts so it can be unit-tested without a running pi
 * session (`node --test *.test.ts`).
 *
 * The analysis is segment-aware. A command is tokenized roughly the way a shell
 * would (quotes, escapes, operators, redirections, heredocs), split into simple
 * commands, and each restricted scanner is judged only on *its own* path
 * arguments. An earlier version matched a scanner name anywhere in the command
 * and then any whitespace-preceded `/...` anywhere in the command, so a `sed`
 * regex (`s/a: /b/`), a TypeScript `//` comment inside a heredoc, or a commit
 * message ("find the / bug") next to an unrelated `| grep passed` was judged as
 * "grep targeting /" and blocked.
 */

import path from "node:path";

export type Verdict = { block: true; reason: string } | undefined;

export interface ScopeCheckerOptions {
	homeDir: string;
	/** Extra absolute path prefixes to treat as broad. */
	extraDeny?: string[];
	/** Whether `dir` has node_modules or .git as an immediate child. */
	hasVendorDirs: (dir: string) => boolean;
}

export const SUGGESTION =
	"Scope the search to the directory the file is likely in (e.g. `~/Work/<repo>`, `~/.config`) and use " +
	"`fd`/`rg` (parallel, .gitignore-aware) or `find`/`grep` there. If the location is genuinely unknown, " +
	"search the likely parent directories one at a time rather than the whole disk or home directory.";

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export interface Segment {
	/** Words of one simple command, quotes removed, redirections dropped. */
	words: string[];
	/** Bodies of heredocs redirected into this command. */
	heredocs: string[];
}

/**
 * Split a shell script into simple commands. Best-effort, not a full parser:
 * it understands quoting, backslash escapes, comments, the usual operators
 * (`| || & && ; ( ) $( \``), process substitution, redirections (whose targets
 * are dropped, so `2> /dev/null` is never mistaken for an argument) and
 * heredocs (whose bodies are data, attached to the command they feed).
 *
 * Known gap: a command substitution inside double quotes (`"$(find / ...)"`)
 * stays part of the quoted word and is not analysed.
 */
export function tokenize(script: string): Segment[] {
	const segments: Segment[] = [];
	let words: string[] = [];
	let heredocs: string[] = [];
	let word: string | null = null;
	let dropNext = false;
	let heredocNext: { stripTabs: boolean } | null = null;
	const pending: { delim: string; stripTabs: boolean; target: string[] }[] = [];

	const endWord = () => {
		if (word === null) return;
		if (heredocNext) {
			pending.push({ delim: word, stripTabs: heredocNext.stripTabs, target: heredocs });
			heredocNext = null;
		} else if (dropNext) {
			dropNext = false;
		} else {
			words.push(word);
		}
		word = null;
	};
	const endSegment = () => {
		endWord();
		if (words.length || heredocs.length) segments.push({ words, heredocs });
		words = [];
		heredocs = [];
	};

	let i = 0;
	const n = script.length;
	while (i < n) {
		const c = script[i];

		if (c === "\n") {
			endSegment();
			i++;
			// Consume heredoc bodies that start after this line.
			while (pending.length) {
				const doc = pending.shift()!;
				const lines: string[] = [];
				let found = false;
				while (i < n) {
					const nl = script.indexOf("\n", i);
					const end = nl === -1 ? n : nl;
					const line = script.slice(i, end);
					i = nl === -1 ? n : nl + 1;
					if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delim) {
						found = true;
						break;
					}
					lines.push(line);
				}
				doc.target.push(lines.join("\n"));
				if (!found) break;
			}
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			endWord();
			i++;
			continue;
		}
		if (c === "#" && word === null) {
			while (i < n && script[i] !== "\n") i++;
			continue;
		}
		if (c === "'") {
			const close = script.indexOf("'", i + 1);
			const end = close === -1 ? n : close;
			word = (word ?? "") + script.slice(i + 1, end);
			i = end + 1;
			continue;
		}
		if (c === '"') {
			let buf = "";
			i++;
			while (i < n && script[i] !== '"') {
				if (script[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(script[i + 1])) {
					if (script[i + 1] !== "\n") buf += script[i + 1];
					i += 2;
					continue;
				}
				buf += script[i++];
			}
			word = (word ?? "") + buf;
			i++;
			continue;
		}
		if (c === "\\") {
			if (script[i + 1] === "\n") {
				i += 2; // line continuation
				continue;
			}
			word = (word ?? "") + (script[i + 1] ?? "");
			i += 2;
			continue;
		}
		// Command substitution / subshell / process substitution: a new command starts.
		if (c === "$" && script[i + 1] === "(") {
			endSegment();
			i += 2;
			continue;
		}
		if ((c === "<" || c === ">") && script[i + 1] === "(") {
			endSegment();
			i += 2;
			continue;
		}
		if (c === "(" || c === ")" || c === "`" || c === ";" || c === "|") {
			endSegment();
			i++;
			continue;
		}
		if (c === "&") {
			if (script[i + 1] === ">") {
				// `&>file` / `&>>file`: redirect both streams.
				endWord();
				i += script[i + 2] === ">" ? 3 : 2;
				dropNext = true;
				continue;
			}
			endSegment();
			i++;
			continue;
		}
		if (c === "<" || c === ">") {
			// An fd number like the `2` in `2>` is not an argument; any other word
			// before an unspaced redirection (`echo a>b`) is.
			if (word !== null && /^\d+$/.test(word)) word = null;
			else endWord();
			if (script.startsWith("<<<", i)) {
				i += 3;
				dropNext = true;
			} else if (script.startsWith("<<-", i)) {
				i += 3;
				heredocNext = { stripTabs: true };
			} else if (script.startsWith("<<", i)) {
				i += 2;
				heredocNext = { stripTabs: false };
			} else if (script[i + 1] === "&") {
				i += 2;
				// `>&2`, `2>&1`, `>&-` duplicate a descriptor; anything else is a file.
				if (/[\d-]/.test(script[i] ?? "")) {
					while (i < n && /[\d-]/.test(script[i])) i++;
				} else {
					dropNext = true;
				}
			} else {
				i += script[i + 1] === ">" || script[i + 1] === "|" ? 2 : 1;
				dropNext = true;
			}
			continue;
		}
		word = (word ?? "") + c;
		i++;
	}
	endSegment();
	return segments;
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// Prefixes that run the command that follows them.
const WRAPPERS = new Set(["sudo", "env", "time", "nice", "nohup", "command", "exec", "builtin", "caffeinate"]);

export function createScopeChecker(opts: ScopeCheckerOptions) {
	const { homeDir, hasVendorDirs } = opts;
	const extraDeny = (opts.extraDeny ?? []).map((p) => path.resolve(expandHome(p)));

	// Paths that are (almost) never a legitimate search root, regardless of
	// project. Listed out loud, not inferred from a workspace boundary.
	const BROAD: RegExp[] = [
		/^\/$/, // filesystem root
		new RegExp(`^${escapeRegex(homeDir)}$`), // bare home
		/^\/Users$/, // all users
		/^\/Users\/[^/]+$/, // someone's whole home dir (not a subpath of it)
		/^\/home$/,
		/^\/home\/[^/]+$/,
		/^\/(etc|var|usr|opt|System|Library|Applications|proc|sys|dev|private|Volumes)(\/|$)/,
	];

	function expandHome(p: string): string {
		return p
			.replace(/^~(?=$|\/)/, homeDir)
			.replace(/^\$\{HOME\}(?=$|\/)/, homeDir)
			.replace(/^\$HOME(?=$|\/)/, homeDir);
	}

	function resolveAgainst(base: string, p: string): string {
		const expanded = expandHome(p);
		return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
	}

	function isBroadAbs(abs: string): boolean {
		if (BROAD.some((re) => re.test(abs))) return true;
		return extraDeny.some((d) => abs === d || abs.startsWith(d + path.sep));
	}

	function broadBlock(raw: string, abs: string, what: string): Verdict {
		return {
			block: true,
			reason:
				`${what} targets "${raw}" (resolved: ${abs}), which is a filesystem-wide/broad root and likely to ` +
				`lock up. ${SUGGESTION}`,
		};
	}

	function vendorBlock(abs: string): Verdict {
		return {
			block: true,
			reason:
				`Recursive grep over "${abs}" (contains node_modules and/or .git) with no --exclude-dir. ` +
				`grep reads every file's contents before any downstream "| grep -v" filtering happens, so that ` +
				`doesn't stop it from churning through node_modules/.git first. Use \`rg <pattern> <dir>\` instead ` +
				`(respects .gitignore automatically, so those are skipped without needing exclusion flags), or add ` +
				`\`--exclude-dir=node_modules --exclude-dir=.git\` to this grep call. If you actually need to search ` +
				`inside node_modules/.git (e.g. a specific vendored package), target that specific subdirectory ` +
				`instead; that's a legitimate narrower target, not a broad root.`,
		};
	}

	/** Strip env assignments and wrappers; returns the real command words. */
	function unwrap(words: string[]): { words: string[]; fromXargs: boolean } {
		let i = 0;
		let fromXargs = false;
		for (;;) {
			while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
			const w = words[i];
			if (w === undefined) break;
			const base = path.basename(w);
			if (WRAPPERS.has(base)) {
				i++;
				while (i < words.length && words[i].startsWith("-")) i++; // wrapper flags (approximate)
				continue;
			}
			if (base === "xargs") {
				fromXargs = true;
				i++;
				while (i < words.length && words[i].startsWith("-")) {
					// xargs flags that take a value as a separate word
					if (/^-[IJLnPsEd]$/.test(words[i])) i++;
					i++;
				}
				continue;
			}
			break;
		}
		return { words: words.slice(i), fromXargs };
	}

	// ---- find ---------------------------------------------------------------

	function findRoots(args: string[]): { roots: string[]; rest: string[] } {
		let i = 0;
		while (i < args.length && (/^-[HLP]$/.test(args[i]) || /^-O\d?$/.test(args[i]) || args[i] === "-D")) {
			if (args[i] === "-D") i++;
			i++;
		}
		const roots: string[] = [];
		while (i < args.length && !args[i].startsWith("-") && args[i] !== "(" && args[i] !== "!") {
			roots.push(args[i++]);
		}
		return { roots, rest: args.slice(i) };
	}

	// ---- grep / ag ----------------------------------------------------------

	const GREP_SHORT_WITH_ARG = new Set(["e", "f", "m", "A", "B", "C", "d", "D"]);
	const GREP_LONG_WITH_ARG = new Set([
		"--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context",
		"--exclude", "--exclude-dir", "--exclude-from", "--include", "--label", "--directories",
		"--devices", "--binary-files",
	]);

	function parseGrep(args: string[]) {
		let recursive = false;
		let excludes = false;
		let sawPattern = false;
		const targets: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const t = args[i];
			if (t === "--") {
				for (const rest of args.slice(i + 1)) {
					if (!sawPattern) sawPattern = true;
					else targets.push(rest);
				}
				break;
			}
			if (t.startsWith("--")) {
				const [name, inline] = t.split("=", 2);
				const value = inline ?? (GREP_LONG_WITH_ARG.has(name) ? args[++i] : undefined);
				if (name === "--recursive" || name === "--dereference-recursive") recursive = true;
				if (name === "--directories" && value === "recurse") recursive = true;
				if (name === "--regexp" || name === "--file") sawPattern = true;
				if (name === "--exclude" || name === "--exclude-dir" || name === "--exclude-from") excludes = true;
				continue;
			}
			if (t.startsWith("-") && t.length > 1) {
				for (let j = 1; j < t.length; j++) {
					const ch = t[j];
					if (ch === "r" || ch === "R") recursive = true;
					if (GREP_SHORT_WITH_ARG.has(ch)) {
						const value = j + 1 < t.length ? t.slice(j + 1) : args[++i];
						if (ch === "e" || ch === "f") sawPattern = true;
						if (ch === "d" && value === "recurse") recursive = true;
						break;
					}
				}
				continue;
			}
			if (!sawPattern) sawPattern = true;
			else targets.push(t);
		}
		return { recursive, excludes, targets };
	}

	const AG_WITH_ARG = new Set(["-G", "-g", "--ignore", "-m", "-A", "-B", "-C", "-p", "--depth", "--file-search-regex"]);

	function parseAg(args: string[]): string[] {
		const targets: string[] = [];
		let sawPattern = false;
		for (let i = 0; i < args.length; i++) {
			const t = args[i];
			if (t.startsWith("-")) {
				if (AG_WITH_ARG.has(t)) i++;
				continue;
			}
			if (!sawPattern) sawPattern = true;
			else targets.push(t);
		}
		return targets;
	}

	// ---- ls / du / tree -----------------------------------------------------

	function nonFlagArgs(args: string[], shortWithArg: string): string[] {
		const out: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const t = args[i];
			if (t.startsWith("--")) continue;
			if (t.startsWith("-") && t.length > 1) {
				const last = t[t.length - 1];
				if (t.length === 2 && shortWithArg.includes(last)) i++;
				continue;
			}
			out.push(t);
		}
		return out;
	}

	// ---- driver -------------------------------------------------------------

	function checkScript(script: string, startCwd: string, depth: number): Verdict {
		if (depth > 3) return undefined;
		const segments = tokenize(script);
		let cwd = startCwd;

		for (const seg of segments) {
			const { words, fromXargs } = unwrap(seg.words);
			const cmd = words.length ? path.basename(words[0]) : "";
			const args = words.slice(1);

			// A heredoc is data, except when it is fed to a shell.
			if (SHELLS.has(cmd)) {
				for (const body of seg.heredocs) {
					const v = checkScript(body, cwd, depth + 1);
					if (v) return v;
				}
				const c = args.findIndex((a) => /^-[a-z]*c$/.test(a));
				if (c !== -1 && args[c + 1] !== undefined) {
					const v = checkScript(args[c + 1], cwd, depth + 1);
					if (v) return v;
				}
				continue;
			}

			switch (cmd) {
				case "cd": {
					const target = args.find((a) => !a.startsWith("-") || a === "-");
					if (target === "-") break;
					cwd = resolveAgainst(cwd, target ?? homeDir);
					break;
				}
				case "find": {
					const { roots } = findRoots(args);
					for (const raw of roots.length ? roots : ["."]) {
						const abs = resolveAgainst(cwd, raw);
						if (isBroadAbs(abs)) return broadBlock(raw, abs, "find");
					}
					break;
				}
				case "grep":
				case "egrep":
				case "fgrep": {
					const { recursive, excludes, targets } = parseGrep(args);
					if (!recursive) break; // reads files or stdin, not a tree
					if (!targets.length && fromXargs) break; // targets arrive on stdin
					for (const raw of targets.length ? targets : ["."]) {
						const abs = resolveAgainst(cwd, raw);
						if (isBroadAbs(abs)) return broadBlock(raw, abs, "Recursive grep");
						if (!excludes && hasVendorDirs(abs)) return vendorBlock(abs);
					}
					break;
				}
				case "ag": {
					// Recursive by default but .gitignore-aware, so only the broad-root check applies.
					for (const raw of parseAg(args).length ? parseAg(args) : ["."]) {
						const abs = resolveAgainst(cwd, raw);
						if (isBroadAbs(abs)) return broadBlock(raw, abs, "ag");
					}
					break;
				}
				case "ls": {
					// Plain `ls /` or `ls ~` lists one directory and returns instantly;
					// only a recursive listing walks the tree.
					const recursive = args.some((a) => a === "--recursive" || /^-[A-Za-z]*R/.test(a));
					if (!recursive) break;
					for (const raw of nonFlagArgs(args, "IwT").length ? nonFlagArgs(args, "IwT") : ["."]) {
						const abs = resolveAgainst(cwd, raw);
						if (isBroadAbs(abs)) return broadBlock(raw, abs, "Recursive ls");
					}
					break;
				}
				case "tree": {
					if (args.includes("-L")) break; // depth-bounded
					for (const raw of nonFlagArgs(args, "LPIo").length ? nonFlagArgs(args, "LPIo") : ["."]) {
						const abs = resolveAgainst(cwd, raw);
						if (isBroadAbs(abs)) return broadBlock(raw, abs, "tree without -L");
					}
					break;
				}
				case "du": {
					// du walks everything under its target even with -d/-s.
					for (const raw of nonFlagArgs(args, "dBt").length ? nonFlagArgs(args, "dBt") : ["."]) {
						const abs = resolveAgainst(cwd, raw);
						if (isBroadAbs(abs)) return broadBlock(raw, abs, "du");
					}
					break;
				}
			}
		}
		return undefined;
	}

	return {
		/** Check a shell command run from `cwd` (the tool's own cwd, else the session's). */
		checkShellCommand(command: string, cwd: string | undefined, sessionCwd: string): Verdict {
			const effectiveCwd = cwd ? resolveAgainst(sessionCwd, cwd) : sessionCwd;
			return checkScript(command, effectiveCwd, 0);
		},
		/** Check a built-in find/grep/ls tool's path argument. */
		checkToolPath(p: string, sessionCwd: string): Verdict {
			const abs = resolveAgainst(sessionCwd, p);
			return isBroadAbs(abs) ? broadBlock(p, abs, "Path") : undefined;
		},
	};
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
