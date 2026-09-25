/**
 * Pure logic for the recency reminder: when to send one, and what it says.
 * No pi imports, so it can be tested with `node --test`.
 *
 * The problem this addresses is not that AGENTS.md leaves the context (in pi
 * it lives in the system prompt, which compaction keeps). It is that a rule
 * stated once at the very front of a very long context gets less and less
 * weight, and that the focused instruction files AGENTS.md sends the agent to
 * are ordinary `read` results, which compaction does remove. The reminder
 * restates the rules that must always apply near the end of the context and
 * lists instruction files that were read earlier but are no longer visible.
 */

import path from "node:path";
import type { ContextFile } from "./context-files.ts";

export const REMINDER_CUSTOM_TYPE = "agents-md-anchor";

// ---------------------------------------------------------------------------
// When to remind
// ---------------------------------------------------------------------------

/** The subset of a session entry this module looks at. */
export interface EntryLike {
	type: string;
	customType?: string;
	details?: unknown;
	message?: { role?: string; content?: unknown };
}

export interface ReminderDetails {
	reason: ReminderReason;
	/** Context tokens when the reminder was sent (0 when unknown). */
	tokens: number;
	/** Instruction files listed as needing a re-read. */
	dropped: string[];
}

export type ReminderReason = "compacted" | "long";

export interface ReminderPolicy {
	/** Context size at which the first reminder is sent. */
	firstAt: number;
	/** Further context growth after which another reminder is sent. */
	every: number;
}

/**
 * Decide whether a reminder is due, from the active branch (root to leaf, full
 * history including entries compaction replaced) and the current context size.
 *
 * - A compaction after the last reminder (or with no reminder yet) makes one
 *   due immediately, regardless of size: whatever the agent had re-read is now
 *   gone, and the summary rarely carries instructions verbatim.
 * - Otherwise one is due once the context reaches `firstAt`, and again every
 *   `every` tokens after the previous reminder.
 */
export function decideReminder(
	branch: readonly EntryLike[],
	tokens: number | null,
	policy: ReminderPolicy,
): ReminderReason | undefined {
	let lastCompaction = -1;
	let lastReminder = -1;
	branch.forEach((entry, i) => {
		if (entry.type === "compaction") lastCompaction = i;
		else if (entry.type === "custom_message" && entry.customType === REMINDER_CUSTOM_TYPE) lastReminder = i;
	});

	if (lastCompaction > lastReminder) return "compacted";
	if (tokens === null) return undefined;

	if (lastReminder < 0) return tokens >= policy.firstAt ? "long" : undefined;

	const previous = (branch[lastReminder]!.details as Partial<ReminderDetails> | undefined)?.tokens ?? 0;
	return tokens - previous >= policy.every ? "long" : undefined;
}

// ---------------------------------------------------------------------------
// What to say
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * The Markdown section whose heading matches `heading` (case-insensitive,
 * ignoring surrounding whitespace), including the heading line, up to the next
 * heading of the same or a higher level. Headings inside fenced code blocks are
 * ignored. Undefined when there is no such heading.
 */
export function extractSection(markdown: string, heading: string): string | undefined {
	const wanted = heading.trim().toLowerCase();
	const lines = markdown.split(/\r?\n/);
	let inFence = false;
	let start = -1;
	let level = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const match = HEADING.exec(line);
		if (!match) continue;
		const thisLevel = match[1]!.length;
		if (start < 0) {
			if (match[2]!.trim().toLowerCase() === wanted) {
				start = i;
				level = thisLevel;
			}
		} else if (thisLevel <= level) {
			return lines.slice(start, i).join("\n").trim();
		}
	}

	return start < 0 ? undefined : lines.slice(start).join("\n").trim();
}

const LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * Absolute paths of the Markdown files a context file links to, e.g. the
 * `agent-instructions/*.md` an AGENTS.md "read this next" table points at.
 * External URLs, pure anchors, and non-Markdown targets are skipped.
 */
export function linkedMarkdownFiles(file: ContextFile): string[] {
	const dir = path.dirname(file.path);
	const out = new Set<string>();
	for (const match of file.content.matchAll(LINK)) {
		let target = match[1]!;
		if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
		target = target.split("#")[0]!;
		try {
			target = decodeURIComponent(target);
		} catch {
			// keep as written
		}
		if (!/\.md$/i.test(target)) continue;
		out.add(path.resolve(dir, target));
	}
	return [...out];
}

/** Resolve a `read` tool path argument the way the tool would. */
export function resolveReadPath(p: string, cwd: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return path.join(home, p.slice(2));
	return path.resolve(cwd, p);
}

/** Absolute paths passed to the `read` tool by assistant messages in `entries`. */
export function readPaths(entries: readonly EntryLike[], cwd: string, home: string): Set<string> {
	const out = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; name?: string; arguments?: { path?: unknown } }>) {
			if (block?.type !== "toolCall" || block.name?.toLowerCase() !== "read") continue;
			const p = block.arguments?.path;
			if (typeof p === "string" && p.trim()) out.add(resolveReadPath(p.trim(), cwd, home));
		}
	}
	return out;
}

/**
 * Instruction files that were read at some point on this branch but whose
 * reads are no longer in the model's context. An instruction file is one a
 * context file links to, or any `SKILL.md`. Files already in the system prompt
 * are excluded: they never went anywhere.
 *
 * `canonical` maps every path to one spelling before comparing (the extension
 * passes realpath, since e.g. macOS `/tmp` is `/private/tmp`).
 */
export function droppedInstructionFiles(opts: {
	everRead: ReadonlySet<string>;
	visibleRead: ReadonlySet<string>;
	contextFiles: readonly ContextFile[];
	canonical?: (p: string) => string;
}): string[] {
	const c = opts.canonical ?? ((p: string) => p);
	const inPrompt = new Set(opts.contextFiles.map((f) => c(f.path)));
	const linked = new Set(opts.contextFiles.flatMap(linkedMarkdownFiles).map(c));
	const visible = new Set([...opts.visibleRead].map(c));
	const out = new Set<string>();
	for (const p of [...opts.everRead].map(c)) {
		if (inPrompt.has(p) || visible.has(p)) continue;
		if (linked.has(p) || path.basename(p) === "SKILL.md") out.add(p);
	}
	return [...out].sort();
}

/** Default cap on a pinned file restated in full: about 2k tokens. */
export const DEFAULT_PINNED_MAX_CHARS = 8000;

export function buildReminder(opts: {
	reason: ReminderReason;
	tokens: number | null;
	contextFiles: readonly ContextFile[];
	sectionHeading: string;
	dropped: readonly string[];
	/**
	 * Paths of the companion files this extension pinned (AGENTS-LOCAL.md).
	 * One without the section is restated in full, up to `pinnedMaxChars`: a
	 * pinned file is short, local rules written to be followed on every step,
	 * and without this its rules were never restated at all, because it has
	 * no "Always apply" heading. A live 500k-token session broke exactly those
	 * rules (placeholder edits) while following every restated one.
	 */
	pinned?: ReadonlySet<string>;
	pinnedMaxChars?: number;
}): string {
	const why =
		opts.reason === "compacted"
			? "Earlier parts of this conversation were just compacted into a summary."
			: `This conversation is now long (about ${Math.round((opts.tokens ?? 0) / 1000)}k tokens of context).`;

	const maxChars = opts.pinnedMaxChars ?? DEFAULT_PINNED_MAX_CHARS;
	const tooLong: string[] = [];
	const sections = opts.contextFiles.flatMap((f) => {
		const text = extractSection(f.content, opts.sectionHeading);
		if (text) return [`<always_apply source="${f.path}">\n${text}\n</always_apply>`];
		if (!opts.pinned?.has(f.path)) return [];
		const whole = f.content.trim();
		if (!whole) return [];
		if (whole.length > maxChars) {
			tooLong.push(f.path);
			return [];
		}
		return [`<always_apply source="${f.path}">\n${whole}\n</always_apply>`];
	});

	const parts = [
		why,
		"The project instructions in your system prompt still apply in full; nothing later in this conversation has replaced them." +
			(sections.length
				? " Before your next step, re-check the rules that must always apply:"
				: ` Before your next step, re-check them. They come from: ${opts.contextFiles.map((f) => f.path).join(", ")}.`),
		...sections,
	];

	if (tooLong.length) {
		parts.push(
			"These pinned instruction files are in your system prompt and apply in full, but are too long to restate here. Re-check them before continuing:\n" +
				tooLong.map((p) => `- ${p}`).join("\n"),
		);
	}

	if (opts.dropped.length) {
		parts.push(
			"You read these instruction files earlier, but they are no longer in your context. Re-read any that bear on the work in progress before continuing:\n" +
				opts.dropped.map((p) => `- ${p}`).join("\n"),
		);
	}

	parts.push("This is an automatic reminder, not a new request. Do not reply to it; continue the task.");

	return `<project_instructions_reminder>\n${parts.join("\n\n")}\n</project_instructions_reminder>`;
}
