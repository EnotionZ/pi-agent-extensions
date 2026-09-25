/**
 * Pure rendering of the reference list as widget lines. No pi imports.
 *
 * pi-web shows a widget as a button (labelled with the widget key) by the chat
 * input; tapping it opens a panel with these lines in a <pre>, run through
 * ansi_up. Two ansi_up details shape this file:
 *
 *  - OSC 8 hyperlinks become real <a href> links, but only when the link text
 *    is printable ASCII (`[\x20-\x7e]+`) and the URL is at most 512 printable
 *    ASCII characters. Anything else leaves a raw ESC in the output. So link
 *    text is always an ASCII label, and non-ASCII titles go outside the link.
 *  - SGR colors and dim render as inline styles.
 *
 * pi-web also opens a widget of 2 or 3 lines by itself when the page loads,
 * so the rich layout is padded to at least 4 lines to stay a closed button.
 */

import type { Ref } from "./store.ts";

const ESC = "\x1b";
const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;
const color = (code: number, s: string) => `${ESC}[${code}m${s}${ESC}[39m`;

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** Printable text for the panel: no control characters, collapsed whitespace, bounded length. */
export function tidy(s: string, max = 80): string {
	const t = s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

/** An OSC 8 hyperlink, or the plain text when ansi_up could not render it as one. */
export function link(url: string, text: string): string {
	let href: string;
	try {
		href = new URL(url).href;
	} catch {
		return text;
	}
	if (!/^https?:/.test(href) || href.length > 512 || !/^[\x21-\x7e]+$/.test(href) || !PRINTABLE_ASCII.test(text)) return text;
	return `${ESC}]8;;${href}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

function stateTag(state: string | undefined): string {
	switch (state) {
		case "open":
			return color(32, "open");
		case "draft":
			return dim("draft");
		case "merged":
			return color(35, "merged");
		case "closed":
			return color(31, "closed");
		case "done":
			return color(32, "done");
		case "archived":
			return dim("archived");
		default:
			return "";
	}
}

const KIND_LABEL = { "github-pr": "PR", "asana-task": "Task", "asana-project": "Project" } as const;

/** One item. PRs link their `owner/repo#n` label; Asana links the name when it is ASCII. */
export function itemLine(ref: Ref): string {
	const title = ref.title ? tidy(ref.title) : "";
	const nameAsLink = ref.kind !== "github-pr" && title && PRINTABLE_ASCII.test(title);
	const parts = [
		KIND_LABEL[ref.kind],
		link(ref.url, nameAsLink ? title : ref.label),
		stateTag(ref.state),
		nameAsLink ? "" : title,
		dim(ref.action),
	];
	return parts.filter(Boolean).join(" ");
}

/** Plain one-line description for dialogs (no escapes). */
export function plainLine(ref: Ref): string {
	const title = ref.title ? ` - ${tidy(ref.title, 60)}` : "";
	return `${KIND_LABEL[ref.kind]} ${ref.label}${title} (${[ref.state, ref.action].filter(Boolean).join(", ")})`;
}

export function summary(refs: readonly Ref[]): string {
	const count = (kind: Ref["kind"]) => refs.filter((r) => r.kind === kind).length;
	const plural = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
	return [
		...plural(count("github-pr"), "PR", "PRs"),
		...plural(count("asana-task"), "Asana task", "Asana tasks"),
		...plural(count("asana-project"), "Asana project", "Asana projects"),
	].join(", ");
}

/**
 * Widget lines, or undefined to clear the widget.
 *
 * `rich` (pi-web): every item, padded so pi-web does not auto-open it.
 * `compact` (terminal, where a widget is always expanded): the summary and the
 * most recent `maxItems`.
 */
export function renderWidget(refs: readonly Ref[], mode: "rich" | "compact", maxItems = 4): string[] | undefined {
	if (!refs.length) return undefined;
	const head = dim(`${summary(refs)} \u00b7 /refs to manage`);

	if (mode === "compact") {
		const recent = [...refs].sort((a, b) => a.lastAt - b.lastAt).slice(-maxItems);
		const hidden = refs.length - recent.length;
		return [head, ...recent.map(itemLine), ...(hidden > 0 ? [dim(`\u2026 ${hidden} more`)] : [])];
	}

	const lines = [head, ...refs.map(itemLine)];
	while (lines.length < 4) lines.push("");
	return lines;
}
