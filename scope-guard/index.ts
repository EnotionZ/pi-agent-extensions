/**
 * Scope Guard Extension
 *
 * Blocks filesystem-wide search/list commands (find, grep -r, ls -R, du, tree, ag)
 * that target a handful of paths that are almost never a legitimate search root —
 * `/`, a bare home directory, `/Users` itself, `/System`, `/Library`, `/proc`, etc.
 * — and recursive greps through node_modules/.git. Anywhere else is allowed; the
 * point isn't to keep the agent inside one project, it's to stop the specific
 * "walked the whole disk and locked up" failure mode.
 *
 * This exists because a model can be told in AGENTS.md/AGENTS-LOCAL.md not to run
 * `find /` or similar, but that's only a prompt-level hint — it can be ignored,
 * forgotten after compaction, or bypassed by a subagent that never saw the
 * instruction. This hook enforces it at the runtime level instead.
 *
 * The analysis itself lives in scope-check.ts (pure, unit-tested with
 * `node --test *.test.ts`); this file only wires it into pi's hook.
 *
 * Configuration:
 *   PI_SCOPE_EXTRA_DENY - colon-separated extra path prefixes to treat as broad
 *                         (e.g. a large mounted volume you never want scanned).
 *
 * Reload after editing with /reload — but note: in a persistently-running host
 * (e.g. pi-web under pm2), extensions may be cached at the process level, not
 * per-session. If /reload doesn't take effect, restart the host process.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createScopeChecker } from "./scope-check.ts";

export default function (pi: ExtensionAPI) {
	const checker = createScopeChecker({
		homeDir: os.homedir(),
		extraDeny: process.env.PI_SCOPE_EXTRA_DENY?.split(":").filter(Boolean) ?? [],
		hasVendorDirs: (dir) => {
			try {
				return fs.existsSync(path.join(dir, "node_modules")) || fs.existsSync(path.join(dir, ".git"));
			} catch {
				return false;
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const input = event.input as { command?: string; cwd?: string };
			// ctx.cwd, NOT process.cwd(): under a persistent host (pi-web/pm2),
			// process.cwd() is wherever the host was launched, not this session.
			return checker.checkShellCommand(input.command ?? "", input.cwd, ctx.cwd);
		}

		if (event.toolName === "find" || event.toolName === "grep" || event.toolName === "ls") {
			const input = event.input as { path?: string };
			if (input.path) return checker.checkToolPath(input.path, ctx.cwd);
		}

		return undefined;
	});
}
