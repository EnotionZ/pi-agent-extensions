/**
 * Pure reference list state: merging sightings, and rebuilding the list from
 * the session's persisted records. No pi imports.
 *
 * Persistence is an append-only log of small records (`pi.appendEntry`), not a
 * snapshot, so it follows pi's session tree: rebuilding from the active branch
 * gives exactly the references that branch saw.
 */

import { ACTION_RANK, clean, combine, type Detected } from "./detect.ts";

export const ENTRY_TYPE = "session-refs";

export interface Ref extends Detected {
	firstAt: number;
	lastAt: number;
	removed?: boolean;
}

export type RefRecord =
	| { v: 1; op: "upsert"; at: number; ref: Detected }
	| { v: 1; op: "remove"; at: number; key: string }
	| { v: 1; op: "clear"; at: number };

const MATERIAL: Array<keyof Detected> = ["action", "title", "state", "url", "label"];

/**
 * Apply one sighting. Returns the new ref when something the user would see
 * changed, or undefined when it is a repeat (so nothing needs persisting).
 *
 * A removed ref stays removed when it is merely mentioned again: the agent
 * restating a link should not undo the user's removal. Creating or changing it
 * again, or adding it by hand, brings it back.
 */
export function merge(existing: Ref | undefined, d: Detected, at: number): Ref | undefined {
	if (!existing) return clean({ ...d, manual: undefined, firstAt: at, lastAt: at });
	if (existing.removed && !d.manual && ACTION_RANK[d.action] < ACTION_RANK.updated) return undefined;

	const merged = combine(existing, d);
	const revived = existing.removed === true;
	const changed = revived || MATERIAL.some((k) => merged[k] !== existing[k]);
	if (!changed) return undefined;
	return clean({ ...merged, manual: undefined, removed: undefined, firstAt: existing.firstAt, lastAt: at });
}

/** Rebuild the list from persisted records, in order. */
export function replay(records: readonly RefRecord[]): Map<string, Ref> {
	const refs = new Map<string, Ref>();
	for (const r of records) {
		if (r.op === "upsert") {
			const next = merge(refs.get(r.ref.key), r.ref, r.at);
			if (next) refs.set(next.key, next);
		} else if (r.op === "remove") {
			const ref = refs.get(r.key);
			if (ref) refs.set(r.key, { ...ref, removed: true, lastAt: r.at });
		} else if (r.op === "clear") {
			for (const [key, ref] of refs) refs.set(key, { ...ref, removed: true, lastAt: r.at });
		}
	}
	return refs;
}

/** Records of this extension among session entries (e.g. `sessionManager.getBranch()`). */
export function recordsFrom(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): RefRecord[] {
	return entries.flatMap((e) => {
		if (e.type !== "custom" || e.customType !== ENTRY_TYPE) return [];
		const d = e.data as Partial<RefRecord> | undefined;
		if (d?.v !== 1 || typeof d.at !== "number") return [];
		if (d.op === "upsert" && d.ref && typeof d.ref.key === "string") return [d as RefRecord];
		if (d.op === "remove" && typeof (d as { key?: unknown }).key === "string") return [d as RefRecord];
		if (d.op === "clear") return [d as RefRecord];
		return [];
	});
}

/**
 * Visible refs, in panel order: what the session did first (created, then
 * updated, then merely mentioned), then PRs before Asana, then first seen.
 * pi-web's panel shows only about five lines before scrolling, so the order
 * decides what is visible at a glance.
 */
export function visible(refs: Map<string, Ref>): Ref[] {
	const kind = { "github-pr": 0, "asana-task": 1, "asana-project": 2 } as const;
	return [...refs.values()]
		.filter((r) => !r.removed)
		.sort((a, b) => ACTION_RANK[b.action] - ACTION_RANK[a.action] || kind[a.kind] - kind[b.kind] || a.firstAt - b.firstAt);
}
