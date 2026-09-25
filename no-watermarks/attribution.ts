/**
 * Agent attribution: the visible watermark.
 *
 * Coding agents append their own signature to commit messages and PR bodies:
 *
 *     🤖 Generated with [Claude Code](https://claude.com/claude-code)
 *     Co-Authored-By: Claude <noreply@anthropic.com>
 *     Co-authored-by: Cursor <cursoragent@cursor.com>
 *     Generated-by: OpenAI Codex
 *     Assisted-by: Crush:grok-4.6
 *     Amp-Thread-ID: https://ampcode.com/threads/T-...
 *     Devin Session: https://app.devin.ai/sessions/...
 *
 * Four generic rules, driven by the registry in vendors.ts:
 *
 *  1. Identity trailers (`Co-authored-by`, `Signed-off-by`, `Assisted-by`,
 *     `Generated-by`, any `*-by` / `*-with`): removed only if the identity is
 *     an agent (see isAgentIdentity). Human co-authors survive.
 *  2. Agent metadata trailers: a trailer key naming an agent
 *     (`Copilot-Session`, `Amp-Thread-ID`) or an agent concept
 *     (`Committed-By-Agent`, `AI-*`).
 *  3. "Generated with X" lines for any registered agent, any leading emoji.
 *  4. Session-link lines: any line linking to an agent session page, plus
 *     Cursor's HTML "Open in Cursor" footer.
 *
 * Every rule matches a whole line only, and removes the newlines before it,
 * so what's left is the message as it read before the watermark.
 *
 * Scope is decided by the caller (index.ts): commit/PR commands and staged
 * message files. Never general files: a README documenting these trailers
 * (like this one) must survive.
 */

import {
	AGENT_NAMES,
	AGENT_ONLY_DOMAINS,
	KNOWN_BOT_LOGINS,
	PRODUCT_SUFFIXES,
	SESSION_URLS,
	VENDOR_DOMAINS,
	VENDOR_PREFIXES,
} from "./vendors.ts";

const alt = (xs: string[]) => `(?:${xs.join("|")})`;
const AGENT = alt(AGENT_NAMES);
const VENDOR = alt(VENDOR_PREFIXES);
const SUFFIX = alt(PRODUCT_SUFFIXES);

/** "OpenAI Codex", "Claude Code", "Cursor Cloud Agent", "Qwen-Coder", "Jetbrains Junie". */
const TOOL = String.raw`(?:${VENDOR}[ \t]+)?${AGENT}\b(?:[ \t-]+${SUFFIX}\b)*`;

const AGENT_WORD = new RegExp(String.raw`(?:^|[^\w])${AGENT}(?![\w])`, "i");
const LEADING_AGENT = new RegExp(String.raw`^[\s@*_]*(?:${VENDOR}[\s]+)?${AGENT}(?![\w])`, "i");
const AGENT_EXACT = new RegExp(String.raw`^${AGENT}$`, "i");

// ---------------------------------------------------------------------------
// Identity decision
// ---------------------------------------------------------------------------

/** Components that mark a hyphenated GitHub login as a bot/agent account. */
const BOT_COMPANIONS = new Set(["ai", "agent", "bot", "assist", "integration", "app", "code"]);

function isAgentLogin(rawLogin: string): boolean {
	const login = rawLogin.replace(/^\d+\+/, "").toLowerCase();
	const isBot = login.endsWith("[bot]");
	const bare = login.replace(/\[bot\]$/, "");
	if (KNOWN_BOT_LOGINS.includes(bare) || AGENT_EXACT.test(bare)) return true;
	const parts = bare.split(/[-_]/);
	const namesAgent = parts.some((p) => AGENT_EXACT.test(p));
	// "gemini-code-assist[bot]", "claude-ai", "junie-live-agent", but not a
	// human login that merely contains a word ("starofgodmayomi-droid").
	return namesAgent && (isBot || parts.some((p) => BOT_COMPANIONS.has(p)));
}

/**
 * Is `Name <email>` (or a bare name, or `Name:model`) an AI agent?
 * The email decides when present, since display names collide with humans
 * ("Claude Monet <claude@monet.fr>" stays).
 */
export function isAgentIdentity(value: string): boolean {
	const m = value.match(/^(.*?)\s*<([^>]*)>\s*$/);
	const name = (m ? m[1] : value).trim();
	const email = m ? m[2].trim().toLowerCase() : "";

	if (!email) return LEADING_AGENT.test(name) || (/\[bot\]$/i.test(name) && isAgentLogin(name));

	const at = email.lastIndexOf("@");
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);

	if (AGENT_ONLY_DOMAINS.includes(domain)) return true;
	if (domain === "users.noreply.github.com") return isAgentLogin(local);
	if (VENDOR_DOMAINS.includes(domain)) {
		return (
			/^no-?reply$/.test(local) ||
			local.includes("agent") || // cursoragent@cursor.com
			AGENT_WORD.test(local.replace(/[^a-z]/g, " ")) ||
			AGENT_WORD.test(name)
		);
	}
	return false;
}

/** Trailer keys that are agent metadata whatever their value. */
function isAgentKey(key: string): boolean {
	const parts = key.toLowerCase().split("-");
	return parts[0] === "ai" || parts.includes("agent") || parts.some((p) => AGENT_EXACT.test(p));
}

const isIdentityKey = (key: string) => /-(?:by|with)$/i.test(key);

// ---------------------------------------------------------------------------
// Line patterns
// ---------------------------------------------------------------------------

/**
 * A pattern must occupy a whole line: it starts after one or more newlines
 * (real, or a literal `\n` inside a quoted/JSON string, consumed so the
 * separating blank lines go too) or right after an opening shell quote
 * (`-m "Co-authored-by: ..."`, `body='...'`), and ends at a newline, a
 * closing shell quote, or the end. Quotes only count at argument
 * boundaries, so an apostrophe in prose ("Here's", "Claude Code's help")
 * is never mistaken for one.
 */
const PRE = String.raw`(?:(?:(?:\r?\n|\\n)[ \t]*)+|(?<=(?:^|[\s=])["'])[ \t]*)`;
const POST = String.raw`(?=[ \t]*(?:\r?\n|\\n|["'\x60](?=[\s);&|]|$)|$))`;
/** Line content that can't run past a closing shell quote or a literal `\n`. */
const TEXT = String.raw`[^\n"'\x60\\]`;

const TRAILER = new RegExp(PRE + String.raw`([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+):[ \t]*(${TEXT}*?)` + POST, "g");

const WRAP = String.raw`[*_]{0,2}`;
const GENERATED = new RegExp(
	PRE +
		WRAP +
		String.raw`(?:\p{Extended_Pictographic}\uFE0F?[ \t]*)?` +
		String.raw`(?:This (?:PR|pull request|commit|change)${TEXT}*?)?` +
		String.raw`(?:generated|created|made|written|authored|built|produced|coded)(?:[ \t]+automatically)?` +
		String.raw`[ \t]+(?:with|by|using|via|in)[ \t]+(?:(?:the|a|an)[ \t]+)?` +
		String.raw`(?:\[${TOOL}\]\([^)\s]*\)|${TOOL})` +
		String.raw`(?:[ \t]*\([^)\n]*\))*[.!]?` +
		WRAP +
		POST,
	"giu",
);

const SESSION_LINE = new RegExp(
	PRE + String.raw`${TEXT}*?https?:\/\/(?:www\.)?${alt(SESSION_URLS)}[^\s"'<>)\]\\]*${TEXT}*` + POST,
	"gi",
);

/** Cursor's `<div><a href="https://cursor.com/agents/...">...</a></div>` footer. */
const CURSOR_FOOTER = new RegExp(
	PRE + String.raw`<div>(?:(?!<\/div>)[^\n])*cursor\.com\/(?:agents|background-agent)(?:(?!<\/div>)[^\n])*<\/div>`,
	"gi",
);

export function stripAttribution(text: string): { text: string; count: number } {
	let count = 0;
	const drop = () => {
		count++;
		return "";
	};
	let out = text.replace(TRAILER, (match, key: string, value: string) => {
		if (isAgentKey(key)) return drop();
		if (isIdentityKey(key) && isAgentIdentity(value)) return drop();
		return match;
	});
	out = out.replace(GENERATED, drop);
	// Footer first: its URL sits inside href="...", which SESSION_LINE would
	// otherwise match on its own and leave an empty <a> behind.
	out = out.replace(CURSOR_FOOTER, drop);
	out = out.replace(SESSION_LINE, drop);
	return { text: out, count };
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/**
 * Does this shell command carry a commit/PR/issue/release message?
 * Only these get attribution stripping and invisible-Unicode cleaning;
 * arbitrary commands are left alone, since `rg '<ZWSP>'` or
 * `rg 'Co-authored-by: Claude'` legitimately contains what we'd strip.
 */
export function isMessageCommand(command: string): boolean {
	return (
		/\bgit\s+(?:-C\s+\S+\s+)?(?:commit|tag|notes|merge|revert)\b/.test(command) ||
		/\b(?:gh|glab)\s+(?:pr|mr|issue|release|api)\b/.test(command) ||
		/\bjj\s+(?:describe|desc|commit|new|split)\b/.test(command) ||
		/\b(?:hg|sl)\s+commit\b/.test(command)
	);
}

const TEMP_DIRS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

/**
 * Files where commit messages and PR bodies are staged: temp dirs (for
 * `--body-file` / `-F`) and git's own message files (COMMIT_EDITMSG, ...).
 */
export function isMessagePath(path: string, tmpdir?: string): boolean {
	if (/(?:^|\/)\.git\/(?:COMMIT_EDITMSG|MERGE_MSG|SQUASH_MSG|TAG_EDITMSG)$/.test(path)) return true;
	const dirs = tmpdir ? [...TEMP_DIRS, tmpdir.endsWith("/") ? tmpdir : `${tmpdir}/`] : TEMP_DIRS;
	return dirs.some((d) => path.startsWith(d));
}
