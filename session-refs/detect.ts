/**
 * Pure detection of GitHub PR and Asana references in conversation text and
 * in bash tool calls. No pi imports, so it can be tested with `node --test`.
 *
 * Two sources, with different trust:
 *
 *  - Conversation text (user and assistant messages): any PR or Asana URL is a
 *    "mentioned" reference.
 *  - Bash tool calls: only commands that act on a single object count, and the
 *    action comes from the command (`gh pr create` -> created, `gh pr merge`
 *    -> updated, `asana-cli PUT /tasks/<gid>` -> updated, ...). Arbitrary tool
 *    output is NOT scanned for URLs: reading a changelog or listing PRs would
 *    otherwise flood the list with things the session never touched.
 */

export type RefKind = "github-pr" | "asana-task" | "asana-project";
export type RefAction = "created" | "updated" | "mentioned";

export interface Detected {
	kind: RefKind;
	/** Stable identity, e.g. `github-pr:qwestly/candidate#412` or `asana-task:1218...`. */
	key: string;
	url: string;
	/** Short ASCII label, e.g. `Qwestly/candidate#412` or the Asana gid (the kind is shown separately). */
	label: string;
	action: RefAction;
	title?: string;
	/** github: open | draft | merged | closed; asana: done | archived. */
	state?: string;
	/** The URL was built from an ID rather than seen, so a real one should replace it. */
	urlSynthetic?: boolean;
	/** Added by the user via /refs add: brings back a removed reference. */
	manual?: boolean;
}

export const ACTION_RANK: Record<RefAction, number> = { mentioned: 1, updated: 2, created: 3 };

/** Drop keys whose value is undefined, so objects compare and serialize cleanly. */
export function clean<T extends object>(o: T): T {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Two sightings of the same object: strongest action, newest title/state, a real URL over a built one. */
export function combine(a: Detected, b: Detected): Detected {
	return clean({
		...a,
		...b,
		action: ACTION_RANK[b.action] >= ACTION_RANK[a.action] ? b.action : a.action,
		title: b.title ?? a.title,
		state: b.state ?? a.state,
		label: a.label,
		url: !a.urlSynthetic ? a.url : b.url,
		urlSynthetic: a.urlSynthetic && b.urlSynthetic ? true : undefined,
		manual: a.manual || b.manual ? true : undefined,
	});
}

function dedupe(found: Detected[]): Detected[] {
	const byKey = new Map<string, Detected>();
	for (const d of found) {
		const prev = byKey.get(d.key);
		byKey.set(d.key, prev ? combine(prev, d) : d);
	}
	return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const GH_PR_URL = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?!\d)/g;
const ASANA_URL = /https?:\/\/app\.asana\.com\/[^\s)"'<>\]`]+/g;
const PROJECT_VIEWS = new Set(["list", "board", "timeline", "calendar", "overview", "files", "messages", "dashboard", "workflow", "progress", "gantt"]);
const GID = /^\d{6,}$/;

export function githubPr(owner: string, repo: string, number: string | number, action: RefAction): Detected {
	return {
		kind: "github-pr",
		key: `github-pr:${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`,
		url: `https://github.com/${owner}/${repo}/pull/${number}`,
		label: `${owner}/${repo}#${number}`,
		action,
	};
}

export function asanaTask(gid: string, action: RefAction, url?: string): Detected {
	return clean({
		kind: "asana-task" as const,
		key: `asana-task:${gid}`,
		url: url ?? `https://app.asana.com/0/0/${gid}/f`,
		label: gid,
		action,
		urlSynthetic: url ? undefined : true,
	});
}

export function asanaProject(gid: string, action: RefAction, url?: string): Detected {
	return clean({
		kind: "asana-project" as const,
		key: `asana-project:${gid}`,
		url: url ?? `https://app.asana.com/0/${gid}/list`,
		label: gid,
		action,
		urlSynthetic: url ? undefined : true,
	});
}

/** Classify one Asana web URL (both the `/0/` and the newer `/1/<workspace>/` layouts). */
export function parseAsanaUrl(raw: string, action: RefAction): Detected | undefined {
	const url = raw.replace(/[.,;:!?]+$/, "");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const segs = parsed.pathname.split("/").filter(Boolean);
	if (segs[0] === "0") {
		const [, a, b] = segs;
		if (a && (GID.test(a) || a === "0")) {
			if (b && GID.test(b)) return asanaTask(b, action, url);
			if (a !== "0" && (!b || PROJECT_VIEWS.has(b))) return asanaProject(a, action, url);
		}
		return undefined;
	}
	if (segs[0] === "1") {
		const task = segs.indexOf("task");
		if (task > 0 && GID.test(segs[task + 1] ?? "")) return asanaTask(segs[task + 1]!, action, url);
		if (segs.includes("inbox") || segs.includes("item")) return undefined;
		const project = segs.indexOf("project");
		if (project > 0 && GID.test(segs[project + 1] ?? "")) return asanaProject(segs[project + 1]!, action, url);
	}
	return undefined;
}

export function prUrlsIn(text: string, action: RefAction): Detected[] {
	return dedupe([...text.matchAll(GH_PR_URL)].map((m) => githubPr(m[1]!, m[2]!, m[3]!, action)));
}

/** Every PR and Asana reference in a piece of conversation text. */
export function findInText(text: string, action: RefAction = "mentioned"): Detected[] {
	const asana = [...text.matchAll(ASANA_URL)].flatMap((m) => parseAsanaUrl(m[0], action) ?? []);
	return dedupe([...prUrlsIn(text, action), ...asana]);
}

// ---------------------------------------------------------------------------
// Shell parsing (just enough for gh / asana-cli invocations)
// ---------------------------------------------------------------------------

/** Remove heredoc bodies, which are data (PR bodies, JSON payloads), not commands. */
export function stripHeredocs(command: string): string {
	const out: string[] = [];
	const pending: string[] = [];
	for (const line of command.split("\n")) {
		if (pending.length) {
			if (line.trim() === pending[0]) pending.shift();
			continue;
		}
		out.push(line);
		for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) pending.push(m[2]!);
	}
	return out.join("\n");
}

/** Split into simple commands (words), honouring quotes; operators end a command. */
export function splitCommands(command: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | null = null;

	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length) commands.push(words);
		words = [];
	};

	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
			else word += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === "\\" && i + 1 < command.length) {
			const next = command[++i]!;
			if (next !== "\n") {
				word += next;
				inWord = true;
			}
		} else if (c === " " || c === "\t") {
			endWord();
		} else if (";&|\n()".includes(c)) {
			endCommand();
		} else {
			word += c;
			inWord = true;
		}
	}
	endCommand();
	return commands;
}

// gh options that take a value, so their value is not mistaken for the PR argument.
const GH_VALUE_OPTS = new Set([
	"-R", "--repo", "-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head",
	"--json", "-q", "--jq", "-T", "--template", "-a", "--assignee", "-l", "--label", "-r", "--reviewer",
	"-m", "--milestone", "-p", "--project", "-A", "--author", "--subject", "-S", "--search", "-s", "--state",
	"-L", "--limit", "--match-head-commit", "--add-label", "--remove-label", "--add-reviewer", "--remove-reviewer",
	"--add-assignee", "--remove-assignee", "--add-project", "--remove-project", "-X", "--method", "-f", "--field",
	"--raw-field", "--input", "--hostname", "--author-email",
]);
const GH_UPDATE = new Set(["comment", "merge", "edit", "review", "close", "reopen", "ready", "lock", "unlock"]);
const GH_MENTION = new Set(["view", "checks", "diff", "checkout"]);

function ghArgs(words: string[]): { positional: string[]; opts: Map<string, string> } {
	const positional: string[] = [];
	const opts = new Map<string, string>();
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (w.startsWith("--") && w.includes("=")) {
			const at = w.indexOf("=");
			opts.set(w.slice(0, at), w.slice(at + 1));
		} else if (GH_VALUE_OPTS.has(w)) {
			opts.set(w, words[++i] ?? "");
		} else if (!w.startsWith("-")) {
			positional.push(w);
		}
	}
	return { positional, opts };
}

function ghTarget(arg: string | undefined, repo: string | undefined, action: RefAction): Detected | undefined {
	if (!arg) return undefined;
	const byUrl = prUrlsIn(arg, action)[0];
	if (byUrl) return byUrl;
	const n = /^#?(\d+)$/.exec(arg)?.[1];
	const r = repo ? /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(repo) : null;
	return n && r ? githubPr(r[1]!, r[2]!, n, action) : undefined;
}

function detectGh(words: string[], output: string): Detected[] {
	const [group, sub, ...rest] = words;
	if (group === "api") {
		const { positional, opts } = ghArgs(words.slice(1));
		const method = (opts.get("-X") ?? opts.get("--method") ?? "GET").toUpperCase();
		const hasFields = ["-f", "--field", "--raw-field", "--input"].some((o) => opts.has(o));
		const action: RefAction = method !== "GET" || hasFields ? "updated" : "mentioned";
		return positional.flatMap((p) => {
			const m = /^\/?repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)(?:\/|$)/.exec(p);
			// issues/<n> endpoints also address PRs (comments, labels), but a GET there
			// could just as well be a plain issue, so only count changes.
			if (!m || (m[3] === "issues" && action === "mentioned")) return [];
			return [githubPr(m[1]!, m[2]!, m[4]!, action)];
		});
	}
	if (group !== "pr" || !sub) return [];

	const { positional, opts } = ghArgs(rest);
	const repo = opts.get("-R") ?? opts.get("--repo");

	if (sub === "create") {
		const created = prUrlsIn(output, "created");
		const title = opts.get("-t") ?? opts.get("--title");
		if (created.length === 1 && title) created[0] = { ...created[0]!, title };
		return created;
	}
	if (GH_UPDATE.has(sub)) {
		const target = ghTarget(positional[0], repo, "updated");
		// No argument means "the current branch's PR"; comment/merge print its URL.
		return target ? [target] : prUrlsIn(output, "updated").slice(0, 1);
	}
	if (GH_MENTION.has(sub)) {
		const target = ghTarget(positional[0], repo, "mentioned");
		return target ? [target] : [];
	}
	return [];
}

// ---------------------------------------------------------------------------
// asana-cli
// ---------------------------------------------------------------------------

const METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

interface AsanaObject {
	gid: string;
	resource_type?: string;
	name?: string;
	permalink_url?: string;
	completed?: boolean;
	archived?: boolean;
}

/** Top-level JSON objects embedded anywhere in `text` (string-aware brace matching). */
export function jsonObjects(text: string, limit = 200_000): unknown[] {
	const s = text.length > limit ? text.slice(0, limit) : text;
	const out: unknown[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"' && depth > 0) inString = true;
		else if (c === "{") {
			if (depth++ === 0) start = i;
		} else if (c === "}" && depth > 0 && --depth === 0) {
			try {
				out.push(JSON.parse(s.slice(start, i + 1)));
			} catch {
				// not JSON after all
			}
		}
	}
	return out;
}

/** Single objects from Asana `{"data": {...}}` responses, keyed by gid. List responses are skipped. */
function asanaObjects(output: string): Map<string, AsanaObject> {
	const byGid = new Map<string, AsanaObject>();
	for (const o of jsonObjects(output)) {
		const data = (o as { data?: unknown })?.data;
		if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as AsanaObject).gid === "string") {
			byGid.set((data as AsanaObject).gid, data as AsanaObject);
		}
	}
	return byGid;
}

function withObject(d: Detected, o: AsanaObject | undefined): Detected {
	if (!o) return d;
	return clean({
		...d,
		title: o.name || d.title,
		url: o.permalink_url || d.url,
		urlSynthetic: o.permalink_url ? undefined : d.urlSynthetic,
		state: o.completed === true ? "done" : o.archived === true ? "archived" : d.state,
	});
}

function detectAsana(calls: Array<{ method: string; path: string }>, command: string, output: string): Detected[] {
	const objects = asanaObjects(output);
	const failed = /"errors"\s*:/.test(output);
	const found: Detected[] = [];
	const creates = calls.filter((c) => c.method === "POST" && /^(tasks|projects|tasks\/\d+\/subtasks)$/.test(c.path));

	for (const { method, path } of calls) {
		let m: RegExpExecArray | null;
		if (method === "POST" && /^(tasks|tasks\/\d+\/subtasks)$/.test(path)) {
			const made = [...objects.values()].filter((o) => (o.resource_type ?? "task") === "task");
			if (made.length) found.push(...made.map((o) => withObject(asanaTask(o.gid, "created"), o)));
			else if (!failed && creates.length === 1) {
				// Output piped through jq down to the new gid alone.
				const bare = [...output.matchAll(/^\s*(\d{10,20})\s*$/gm)].map((x) => x[1]!);
				if (bare.length === 1) found.push(asanaTask(bare[0]!, "created"));
			}
			const parent = /^tasks\/(\d+)\/subtasks$/.exec(path)?.[1];
			if (parent) found.push(asanaTask(parent, "updated"));
		} else if (method === "POST" && path === "projects") {
			const made = [...objects.values()].filter((o) => o.resource_type === "project");
			found.push(...made.map((o) => withObject(asanaProject(o.gid, "created"), o)));
		} else if ((m = /^(tasks|projects)\/(\d+)(?:\/|$)/.exec(path))) {
			if (method === "DELETE") continue;
			const gid = m[2]!;
			const o = objects.get(gid);
			if (!o && failed) continue;
			const action: RefAction = method === "GET" ? "mentioned" : "updated";
			found.push(withObject(m[1] === "tasks" ? asanaTask(gid, action) : asanaProject(gid, action), o));
		} else if (method === "POST" && /^sections\/\d+\/addTask$/.test(path) && !failed) {
			for (const t of command.matchAll(/"task"\s*:\s*"(\d+)"/g)) found.push(asanaTask(t[1]!, "updated"));
		}
	}
	return found;
}

function asanaCall(words: string[], i: number): { method: string; path: string } | undefined {
	let method = "GET";
	let raw = words[i + 1];
	if (raw && METHODS.has(raw.toUpperCase())) {
		method = raw.toUpperCase();
		raw = words[i + 2];
	}
	if (!raw || raw.startsWith("-")) return undefined;
	const path = raw
		.replace(/^https?:\/\/app\.asana\.com\/api\/1\.0/, "")
		.replace(/^\/+/, "")
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "");
	return { method, path };
}

// ---------------------------------------------------------------------------
// Entry point for bash tool results
// ---------------------------------------------------------------------------

/** References created, changed, or looked at by one bash tool call. */
export function detectFromBash(command: string, output: string): Detected[] {
	if (!/\bgh\b|asana-cli/.test(command)) return [];
	const found: Detected[] = [];
	const asanaCalls: Array<{ method: string; path: string }> = [];

	for (const words of splitCommands(stripHeredocs(command))) {
		const gh = words.findIndex((w) => w === "gh" || w.endsWith("/gh"));
		if (gh >= 0) found.push(...detectGh(words.slice(gh + 1), output));
		const asana = words.findIndex((w) => w === "asana-cli" || w.endsWith("/asana-cli"));
		if (asana >= 0) {
			const call = asanaCall(words, asana);
			if (call) asanaCalls.push(call);
		}
	}
	if (asanaCalls.length) found.push(...detectAsana(asanaCalls, command, output));
	return dedupe(found);
}
