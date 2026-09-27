/**
 * No Em Dash Extension
 *
 * Four layers working together, added in this order as each turned out not
 * to be enough on its own:
 *
 *  1. PROMPT LAYER (`before_agent_start`, reminder.ts): appends a short
 *     instruction to the system prompt every turn, asking the model not to
 *     produce em dashes at all. Verified live: with only this layer active,
 *     it reliably stops the literal character, but doesn't guarantee the
 *     *construction* it steers into is grammatical -- a sentence that would
 *     naturally have used a paired em dash for a parenthetical aside came
 *     out as a comma splice instead of the period/semicolon/colon the
 *     reminder asks for, because avoiding a character mid-generation isn't
 *     the same as having the deterministic rule that knows what a paired
 *     em dash aside should become.
 *
 *  2. REWRITE LAYER (`message_end`, em-dash.ts): deterministically rewrites
 *     any em dash that gets through anyway, choosing a period, comma,
 *     semicolon, or colon from the surrounding grammar (see em-dash.ts for
 *     the full rule set and rationale). This is the layer that guarantees
 *     the outcome; the prompt layer just makes it fire less often and,
 *     when the model does self-censor, nudges it toward a construction this
 *     layer doesn't have to fix.
 *
 *  3. ESCAPE-SEQUENCE REPAIR for new prose (`tool_call`, escape-guard.ts):
 *     when the model, drafting new `write`/`edit` content, types a literal
 *     `\uXXXX` escape instead of the real character (not just dashes;
 *     checkmarks and curly quotes have shown up the same way), repair it
 *     before the tool executes. Scoped to prose paths and outside code
 *     spans/fences, since there's no file to check a guess against here.
 *
 *  4. ESCAPE-SEQUENCE REPAIR for `oldText` (`tool_call`, oldtext-repair.ts):
 *     the same mistake, but reproducing a character that's already in the
 *     file being edited, which makes `oldText` fail to match anything.
 *     Recurred across multiple real sessions, each needing a manual
 *     re-read-and-retry. Layer 3 deliberately never touches `oldText` (no
 *     file to verify against there), so this is a separate mechanism: read
 *     the actual target file, and only repair when doing so takes `oldText`
 *     from zero matches to exactly one. That verification is why this layer
 *     can safely apply to any file type and any codepoint, not just
 *     prose/dashes.
 *
 * Layers 1-3 are scoped to the assistant's own prose, mirroring
 * secret-guard.ts's lesson about not touching tool input/output or code:
 * the prompt reminder explicitly carves out code being read/quoted/edited
 * verbatim, and the rewrite layer skips fenced code blocks and inline code
 * spans entirely. Layer 4 is the exception, and deliberately so -- see its
 * own docstring in oldtext-repair.ts for why verifying against real file
 * bytes makes the usual code/prose carve-out unnecessary there.
 *
 * Placement: ~/.pi/agent/extensions/no-em-dash/ (a folder with an index.ts
 * is auto-discovered the same as a top-level *.ts file). Kept as a folder
 * so em-dash.ts and reminder.ts can be imported and unit-tested
 * (em-dash.test.ts, reminder.test.ts) on their own, without needing a
 * running pi session -- extensions only load on session start/`/reload`,
 * which makes a fast edit-test loop on a single file important.
 *
 * Reload after editing with /reload (or restart the host process if it's a
 * persistently-running one).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { replaceEmDashes } from "./em-dash.ts";
import { appendEmDashReminder } from "./reminder.ts";
import { isProsePath, repairEscapedUnicode } from "./escape-guard.ts";
import { repairOldText } from "./oldtext-repair.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		return { systemPrompt: appendEmDashReminder(event.systemPrompt) };
	});

	// Third layer, added after the reminder's tool-call-argument carve-out
	// still wasn't enough in practice: across multiple real sessions, the
	// model has written the literal six characters `\u2014` (or `\u2705`, or
	// other codepoints) instead of the real character while drafting new
	// prose, caught only by grepping the result afterward each time.
	// Deterministically repair it before the tool executes, the same
	// "verify, don't just instruct" principle as the rewrite layer below.
	//
	// `newText`/`content` (new prose the model is generating) is repaired by
	// escape-guard.ts, scoped tightly to prose paths and outside code
	// spans/fences (see its docstring) since it has no file to check a guess
	// against.
	//
	// `oldText` is repaired separately by oldtext-repair.ts, which *does* have
	// something to check against: the real file the edit targets. It only
	// applies the repair when doing so takes `oldText` from matching nowhere
	// to matching exactly once in that file's actual bytes, so it's safe to
	// run on any file type and any escaped codepoint, not just prose/dashes.
	// This closes a gap seen recurring across multiple real sessions: an
	// `edit` call whose `oldText` had to reproduce an em dash or checkmark
	// already in the target file failed with "text not found" because the
	// model typed the escape instead of the glyph, and needed a manual
	// re-read-and-retry every time.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "write") {
			const input = event.input as { path: string; content: string };
			if (!isProsePath(input.path)) return undefined;
			const { text, count } = repairEscapedUnicode(input.content);
			if (count > 0) input.content = text;
			return undefined;
		}
		if (event.toolName === "edit") {
			const input = event.input as { path: string; edits: { oldText: string; newText: string }[] };

			try {
				const absPath = path.resolve(ctx.cwd, input.path);
				const fileContent = fs.readFileSync(absPath, "utf8");
				for (const edit of input.edits) {
					const { text, repaired } = repairOldText(edit.oldText, fileContent);
					if (repaired) edit.oldText = text;
				}
			} catch {
				// File missing/unreadable -- leave oldText alone; the edit tool's
				// own error is the right one to surface.
			}

			if (!isProsePath(input.path)) return undefined;
			for (const edit of input.edits) {
				const { text, count } = repairEscapedUnicode(edit.newText);
				if (count > 0) edit.newText = text;
			}
			return undefined;
		}
		return undefined;
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return undefined;
		if (!Array.isArray(event.message.content)) return undefined;

		let totalReplaced = 0;
		const newContent = event.message.content.map((block) => {
			if (block.type !== "text" || typeof block.text !== "string") return block;
			const { text, count } = replaceEmDashes(block.text);
			totalReplaced += count;
			return count > 0 ? { ...block, text } : block;
		});

		if (totalReplaced === 0) return undefined;

		return { message: { ...event.message, content: newContent } };
	});
}
