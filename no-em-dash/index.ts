/**
 * No Em Dash Extension
 *
 * Two layers working together, added in this order after testing them
 * separately:
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
 * Both layers are scoped to the assistant's own prose, mirroring
 * secret-guard.ts's lesson about not touching tool input/output or code:
 * the prompt reminder explicitly carves out code being read/quoted/edited
 * verbatim, and the rewrite layer skips fenced code blocks and inline code
 * spans entirely.
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
import { replaceEmDashes } from "./em-dash.ts";
import { appendEmDashReminder } from "./reminder.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		return { systemPrompt: appendEmDashReminder(event.systemPrompt) };
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
