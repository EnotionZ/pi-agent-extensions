/**
 * Pure logic for keeping the right files in the system prompt's
 * `project_context` section, and for checking that they actually made it into
 * what gets sent. No pi imports, so it can be tested with `node --test`.
 *
 * "Context file" here means the same `{ path, content }` shape pi uses for
 * `systemPromptOptions.contextFiles`: pi renders each one as
 * `<project_instructions path="...">content</project_instructions>`.
 */

import path from "node:path";

export interface ContextFile {
	path: string;
	content: string;
}

/**
 * Put back any file pi would normally load (AGENTS.md at cwd and its
 * ancestors, plus the agent-dir global) that is missing from this run's
 * context files. Matched by path only: if the file changed on disk, the copy pi
 * already has is the one to keep.
 *
 * Missing files are inserted where pi itself would have put them, i.e. before
 * the next expected file that is present, so the rendered order still reads
 * global -> repo root -> cwd.
 */
export function ensureExpected(
	current: readonly ContextFile[],
	expected: readonly ContextFile[],
): { files: ContextFile[]; added: ContextFile[] } {
	const files = [...current];
	const has = (p: string) => files.some((f) => f.path === p);
	const added: ContextFile[] = [];

	expected.forEach((file, index) => {
		if (has(file.path)) return;
		const next = expected.slice(index + 1).find((e) => has(e.path));
		const at = next ? files.findIndex((f) => f.path === next.path) : files.length;
		files.splice(at, 0, file);
		added.push(file);
	});

	return { files, added };
}

/**
 * Pin companion files (by default `AGENTS-LOCAL.md`) that sit next to a loaded
 * context file, inserting each right after the file it accompanies.
 *
 * pi only auto-loads AGENTS.md/CLAUDE.md, so a companion otherwise enters the
 * conversation only when the agent reads it, as an ordinary tool result that
 * compaction summarizes away. In the system prompt it survives compaction.
 *
 * `readFile` returns the content, or undefined when the file does not exist or
 * is not a regular file.
 */
export function withCompanions(
	current: readonly ContextFile[],
	companionNames: readonly string[],
	readFile: (filePath: string) => string | undefined,
): { files: ContextFile[]; pinned: ContextFile[] } {
	const seen = new Set(current.map((f) => f.path));
	const files: ContextFile[] = [];
	const pinned: ContextFile[] = [];

	for (const file of current) {
		files.push(file);
		for (const name of companionNames) {
			const companionPath = path.join(path.dirname(file.path), name);
			if (seen.has(companionPath)) continue;
			const content = readFile(companionPath);
			if (content === undefined) continue;
			const companion = { path: companionPath, content };
			seen.add(companionPath);
			files.push(companion);
			pinned.push(companion);
		}
	}

	return { files, pinned };
}

/** How much of a file's leading text is used to recognise it in a prompt or payload. */
const FINGERPRINT_LENGTH = 240;

/**
 * A verbatim slice of the file used to test "is this file in there". pi embeds
 * context file content unmodified, so an exact substring match is reliable and
 * does not depend on the `<project_instructions>` wrapper, which a replaced
 * system prompt might not use.
 */
export function fingerprint(content: string): string {
	return content.trim().slice(0, FINGERPRINT_LENGTH);
}

/** Files whose fingerprint does not appear in `text`. Empty files are never "missing". */
export function missingFrom(text: string, files: readonly ContextFile[]): ContextFile[] {
	return files.filter((f) => {
		const fp = fingerprint(f.content);
		return fp !== "" && !text.includes(fp);
	});
}

/**
 * Same check against a provider request payload of any shape. The payload is
 * serialized once and each fingerprint is JSON-escaped the same way, so it
 * works for Anthropic's `system` blocks, OpenAI's `instructions` or leading
 * message, and anything else, without knowing the format.
 */
export function missingFromPayload(payload: unknown, files: readonly ContextFile[]): ContextFile[] {
	let serialized: string;
	try {
		serialized = JSON.stringify(payload) ?? "";
	} catch {
		return [];
	}
	return files.filter((f) => {
		const fp = fingerprint(f.content);
		return fp !== "" && !serialized.includes(JSON.stringify(fp).slice(1, -1));
	});
}

const block = (f: ContextFile) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`;

/** Files rendered the way pi renders its own `project_context` section, for appending to a system prompt. */
export function renderProjectInstructions(files: readonly ContextFile[]): string {
	return ["Project-specific instructions and guidelines:", ...files.map(block)].join("\n\n");
}

/** Text of the message that stands in for files missing from the system prompt. */
export function renderRestoreMessage(files: readonly ContextFile[]): string {
	return [
		"Project-specific instructions and guidelines. These belong in the system prompt but were missing from it for this request, so they are restored here. Treat them exactly as system-prompt project instructions:",
		...files.map(block),
	].join("\n\n");
}

/**
 * Insert `message` directly after the leading run of system messages. A fixed
 * position near the start keeps the provider's cached prefix stable across
 * requests, unlike appending it at the tail.
 */
export function insertAfterSystem<M extends { role: string }>(messages: readonly M[], message: M): M[] {
	const out = [...messages];
	let at = 0;
	while (at < out.length && out[at]!.role === "system") at++;
	out.splice(at, 0, message);
	return out;
}
