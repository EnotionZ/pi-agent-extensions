/**
 * Registry of AI coding agents and the identities they sign with.
 *
 * Adding a provider should only ever mean editing the lists below; the
 * matching logic in attribution.ts is generic. Every entry here was seen in
 * real commits / PR bodies on GitHub (via `gh search commits` / `gh search
 * prs`), not guessed; see README.md "Where the patterns come from".
 */

/**
 * Agent / product / model-family names, matched case-insensitively as whole
 * words. Used for trailer identities (`Co-authored-by: Codex`), "Generated
 * with X" lines, and GitHub bot logins. Multi-word products are written as
 * a vendor prefix + name + suffix instead (see VENDOR_PREFIXES,
 * PRODUCT_SUFFIXES), so "OpenAI Codex", "Claude Code", "Cursor Cloud Agent",
 * "Mistral Vibe", and "Jetbrains Junie" all fall out of the entries below.
 */
export const AGENT_NAMES = [
	// Anthropic, OpenAI, Google
	"claude", "codex", "chatgpt", "gpt(?:-[\\w.]+)?", "gemini", "antigravity", "agy", "jules",
	// editors / IDE agents
	"cursor", "copilot", "windsurf", "cascade", "codeium", "junie", "kiro", "zed", "trae",
	"cline", "roo", "augment",
	// CLIs / hosted agents
	"aider", "devin", "amp", "opencode", "crush", "droid", "goose", "codebuff", "vibe",
	"qwen(?:-?coder|-?code)?", "gitar", "warp", "sweep", "tabnine", "replit", "pi",
	// model families that show up as the "agent" in Assisted-by / Generated-by
	"grok", "glm", "deepseek", "kimi", "llama", "mistral",
];

/** Company names that may precede an agent name: "OpenAI Codex", "Google Gemini". */
export const VENDOR_PREFIXES = [
	"openai", "anthropic", "google", "github", "sourcegraph", "jetbrains", "mistral", "factory",
	"cognition", "charm", "alibaba", "amazon", "aws", "xai", "moonshot", "augment",
];

/** Words that may follow an agent name: "Claude Code", "Gemini CLI", "Copilot Autofix". */
export const PRODUCT_SUFFIXES = [
	"code", "cli", "agent", "ai", "assist", "assistant", "chat", "cloud", "desktop", "app",
	"coder", "autofix", "vibe", "droid", "bot",
];

/** Domains used only by agents: any address here is an agent. */
export const AGENT_ONLY_DOMAINS = [
	"aider.chat", "ampcode.com", "opencode.ai", "kiro.dev", "codebuff.com", "antigravity.dev",
	"gitar.ai", "devin.ai",
];

/**
 * Vendor domains that also have human employees. An address here counts as
 * an agent only if its local part is `noreply`-ish or names an agent, or the
 * display name names an agent: `Codex <codex@openai.com>` and
 * `Claude <noreply@anthropic.com>` go, `Jane Doe <jane@openai.com>` stays.
 */
export const VENDOR_DOMAINS = [
	"anthropic.com", "openai.com", "cursor.com", "cursor.sh", "google.com", "jetbrains.com",
	"alibabacloud.com", "mistral.ai", "charm.land", "charm.sh", "github.com", "factory.ai",
	"cognition.ai", "sourcegraph.com", "windsurf.com", "codeium.com", "x.ai", "augmentcode.com",
	"cline.bot",
];

/** GitHub logins that are agents but don't match the generic login rule. */
export const KNOWN_BOT_LOGINS = ["factory-droid", "copilot-swe-agent", "chatgpt-codex-connector"];

/**
 * Hosts/paths of agent session pages. A PR-body line that links to one
 * ("Devin Session: https://app.devin.ai/sessions/...", a bare Codex task
 * URL) is a watermark, so the whole line goes.
 */
export const SESSION_URLS = [
	"chatgpt\\.com/codex/tasks",
	"app\\.devin\\.ai/(?:sessions|desktop)",
	"jules\\.google\\.com/(?:task|session)",
	"ampcode\\.com/threads",
	"cursor\\.com/(?:agents|background-agent)",
];
