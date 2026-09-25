/**
 * No Watermarks Extension
 *
 * Deterministically strips AI provenance marks from what the agent produces,
 * whichever provider's model is behind it (Claude, Codex/GPT, Gemini, ...,
 * see vendors.ts), modeled on https://github.com/guillaumemeyer/watermarks-remover
 * (its deterministic "Layer A" plus its PostToolUse-hook idea) and on
 * ../no-em-dash/ (reply rewrite at `message_end`, argument repair at
 * `tool_call`). No prompt layer: the model doesn't choose to emit these, so
 * there's nothing to instruct; only verification works.
 *
 *  1. REPLY TEXT (`message_end`): invisible-Unicode carriers are removed from
 *     the assistant's text blocks, code included (a zero-width space inside
 *     a code block breaks copy-paste just as badly as in prose).
 *
 *  2. FILES (`tool_call`, write/edit): the same cleaning on `write.content`
 *     and each `edit.newText`, before the tool runs, so the bytes on disk
 *     are clean. Never `oldText`: it must match existing bytes, and a
 *     mismatch fails visibly. Private-use code points are kept in files
 *     (Nerd Font icons). Agent attribution is also stripped, but only for
 *     temp-dir paths and .git/COMMIT_EDITMSG-style files, where PR bodies
 *     and commit messages are staged.
 *
 *  3. MESSAGE COMMANDS (`tool_call`, bash): for git/jj/hg commits and
 *     gh/glab pr/mr/issue/release/api only, strip agent attribution
 *     (attribution.ts) and invisible Unicode. Other commands are left alone.
 *
 * Tool input and tool results are otherwise untouched (see ../secret-guard/
 * for why rewriting tool output is a trap).
 */

import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanInvisibleUnicode } from "./unicode.ts";
import { isMessageCommand, isMessagePath, stripAttribution } from "./attribution.ts";

const FILE_OPTS = { stripPrivateUse: false } as const;

function describe(kinds: Record<string, number>, attribution: number): string {
	const parts = Object.entries(kinds).map(([k, n]) => `${n} ${k}`);
	if (attribution > 0) parts.push(`${attribution} attribution line${attribution === 1 ? "" : "s"}`);
	return parts.join(", ");
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		const tool = event.toolName.toLowerCase();
		const kinds: Record<string, number> = {};
		let attribution = 0;
		let target = "";

		const cleanFile = (text: string, path: string): string => {
			const u = cleanInvisibleUnicode(text, FILE_OPTS);
			for (const [k, n] of Object.entries(u.kinds)) kinds[k] = (kinds[k] ?? 0) + n;
			if (!isMessagePath(path, tmpdir())) return u.text;
			const a = stripAttribution(u.text);
			attribution += a.count;
			return a.text;
		};

		if (tool === "write") {
			const input = event.input as { path: string; content: string };
			if (typeof input.content !== "string") return undefined;
			input.content = cleanFile(input.content, input.path ?? "");
			target = input.path;
		} else if (tool === "edit") {
			const input = event.input as { path: string; edits?: { oldText: string; newText: string }[] };
			if (!Array.isArray(input.edits)) return undefined;
			for (const edit of input.edits) {
				if (typeof edit.newText === "string") edit.newText = cleanFile(edit.newText, input.path ?? "");
			}
			target = input.path;
		} else if (tool === "bash") {
			const input = event.input as { command: string };
			if (typeof input.command !== "string" || !isMessageCommand(input.command)) return undefined;
			const a = stripAttribution(input.command);
			const u = cleanInvisibleUnicode(a.text);
			attribution = a.count;
			Object.assign(kinds, u.kinds);
			input.command = u.text;
			target = "command";
		} else {
			return undefined;
		}

		const summary = describe(kinds, attribution);
		if (summary && ctx.hasUI) ctx.ui.notify(`no-watermarks: stripped ${summary} from ${target}`, "info");
		return undefined;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return undefined;
		if (!Array.isArray(event.message.content)) return undefined;

		let changed = false;
		const content = event.message.content.map((block) => {
			if (block.type !== "text" || typeof block.text !== "string") return block;
			const { text, removed, replaced } = cleanInvisibleUnicode(block.text);
			if (removed + replaced === 0) return block;
			changed = true;
			return { ...block, text };
		});

		return changed ? { message: { ...event.message, content } } : undefined;
	});
}
