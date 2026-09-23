/**
 * Scope Guard Extension
 *
 * Blocks filesystem-wide search/list commands (find, grep, ls, du, tree, ag, ...)
 * that target a handful of paths that are almost never a legitimate search root —
 * `/`, a bare home directory, `/Users` itself, `/System`, `/Library`, `/proc`, etc.
 * Anywhere else is allowed; the point isn't to keep the agent inside one project,
 * it's to stop the specific "walked the whole disk and locked up" failure mode.
 *
 * This exists because a model can be told in AGENTS.md/AGENTS-LOCAL.md not to run
 * `find /` or similar, but that's only a prompt-level hint — it can be ignored,
 * forgotten after compaction, or bypassed by a subagent that never saw the
 * instruction. This hook enforces it at the runtime level instead.
 *
 * For the common case — `find <broad-root> ... -name '<pattern>'` with no
 * `-exec`/other predicates — the command is transparently rewritten to the
 * equivalent `mdfind` invocation (Spotlight index, no filesystem walk) and
 * actually run, instead of just being refused. Anything more complex than that
 * (content search, -exec, non-trivial predicates) can't be safely translated,
 * so it's still just blocked with a suggestion.
 *
 * `fd`/`rg` are exempt from the broad-root check entirely — they're already the
 * fast/parallel/.gitignore-aware alternative this guard would otherwise suggest.
 *
 * Configuration:
 *   PI_SCOPE_EXTRA_DENY - colon-separated extra path prefixes to treat as broad
 *                         (e.g. a large mounted volume you never want scanned).
 *
 * Placement: ~/.pi/agent/extensions/scope-guard/index.ts (auto-discovered, global
 * directory form — see README.md alongside this file for full documentation).
 * Reload after editing with /reload — but note: in a persistently-running host
 * (e.g. pi-web under pm2), extensions may be cached at the process level, not
 * per-session. If /reload doesn't take effect, restart the host process.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export default function (pi: ExtensionAPI) {
	const homeDir = os.homedir();

	// Paths that are (almost) never a legitimate search/list root, regardless of
	// project. Listing them out loud, not inferring from a workspace boundary.
	const BROAD_PATTERNS: RegExp[] = [
		/^\/$/, // filesystem root
		/^~\/?$/, // bare home, unexpanded
		new RegExp(`^${escapeRegex(homeDir)}/?$`), // bare home, expanded
		/^\/Users\/?$/, // all users
		/^\/Users\/[^/]+\/?$/, // someone else's whole home dir (not a subpath of it)
		/^\/home\/?$/,
		/^\/home\/[^/]+\/?$/,
		/^\/(etc|var|usr|opt|System|Library|Applications|proc|sys|dev|private|Volumes)(\/|$)/,
	];

	const extraDeny = (process.env.PI_SCOPE_EXTRA_DENY?.split(":").filter(Boolean) ?? []).map((p) =>
		path.resolve(p.replace(/^~(?=$|\/)/, homeDir)),
	);

	function escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function resolveAgainst(base: string, p: string): string {
		const expanded = p.replace(/^~(?=$|\/)/, homeDir);
		return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
	}

	function isBroad(rawPath: string, absPath: string): boolean {
		if (BROAD_PATTERNS.some((re) => re.test(rawPath) || re.test(absPath))) return true;
		return extraDeny.some((d) => absPath === d || absPath.startsWith(d + path.sep));
	}

	const SUGGESTION =
		"For a whole-disk or unknown-location search, use `mdfind` (Spotlight index, no filesystem walk — " +
		"e.g. `mdfind -name 'pattern'` or `mdfind -onlyin /some/dir 'pattern'`). For a project-scoped recursive " +
		"search, use `fd`/`rg` (parallel, .gitignore-aware) or the built-in find/grep tools, scoped to a subdirectory.";

	// Tools this guard restricts on broad roots. fd/rg are deliberately excluded —
	// they're already the fast alternative, so there's nothing to protect against.
	// `ls` uses a negative lookahead to skip `ls-files`/`ls-remote`/`ls-tree` (git
	// subcommands, and similar) — `\b` alone treats the hyphen as a boundary and
	// would otherwise match `ls` inside those unrelated subcommand names.
	const RESTRICTED_SCANNERS = /\b(find|grep|ag|du|tree)\b|\bls(?!-)\b/;

	// Cap on results returned by a substituted `mdfind` query. An unscoped root
	// search has nothing to bound it by, so a generic pattern (e.g. a common file
	// extension) can legitimately return thousands of matches — capping keeps the
	// substitution useful (a quick, bounded answer) instead of dumping a huge,
	// mostly-irrelevant result list into context just because the platform's own
	// truncation eventually kicks in anyway.
	const MDFIND_RESULT_CAP = 50;

	// Very small, deliberately conservative tokenizer: pull anything that looks
	// like an absolute path or a home-relative path out of a shell command.
	// NOTE: must capture the FULL path token (not just `~/`) — an earlier bug in
	// a leaner version of this file matched only `~/` for any `~/subpath`
	// argument, causing it to resolve to the home directory itself and false-
	// positive-block ordinary `~/some/real/path` commands.
	function extractCandidatePaths(command: string): string[] {
		const matches = command.match(/(?:^|[\s(])(~\/[^\s;|&"']*|~|\/[^\s;|&"']*)/g) ?? [];
		return matches.map((m) => m.trim().replace(/^[(]/, ""));
	}

	/**
	 * Try to rewrite a simple `find <root> [-maxdepth N] [-type f|d] -name|-iname '<pattern>'`
	 * (in any flag order, no other predicates, no `-exec`) into an equivalent `mdfind`
	 * command. Returns undefined if the command is anything more complex — safer to
	 * fall back to blocking than to silently mistranslate a destructive/complex find.
	 */
	function tryTranslateFindToMdfind(command: string, rawRoot: string, absRoot: string): string | undefined {
		const trimmed = command.trim();
		// Only handle a single, simple invocation: no pipes/chains/exec.
		if (/[|;&]|-exec\b|-ok\b|-delete\b/.test(trimmed)) return undefined;
		if (!/^find\s+/.test(trimmed)) return undefined;

		const afterRoot = trimmed.slice(trimmed.indexOf(rawRoot) + rawRoot.length);
		const tokens = afterRoot.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];

		let pattern: string | undefined;

		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t === "-maxdepth" || t === "-mindepth") {
				i++; // skip the numeric argument
				continue;
			}
			if (t === "-type") {
				i++; // skip f/d — mdfind has no direct equivalent, ignored
				continue;
			}
			if (t === "-name" || t === "-iname") {
				// mdfind -name has no case-sensitive variant, so -name/-iname are handled
				// identically — only the argument matters, not which flag was used.
				if (pattern !== undefined) return undefined; // ambiguous, bail
				const next = tokens[i + 1];
				if (!next) return undefined;
				pattern = next.replace(/^['"]|['"]$/g, "");
				i++;
				continue;
			}
			if (t === "-print" || t === "-print0") continue;
			// Any other predicate (-mtime, -size, -perm, -newer, "(", "and", "or", ...) —
			// too much semantic drift to translate safely.
			return undefined;
		}

		if (pattern === undefined) return undefined;

		// mdfind -name does substring matching, not glob syntax — strip glob wildcards.
		const substring = pattern.replace(/^\*+/, "").replace(/\*+$/, "");
		if (!substring) return undefined; // pattern was only wildcards, nothing to search

		const scopeFlag = absRoot === "/" ? "" : ` -onlyin ${shellQuote(absRoot)}`;
		return `mdfind${scopeFlag} -name ${shellQuote(substring)}`;
	}

	function shellQuote(s: string): string {
		return `'${s.replace(/'/g, `'\\''`)}'`;
	}

	// A plain `grep -r`/`-R` over a directory that contains `node_modules` or `.git`
	// will read the *contents* of every file under those trees before any output
	// filtering happens, and piping through `| grep -v node_modules` afterward only
	// hides matching lines, it does not stop grep from walking in and reading them
	// in the first place. This is a more common real-world stall than literally
	// typing `find /`: an agent (or human) adds a downstream `grep -v` believing
	// it excludes the directory, and it silently doesn't. Detect and block rather
	// than let it churn through gigabytes of node_modules/.git pack files.
	const RECURSIVE_GREP = /\bgrep\b(?:\s+\S+)*?\s+-\w*[rR]\w*(?:\s|$)/;

	function hasVendorDirs(dir: string): boolean {
		try {
			return fs.existsSync(path.join(dir, "node_modules")) || fs.existsSync(path.join(dir, ".git"));
		} catch {
			return false;
		}
	}

	// Flags that consume the following token as their own argument (not a target).
	const GREP_FLAGS_WITH_ARG = new Set(["-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C"]);

	/**
	 * Best-effort extraction of the file/directory arguments passed to a `grep`
	 * invocation (up to the first pipe/chain operator). Deliberately tolerant of
	 * misparsing shell redirections (e.g. `2>/dev/null`) as a stray extra target:
	 * that only produces a harmless nonexistent path, it never causes an
	 * under-detection. What matters is not defaulting to the shell's cwd when an
	 * explicit, narrower target was actually given (e.g. `grep -rn TODO scripts/`
	 * should be judged against `scripts/`, not the whole repo root).
	 */
	function extractGrepTargets(command: string): string[] {
		const tokens = command.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
		const grepIdx = tokens.indexOf("grep");
		if (grepIdx === -1) return [];

		const targets: string[] = [];
		let sawPattern = false;
		for (let i = grepIdx + 1; i < tokens.length; i++) {
			const t = tokens[i];
			if (t === "|" || t === ";" || t === "&&" || t === "&") break; // end of this grep invocation
			if (t.startsWith("-")) {
				if (GREP_FLAGS_WITH_ARG.has(t)) i++; // skip its argument value
				if (t.startsWith("-e") && t.length > 2) sawPattern = true; // `-epattern` combined form
				continue;
			}
			if (!sawPattern) {
				sawPattern = true; // first non-flag token is the search pattern, not a target
				continue;
			}
			targets.push(t.replace(/^['"]|['"]$/g, ""));
		}
		return targets;
	}

	function isUnboundedRecursiveGrep(command: string, effectiveCwd: string): boolean {
		if (!RECURSIVE_GREP.test(command)) return false;
		// Already using grep's own exclusion flags, so assume the author knew what
		// they were doing and leave it alone.
		if (/--exclude-dir|--exclude\b/.test(command)) return false;

		const targets = extractGrepTargets(command);
		if (targets.length === 0) return hasVendorDirs(effectiveCwd); // no explicit target given, defaults to cwd
		return targets.some((t) => hasVendorDirs(resolveAgainst(effectiveCwd, t)));
	}

	// Tracks toolCallId -> { original, substituted } for calls that got rewritten,
	// so the tool_result handler can attach a visible notice to the actual result
	// instead of embedding it in the shell output itself. Embedding it in stdout
	// (via a leading `echo`) turned out to be unreliable: pi's own tool-output
	// truncation cap can drop the *head* of a large result (e.g. a broad mdfind
	// substitution returning thousands of matches), silently discarding the
	// notice along with it and making a working substitution indistinguishable
	// from one that silently didn't fire. Appending the notice as its own content
	// block, after the result, survives that truncation instead.
	const pendingRewrites = new Map<string, { original: string; substituted: string }>();

	function checkShellCommand(
		command: string,
		cwd: string | undefined,
		sessionCwd: string,
	): { block: true; reason: string } | { rewrite: string; translated: string } | undefined {
		if (!RESTRICTED_SCANNERS.test(command)) return undefined;

		// Prefer the tool's own `cwd` input if the built-in bash tool ever gains one;
		// otherwise use `ctx.cwd` (the session's real working directory), NOT
		// `process.cwd()`. Under a persistently-running host (pi-web/pm2),
		// `process.cwd()` reflects wherever that host process was launched from, not
		// this session's directory: using it here caused every session on such a
		// host to be judged against the host's own directory (which happened to
		// contain a node_modules of its own), producing a correct-looking but
		// wrong-reasoned block.
		const effectiveCwd = cwd ? resolveAgainst(sessionCwd, cwd) : sessionCwd;

		if (isUnboundedRecursiveGrep(command, effectiveCwd)) {
			return {
				block: true,
				reason:
					`Recursive grep over "${effectiveCwd}" (contains node_modules and/or .git) with no --exclude-dir. ` +
					`grep reads every file's contents before any downstream "| grep -v" filtering happens, so that ` +
					`doesn't stop it from churning through node_modules/.git first. Use \`rg <pattern> <dir>\` instead ` +
					`(respects .gitignore automatically, so those are skipped without needing exclusion flags), or add ` +
					`\`--exclude-dir=node_modules --exclude-dir=.git\` to this grep call. If you actually need to search ` +
					`inside node_modules/.git (e.g. a specific vendored package), cd into that specific subdirectory first ` +
					`and rerun the search scoped there \u2014 that's a legitimate narrower target, not a broad root.`,
			};
		}

		for (const raw of extractCandidatePaths(command)) {
			const abs = resolveAgainst(effectiveCwd, raw);
			if (isBroad(raw, abs)) {
				const translated = tryTranslateFindToMdfind(command, raw, abs);
				if (translated) {
					// Cap execution, not just display: this is a synthetic command we're
					// constructing ourselves, not re-parsing untrusted input, so appending
					// a pipe here doesn't re-trigger the "bail on pipes" rule above (that
					// rule only inspects the original, user-issued command text). `translated`
					// (uncapped) is kept separately so the notice can show the clean
					// substitution instead of our internal `| head` plumbing.
					return { rewrite: `${translated} | head -n ${MDFIND_RESULT_CAP}`, translated };
				}
				return {
					block: true,
					reason:
						`Command targets "${raw}" (resolved: ${abs}), which is a filesystem-wide/broad root and ` +
						`likely to lock up, and this command was too complex to safely auto-translate to mdfind. ${SUGGESTION}`,
				};
			}
		}

		// No absolute/home path found — command runs relative to the shell's cwd.
		if (isBroad(effectiveCwd, effectiveCwd)) {
			return {
				block: true,
				reason: `Shell cwd "${effectiveCwd}" is a filesystem-wide/broad root and likely to lock up. ${SUGGESTION}`,
			};
		}

		return undefined;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const input = event.input as { command?: string; cwd?: string };
			const original = input.command ?? "";
			const result = checkShellCommand(original, input.cwd, ctx.cwd);
			if (!result) return undefined;
			if ("rewrite" in result) {
				pendingRewrites.set(event.toolCallId, { original, substituted: result.translated });
				input.command = result.rewrite; // mutate in place — pi executes the (capped) rewritten command
				return undefined;
			}
			return result;
		}

		if (event.toolName === "find" || event.toolName === "grep" || event.toolName === "ls") {
			const input = event.input as { path?: string };
			if (input.path) {
				const abs = resolveAgainst(ctx.cwd, input.path);
				if (isBroad(input.path, abs)) {
					return {
						block: true,
						reason:
							`Path "${input.path}" (resolved: ${abs}) is a filesystem-wide/broad root and likely to ` +
							`lock up. ${SUGGESTION}`,
					};
				}
			}
		}

		return undefined;
	});

	pi.on("tool_result", async (event) => {
		const pending = pendingRewrites.get(event.toolCallId);
		if (!pending) return undefined;
		pendingRewrites.delete(event.toolCallId);

		const notice =
			`\n[scope-guard] substituting "${pending.original}" with "${pending.substituted}" — ` +
			`the original targets a filesystem root/home directory and is lockup-prone; this ran a ` +
			`Spotlight query instead, capped to the first ${MDFIND_RESULT_CAP} matches.`;

		const content = Array.isArray(event.content)
			? [...event.content, { type: "text" as const, text: notice }]
			: event.content;

		return { content };
	});
}
