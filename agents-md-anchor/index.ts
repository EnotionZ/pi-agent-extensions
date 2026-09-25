/**
 * AGENTS.md Anchor Extension
 *
 * Keeps project instructions effective through long sessions. Three layers:
 *
 *  1. PIN (`before_agent_start`): adds companion files that sit next to a
 *     loaded AGENTS.md (default `AGENTS-LOCAL.md`) to the system prompt's
 *     context files. pi only auto-loads AGENTS.md/CLAUDE.md, so a companion
 *     otherwise arrives as a `read` result, which compaction drops.
 *
 *  2. REMIND (`turn_end`, `before_agent_start`): once the context is long, or
 *     right after a compaction, appends a persisted reminder restating the
 *     "Always apply" section and listing instruction files that were read
 *     earlier but are no longer in context. Persisted and sparse (not
 *     request-local on every call) so the provider's prompt cache stays valid.
 *
 *  3. GUARD (`before_agent_start`, `context_with_system`,
 *     `before_provider_request`): checks that every context file pi would
 *     load is actually present. Missing from the options -> put back. Missing
 *     from the effective prompt (e.g. another extension replaced the whole
 *     prompt) -> restored as a message right after the system prompt. Missing
 *     from the final provider payload -> warning.
 *
 * AGENTS.md itself lives in the system prompt, which pi keeps across
 * compaction (the compaction entry stores a copy), so layer 3 should normally
 * find nothing. It is there to prove that, and to catch the exceptions.
 *
 * Pure logic lives in context-files.ts and reminder.ts (tested with
 * `node --test *.test.ts`). Reload after editing with /reload.
 *
 * Configuration (environment):
 *   PI_AGENTS_ANCHOR_DISABLE  - "1" disables the extension.
 *   PI_AGENTS_ANCHOR_PIN      - colon-separated companion file names to pin
 *                               (default "AGENTS-LOCAL.md"; "" pins nothing).
 *   PI_AGENTS_ANCHOR_SECTION  - heading of the section to restate
 *                               (default "Always apply").
 *   PI_AGENTS_ANCHOR_FIRST    - context tokens before the first reminder
 *                               (default 80000).
 *   PI_AGENTS_ANCHOR_EVERY    - context growth between reminders
 *                               (default 80000).
 *   PI_AGENTS_ANCHOR_PINNED_MAX - largest pinned file (characters) restated in
 *                               full when it has no "Always apply" section
 *                               (default 8000, about 2k tokens).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import fs from "node:fs";
import os from "node:os";
import {
	type ContextFile,
	ensureExpected,
	insertAfterSystem,
	missingFrom,
	missingFromPayload,
	renderProjectInstructions,
	renderRestoreMessage,
	withCompanions,
} from "./context-files.ts";
import {
	buildReminder,
	DEFAULT_PINNED_MAX_CHARS,
	decideReminder,
	droppedInstructionFiles,
	type EntryLike,
	readPaths,
	REMINDER_CUSTOM_TYPE,
	type ReminderDetails,
} from "./reminder.ts";

function intFromEnv(name: string, fallback: number): number {
	const n = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function canonical(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

function readRegularFile(filePath: string): string | undefined {
	try {
		if (!fs.statSync(filePath).isFile()) return undefined;
		return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const disabled =
		process.env.PI_AGENTS_ANCHOR_DISABLE === "1" ||
		// Respect a deliberate opt-out of context files instead of undoing it.
		process.argv.includes("--no-context-files") ||
		process.argv.includes("-nc");
	if (disabled) return;

	const companions = (process.env.PI_AGENTS_ANCHOR_PIN ?? "AGENTS-LOCAL.md").split(":").filter(Boolean);
	const sectionHeading = process.env.PI_AGENTS_ANCHOR_SECTION ?? "Always apply";
	const policy = {
		firstAt: intFromEnv("PI_AGENTS_ANCHOR_FIRST", 80_000),
		every: intFromEnv("PI_AGENTS_ANCHOR_EVERY", 80_000),
	};
	const pinnedMaxChars = intFromEnv("PI_AGENTS_ANCHOR_PINNED_MAX", DEFAULT_PINNED_MAX_CHARS);
	const home = os.homedir();

	/** What pi's own discovery finds for this session's cwd. */
	let expected: ContextFile[] = [];
	/** Every context file the current run's prompt should contain (expected + pinned). */
	let runFiles: ContextFile[] = [];
	/** Paths of the companion files pinned for the current run. */
	let pinnedPaths = new Set<string>();
	/** Paths already warned about this session, so a persistent problem warns once. */
	const warned = new Set<string>();

	const warnOnce = (ctx: ExtensionContext, key: string, message: string) => {
		if (warned.has(key)) return;
		warned.add(key);
		if (ctx.hasUI) ctx.ui.notify(`agents-md-anchor: ${message}`, "warning");
		else console.warn(`[agents-md-anchor] ${message}`);
	};

	const reminderFor = (ctx: ExtensionContext) => {
		if (!runFiles.length) return undefined;
		const branch = ctx.sessionManager.getBranch() as unknown as EntryLike[];
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		const reason = decideReminder(branch, tokens, policy);
		if (!reason) return undefined;

		const dropped = droppedInstructionFiles({
			everRead: readPaths(branch, ctx.cwd, home),
			visibleRead: readPaths(ctx.sessionManager.buildContextEntries() as unknown as EntryLike[], ctx.cwd, home),
			contextFiles: runFiles,
			canonical,
		});
		const details: ReminderDetails = { reason, tokens: tokens ?? 0, dropped };
		return {
			customType: REMINDER_CUSTOM_TYPE,
			content: buildReminder({
				reason,
				tokens,
				contextFiles: runFiles,
				sectionHeading,
				dropped,
				pinned: pinnedPaths,
				pinnedMaxChars,
			}),
			display: true,
			details,
		};
	};

	pi.on("session_start", (_event, ctx) => {
		warned.clear();
		runFiles = [];
		pinnedPaths = new Set();
		try {
			expected = loadProjectContextFiles({ cwd: ctx.cwd, agentDir: getAgentDir() });
		} catch {
			expected = [];
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const opts = event.systemPromptOptions;

		// Guard, first check: files pi would load but that are absent from the options.
		const ensured = ensureExpected(opts.contextFiles ?? [], expected);
		for (const f of ensured.added) {
			warnOnce(ctx, `options:${f.path}`, `${f.path} was missing from the system prompt; restored it.`);
		}

		// Pin companions so compaction can't take them.
		const { files, pinned } = withCompanions(ensured.files, companions, readRegularFile);
		opts.contextFiles = files;
		runFiles = files;
		pinnedPaths = new Set(pinned.map((f) => f.path));

		// An extension that ran earlier may already have replaced the whole
		// prompt with a rendering taken before the lines above, e.g. one that
		// appends to `event.systemPrompt`. Extend its text rather than leave the
		// files to the per-request restore in `context_with_system`.
		const forced = opts.forceSystemPrompt;
		const lateAdded = forced === undefined ? [] : missingFrom(forced, files);
		const systemPrompt = lateAdded.length ? `${forced}\n\n${renderProjectInstructions(lateAdded)}` : undefined;

		// A new prompt in an already-long session gets its reminder now rather
		// than after the first tool call.
		const message = reminderFor(ctx);
		if (!message && systemPrompt === undefined) return undefined;
		return { ...(message ? { message } : {}), ...(systemPrompt !== undefined ? { systemPrompt } : {}) };
	});

	// Guard, second check: the effective prompt for this request. Another
	// extension returning `systemPrompt` replaces the rendered prompt wholesale,
	// which can drop project context (or miss what was pinned above, if it ran
	// first). Restore anything missing as a message right after the system
	// prompt, at a fixed position so the cached prefix survives.
	pi.on("context_with_system", (event, ctx) => {
		if (!runFiles.length) return undefined;
		const missing = missingFrom(ctx.getSystemPrompt(), runFiles);
		if (!missing.length) return undefined;
		for (const f of missing) {
			warnOnce(ctx, `prompt:${f.path}`, `${f.path} was missing from the effective system prompt; restored it as a message.`);
		}
		const restore = { role: "user" as const, content: [{ type: "text" as const, text: renderRestoreMessage(missing) }], timestamp: 0 };
		return { messages: insertAfterSystem(event.messages, restore as (typeof event.messages)[number]) };
	});

	// Guard, final check: is each file anywhere in what is actually sent?
	// Detection only; the payload shape is provider-specific.
	pi.on("before_provider_request", (event, ctx) => {
		if (!runFiles.length) return undefined;
		for (const f of missingFromPayload(event.payload, runFiles)) {
			warnOnce(ctx, `payload:${f.path}`, `${f.path} is not in the provider request. Something after pi's context assembly removed it.`);
		}
		return undefined;
	});

	// Mid-run reminder. Only when another request follows (tool results
	// pending); a reminder after the final answer would sit unused.
	pi.on("turn_end", (event, ctx) => {
		if (!event.toolResults.length) return undefined;
		const message = reminderFor(ctx);
		if (!message) return undefined;
		return { entries: [...event.entries, { type: "custom_message" as const, ...message }] };
	});

	pi.registerMessageRenderer<ReminderDetails>(REMINDER_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		const d = message.details;
		const why = d?.reason === "compacted" ? "after compaction" : `at ~${Math.round((d?.tokens ?? 0) / 1000)}k tokens`;
		const extra = d?.dropped.length ? `, ${d.dropped.length} file(s) to re-read` : "";
		let text = theme.fg("dim", `↻ project instructions reminder ${why}${extra}`);
		if (expanded) {
			const body = typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join("");
			text += `\n${theme.fg("dim", body)}`;
		}
		const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.registerCommand("agents-anchor", {
		description: "Show which project instruction files are pinned and present in the prompt",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			const missing = new Set(missingFrom(prompt, runFiles).map((f) => f.path));
			const expectedPaths = new Set(expected.map((f) => f.path));
			const lines = runFiles.length
				? runFiles.map((f) => `${missing.has(f.path) ? "✗ missing" : "✓ present"}  ${expectedPaths.has(f.path) ? "" : "(pinned) "}${f.path}`)
				: ["No run yet in this session; context files are checked on the next prompt."];
			const branch = ctx.sessionManager.getBranch() as unknown as EntryLike[];
			const reminders = branch.filter((e) => e.type === "custom_message" && e.customType === REMINDER_CUSTOM_TYPE).length;
			const tokens = ctx.getContextUsage()?.tokens;
			lines.push(
				`Reminders on this branch: ${reminders}. Context: ${tokens == null ? "unknown" : `${Math.round(tokens / 1000)}k`} tokens; first reminder at ${policy.firstAt / 1000}k, then every ${policy.every / 1000}k; pinned files restated in full up to ${pinnedMaxChars} chars.`,
			);
			ctx.ui.notify(lines.join("\n"), missing.size ? "warning" : "info");
		},
	});
}
