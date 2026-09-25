/**
 * Session References Extension
 *
 * Collects the GitHub PRs and Asana tasks/projects a session creates, changes,
 * or mentions, and shows them as a `refs` widget. In pi-web that is a button by
 * the chat input that opens a panel of clickable links; in the terminal it is a
 * compact block above the editor.
 *
 * Detection (detect.ts):
 *  - `message_end`: PR / Asana URLs in user and assistant text -> "mentioned".
 *  - `tool_result` (bash): `gh pr create|merge|comment|view ...`, `gh api
 *    repos/.../pulls/N`, and `asana-cli` calls on single tasks/projects, with
 *    the action taken from the command. Other tool output is not scanned.
 *
 * Storage (store.ts): an append-only log of `pi.appendEntry("session-refs")`
 * records. Custom entries are never sent to the model, and rebuilding from the
 * active branch at `session_start` / `session_tree` keeps the list correct
 * across reloads, pi-web idle eviction, resumes and /tree navigation. Records
 * are written at turn/agent boundaries rather than mid tool batch.
 *
 * Enrichment: new or changed refs are looked up in the background (`gh pr
 * view --json`, `asana-cli GET`) for their title and state.
 *
 * Configuration (environment):
 *   PI_REFS_DISABLE=1     disable the extension
 *   PI_REFS_ENRICH=0      no background gh / asana-cli lookups
 *   PI_REFS_ASANA_CLI     path to asana-cli (default ~/.pi/agent/skills/asana/asana-cli)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Detected, findInText, detectFromBash, jsonObjects } from "./detect.ts";
import { plainLine, renderWidget } from "./render.ts";
import { ENTRY_TYPE, merge, recordsFrom, replay, type Ref, type RefRecord, visible } from "./store.ts";

const WIDGET_KEY = "refs";
const KIND_NAME = { "github-pr": "PR", "asana-task": "Asana task", "asana-project": "Asana project" } as const;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b: { type?: string; text?: unknown }) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_REFS_DISABLE === "1") return;

	const enrichEnabled = process.env.PI_REFS_ENRICH !== "0";
	const asanaCli = process.env.PI_REFS_ASANA_CLI ?? path.join(os.homedir(), ".pi/agent/skills/asana/asana-cli");

	let refs = new Map<string, Ref>();
	let pending: RefRecord[] = [];
	/** Bumped on every session (re)start, so late async results for an old session are dropped. */
	let generation = 0;
	let lastCtx: ExtensionContext | undefined;
	const inFlight = new Set<string>();

	const render = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const lines = renderWidget(visible(refs), ctx.mode === "tui" ? "compact" : "rich");
		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
	};

	const flush = () => {
		if (!pending.length) return;
		const records = pending;
		pending = [];
		for (const r of records) pi.appendEntry(ENTRY_TYPE, r);
	};

	const flushIfIdle = (ctx: ExtensionContext) => {
		try {
			if (ctx.isIdle()) flush();
		} catch {
			// stale context after a session switch; the next boundary flushes
		}
	};

	/** Apply sightings; persist, render and enrich whatever changed. */
	const observe = (ctx: ExtensionContext, found: readonly Detected[], opts: { notify?: boolean; enrich?: boolean } = {}) => {
		const changed: Ref[] = [];
		for (const d of found) {
			const before = refs.get(d.key);
			const at = Date.now();
			const next = merge(before, d, at);
			if (!next) continue;
			refs.set(next.key, next);
			pending.push({ v: 1, op: "upsert", at, ref: d });
			changed.push(next);
			if (opts.notify !== false && ctx.hasUI && next.action === "created" && before?.action !== "created") {
				ctx.ui.notify(`refs: ${KIND_NAME[next.kind]} ${next.label} created`, "info");
			}
			const wantsDetails = !before || !next.title || d.action !== "mentioned";
			if (opts.enrich !== false && wantsDetails) enrich(next);
		}
		if (!changed.length) return;
		render(ctx);
		flushIfIdle(ctx);
	};

	/** Look up title/state in the background; results come back as ordinary sightings. */
	const enrich = (ref: Ref) => {
		if (!enrichEnabled || inFlight.has(ref.key)) return;
		const gen = generation;
		inFlight.add(ref.key);
		lookup(ref)
			.then((details) => {
				if (gen !== generation || !details || !lastCtx) return;
				observe(lastCtx, [{ ...details, key: ref.key, kind: ref.kind, label: ref.label, action: "mentioned" }], { notify: false, enrich: false });
			})
			.catch(() => undefined)
			.finally(() => inFlight.delete(ref.key));
	};

	const lookup = async (ref: Ref): Promise<Pick<Detected, "url" | "title" | "state" | "urlSynthetic"> | undefined> => {
		if (ref.kind === "github-pr") {
			const r = await pi.exec("gh", ["pr", "view", ref.url, "--json", "title,state,isDraft,url"], { timeout: 15_000 });
			if (r.code !== 0) return undefined;
			const j = JSON.parse(r.stdout) as { title?: string; state?: string; isDraft?: boolean; url?: string };
			const state = j.state === "OPEN" && j.isDraft ? "draft" : j.state?.toLowerCase();
			return { url: j.url ?? ref.url, title: j.title, state };
		}
		if (!fs.existsSync(asanaCli)) return undefined;
		const gid = ref.key.split(":")[1]!;
		const [endpoint, fields] =
			ref.kind === "asana-task" ? [`/tasks/${gid}`, "name,completed,permalink_url"] : [`/projects/${gid}`, "name,archived,permalink_url"];
		const r = await pi.exec(asanaCli, ["GET", endpoint, "-q", `opt_fields=${fields}`], { timeout: 15_000 });
		if (r.code !== 0) return undefined;
		const data = (jsonObjects(r.stdout)[0] as { data?: { name?: string; completed?: boolean; archived?: boolean; permalink_url?: string } })?.data;
		if (!data) return undefined;
		return {
			url: data.permalink_url ?? ref.url,
			urlSynthetic: data.permalink_url ? undefined : ref.urlSynthetic,
			title: data.name,
			state: data.completed ? "done" : data.archived ? "archived" : undefined,
		};
	};

	const rebuild = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		refs = replay(recordsFrom(ctx.sessionManager.getBranch() as unknown as Array<{ type: string; customType?: string; data?: unknown }>));
		render(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		generation++;
		pending = [];
		inFlight.clear();
		rebuild(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		flush();
		generation++;
		rebuild(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		lastCtx = ctx;
		const role = event.message.role;
		if (role !== "user" && role !== "assistant") return undefined;
		const found = findInText(textOf(event.message.content));
		if (found.length) observe(ctx, found);
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		lastCtx = ctx;
		if (event.toolName !== "bash") return undefined;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return undefined;
		const found = detectFromBash(command, textOf(event.content));
		if (found.length) observe(ctx, found);
		return undefined;
	});

	pi.on("turn_end", () => {
		flush();
		return undefined;
	});
	pi.on("agent_end", () => flush());
	pi.on("session_shutdown", () => {
		try {
			flush();
		} catch {
			// session already closed
		}
		generation++;
	});

	const persistNow = (ctx: ExtensionContext, record: RefRecord) => {
		pending.push(record);
		render(ctx);
		flushIfIdle(ctx);
	};

	const remove = (ctx: ExtensionContext, ref: Ref) => {
		const at = Date.now();
		refs.set(ref.key, { ...ref, removed: true, lastAt: at });
		persistNow(ctx, { v: 1, op: "remove", at, key: ref.key });
	};

	const pick = async (ctx: ExtensionContext, title: string): Promise<Ref | undefined> => {
		const list = visible(refs);
		if (!list.length) {
			ctx.ui.notify("No references in this session yet.", "info");
			return undefined;
		}
		const labels = list.map(plainLine);
		const chosen = await ctx.ui.select(title, labels);
		return chosen === undefined ? undefined : list[labels.indexOf(chosen)];
	};

	pi.registerCommand("refs", {
		description: "Session references (PRs, Asana): /refs [add <url>|refresh|remove|clear]",
		getArgumentCompletions: (prefix) =>
			["add", "refresh", "remove", "clear"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const [sub = "", ...rest] = args.trim().split(/\s+/);

			if (sub === "add") {
				const found = findInText(rest.join(" ")).map((d) => ({ ...d, manual: true }));
				if (!found.length) return ctx.ui.notify("No GitHub PR or Asana URL found in that text.", "warning");
				observe(ctx, found, { notify: false });
				return ctx.ui.notify(`Added ${found.length} reference${found.length === 1 ? "" : "s"}.`, "info");
			}
			if (sub === "refresh") {
				const list = visible(refs);
				for (const r of list) enrich(r);
				return ctx.ui.notify(enrichEnabled ? `Refreshing ${list.length} reference(s)...` : "Lookups are disabled (PI_REFS_ENRICH=0).", "info");
			}
			if (sub === "remove") {
				const ref = await pick(ctx, "Remove which reference?");
				if (ref) remove(ctx, ref);
				return;
			}
			if (sub === "clear") {
				if (!visible(refs).length) return ctx.ui.notify("Nothing to clear.", "info");
				if (!(await ctx.ui.confirm("Clear references", "Remove every reference from this session's list?"))) return;
				const at = Date.now();
				for (const [key, ref] of refs) refs.set(key, { ...ref, removed: true, lastAt: at });
				return persistNow(ctx, { v: 1, op: "clear", at });
			}
			if (sub) return ctx.ui.notify("Usage: /refs [add <url>|refresh|remove|clear]", "warning");

			const ref = await pick(ctx, "Session references");
			if (!ref) return;
			const action = await ctx.ui.select(plainLine(ref), ["Insert link into prompt", "Refresh details", "Remove from list"]);
			if (action === "Insert link into prompt") ctx.ui.pasteToEditor(`${ref.url} `);
			else if (action === "Refresh details") enrich(ref);
			else if (action === "Remove from list") remove(ctx, ref);
		},
	});
}
