/**
 * Edit Guard Extension
 *
 * Blocks an `edit` whose replacement is a bare placeholder ("x", "unused",
 * "TODO", a literal "null") standing in for a substantial span of old text,
 * and a `write` that would replace an existing file with only a placeholder.
 * The model gets the reason back and retries with the real text.
 *
 * Why: the model sometimes clears a block with a stand-in, meaning to write
 * the real replacement in a follow-up call. The edit succeeds, so nothing
 * flags it, and if the follow-up is late or wrong the file is left with a
 * stray token where working text was. AGENTS-LOCAL.md forbids it, and a long
 * session broke that rule anyway, so this checks the detail instead of relying
 * on the instruction (the same reasoning as scope-guard and no-em-dash's
 * escape guard).
 *
 * An empty replacement, the way a deliberate deletion is written, is never
 * blocked, and neither is a placeholder swapped for a short token. Replayed
 * over 862 real edit calls, it flagged 5, all of them this mistake.
 *
 * The rules live in placeholder.ts (pure, `node --test *.test.ts`).
 *
 * Configuration:
 *   PI_EDIT_GUARD_DISABLE - "1" disables the extension.
 *
 * Reload after editing with /reload (restart a persistent host such as pi-web
 * if /reload does not take effect).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { checkEdit, checkWrite } from "./placeholder.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_EDIT_GUARD_DISABLE === "1") return;

	pi.on("tool_call", (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (event.toolName === "edit") return checkEdit(input);
		if (event.toolName === "write") {
			return checkWrite(input, (p) => {
				try {
					// ctx.cwd, not process.cwd(): under a persistent host the
					// process runs from wherever the host was launched.
					const stat = fs.statSync(path.resolve(ctx.cwd, p));
					return stat.isFile() ? stat.size : undefined;
				} catch {
					return undefined;
				}
			});
		}
		return undefined;
	});
}
