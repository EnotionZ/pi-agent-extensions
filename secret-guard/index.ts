/**
 * Secret Guard Extension
 *
 * Redacts secret-shaped values (API keys, tokens, private key blocks, password/
 * secret assignments, credentials embedded in URLs) out of the assistant's own
 * reply text before it's finalized into the transcript/session/provider request.
 *
 * Scope, deliberately narrow: this does NOT touch tool input or tool output.
 * Reading a `.env`, `cat`-ing a file, grepping for a key name, or any other
 * tool_call/tool_result content is left completely alone — the concern this
 * guards against is the model *printing* a secret in its own chat reply, not
 * a tool reading one internally. An earlier version also hooked `tool_result`
 * to redact raw tool output, which caused real collateral damage: it corrupted
 * documentation that used realistic-looking example secrets to explain what
 * gets redacted, and even corrupted reads of this file's own source code
 * (`SECRET_PATTERNS: SecretPattern[]` misread as a `KEY: value` assignment).
 * Narrowing to `message_end` only removes that whole class of false positive
 * by construction — there's no legitimate reason for the assistant's own prose
 * reply to contain a real secret unless it's about to relay one to the user.
 *
 * Placement: ~/.pi/agent/extensions/secret-guard/index.ts (auto-discovered,
 * global directory form — see README.md alongside this file for full
 * documentation). Reload after editing with /reload (or restart the host
 * process if it's a persistently-running one — see the pm2/pi-web caching
 * note elsewhere).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SecretPattern {
	name: string;
	regex: RegExp;
	/** Capture group index holding just the secret value, if the match includes
	 *  surrounding context (e.g. `KEY=value`) that should be preserved. */
	valueGroup?: number;
}

const PLACEHOLDER_VALUES =
	/^(x+|\*+|changeme|change[_-]?me|example|placeholder|your[_-]?\w*|insert[_-]?\w*|replace[_-]?\w*|todo|redacted|none|null|n\/a|xxxx+|1234+)$/i;

// A run of strictly-consecutive characters ("abcdefg", "0123456789") is a strong
// signal of documentation/placeholder filler, not a real secret — cryptographically
// random tokens essentially never contain a long monotonic run.
function hasLongSequentialRun(value: string, minRun = 6): boolean {
	const lower = value.toLowerCase();
	let run = 1;
	for (let i = 1; i < lower.length; i++) {
		if (lower.charCodeAt(i) === lower.charCodeAt(i - 1) + 1) {
			run++;
			if (run >= minRun) return true;
		} else {
			run = 1;
		}
	}
	return false;
}

// A bare, digit-free, mixed-case identifier (optionally an array/generic type,
// e.g. `SecretPattern[]`, `Record<string, string>`) reads as a source-code type
// or identifier, not a secret value.
function looksLikeCodeIdentifierOrType(value: string): boolean {
	return (
		/^[A-Za-z_][A-Za-z0-9_]*(\[\])?(<[^>]*>)?$/.test(value) &&
		!/\d/.test(value) &&
		/[A-Z]/.test(value) &&
		/[a-z]/.test(value)
	);
}

const SECRET_PATTERNS: SecretPattern[] = [
	// Full PEM-style private key blocks
	{ name: "private-key", regex: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g },
	// Cloud/vendor token formats with distinctive prefixes
	{ name: "aws-access-key-id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
	{ name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
	{ name: "slack-token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
	{ name: "stripe-key", regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
	{ name: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
	{ name: "openai-key", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
	{ name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ name: "jwt", regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
	// user:password@host in a URL
	{ name: "url-basic-auth", regex: /(:\/\/[^/\s:@]+:)([^@\s]+)(@)/g, valueGroup: 2 },
	// KEY=value / KEY: value assignments where KEY looks like a secret name.
	{
		name: "assignment",
		regex:
			/\b((?:[A-Z0-9]+_)*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|CLIENT[_-]?SECRET)(?:_[A-Z0-9]+)*)\s*([:=])\s*(['"]?)([^\s'";,]{4,})\3/gi,
		valueGroup: 4,
	},
];

function redact(text: string): { text: string; count: number } {
	let result = text;
	let count = 0;

	for (const p of SECRET_PATTERNS) {
		p.regex.lastIndex = 0;
		result = result.replace(p.regex, (...args) => {
			const groups = args.slice(0, -2) as string[]; // drop offset, full string
			const full = groups[0];

			if (p.valueGroup === undefined) {
				if (hasLongSequentialRun(full)) return full; // looks like placeholder/example filler
				count++;
				return `[REDACTED:${p.name}]`;
			}

			const value = groups[p.valueGroup];
			if (
				!value ||
				PLACEHOLDER_VALUES.test(value) ||
				hasLongSequentialRun(value) ||
				looksLikeCodeIdentifierOrType(value)
			) {
				return full; // leave obvious placeholders/code identifiers alone
			}
			count++;
			return full.replace(value, `[REDACTED:${p.name}]`);
		});
	}

	return { text: result, count };
}

export default function (pi: ExtensionAPI) {
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return undefined;
		if (!Array.isArray(event.message.content)) return undefined;

		let totalRedacted = 0;
		const newContent = event.message.content.map((block) => {
			if (block.type !== "text" || typeof block.text !== "string") return block;
			const { text, count } = redact(block.text);
			totalRedacted += count;
			return count > 0 ? { ...block, text } : block;
		});

		if (totalRedacted === 0) return undefined;

		return { message: { ...event.message, content: newContent } };
	});
}
