// Escapes only in this file: literal invisible characters would be stripped by
// this very extension when the file is written through pi.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cleanInvisibleUnicode } from "./unicode.ts";

const clean = (s: string, o = {}) => cleanInvisibleUnicode(s, o);

describe("cleanInvisibleUnicode: no-ops", () => {
	test("plain ASCII is returned untouched", () => {
		const r = clean("Hello, world.\n\tIndented `code` here.");
		assert.equal(r.text, "Hello, world.\n\tIndented `code` here.");
		assert.equal(r.removed + r.replaced, 0);
	});

	test("ordinary non-ASCII (accents, CJK, em dash, emoji) is untouched", () => {
		const s = "Caf\u00e9 \u4e2d\u6587 \u2014 \ud83d\ude80";
		assert.equal(clean(s).text, s);
		assert.equal(clean(s).removed, 0);
	});
});

describe("cleanInvisibleUnicode: strips carriers", () => {
	test("zero-width space / joiner / word joiner / BOM between Latin letters", () => {
		const r = clean("wa\u200Bter\u200Dmark\u2060ed\uFEFF");
		assert.equal(r.text, "watermarked");
		assert.equal(r.removed, 4);
		assert.equal(r.kinds.zero_width, 4);
	});

	test("ZWNJ between Latin letters is stripped (only orthographic in joining scripts)", () => {
		assert.equal(clean("a\u200Cb").text, "ab");
	});

	test("tag characters outside a flag sequence (ASCII smuggling)", () => {
		// "hi" encoded as tag chars appended to ordinary text
		const r = clean("ok\u{E0068}\u{E0069}\u{E007F}");
		assert.equal(r.text, "ok");
		assert.equal(r.kinds.tag_chars, 3);
	});

	test("free-floating variation selectors, including the supplement", () => {
		const r = clean("a\uFE0Fb\u{E0100}c");
		assert.equal(r.text, "abc");
		assert.equal(r.kinds.variation_selector, 2);
	});

	test("bidi overrides and unpaired embeddings", () => {
		const r = clean("x\u202Eevil\u202Cy \u202Az");
		assert.equal(r.text, "xevily z");
		assert.equal(r.kinds.bidi, 3);
	});

	test("soft hyphen and invisible math operators", () => {
		assert.equal(clean("co\u00ADop a\u2062b").text, "coop ab");
	});

	test("noncharacters and reserved default-ignorables", () => {
		const r = clean("a\uFDD0b\uFFFEc\u2065d");
		assert.equal(r.text, "abcd");
		assert.equal(r.kinds.noncharacter, 2);
		assert.equal(r.kinds.reserved_ignorable, 1);
	});

	test("private use stripped by default, kept with stripPrivateUse: false", () => {
		assert.equal(clean("a\uE0A0b").text, "ab");
		assert.equal(clean("a\uE0A0b", { stripPrivateUse: false }).text, "a\uE0A0b");
	});

	test("other Cf controls fall through to the generic format rule", () => {
		// Egyptian hieroglyph format control floating between Latin letters
		const r = clean("x\u{13430}y");
		assert.equal(r.text, "xy");
		assert.equal(r.kinds.format, 1);
	});

	test("layout format control next to its own script is kept", () => {
		const s = "\u{13000}\u{13430}\u{13001}";
		assert.equal(clean(s).text, s);
	});
});

describe("cleanInvisibleUnicode: space homoglyphs", () => {
	test("NBSP, NNBSP, thin, em, ideographic spaces become U+0020", () => {
		const r = clean("a\u00A0b\u202Fc\u2009d\u2003e\u3000f");
		assert.equal(r.text, "a b c d e f");
		assert.equal(r.replaced, 5);
		assert.equal(r.kinds.space, 5);
	});

	test("normalizeSpaces: false keeps them", () => {
		assert.equal(clean("a\u00A0b", { normalizeSpaces: false }).text, "a\u00A0b");
	});
});

describe("cleanInvisibleUnicode: preserves load-bearing invisibles", () => {
	test("emoji ZWJ sequence (family) survives", () => {
		const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
		assert.equal(clean(family).text, family);
	});

	test("VS16 after an emoji base survives (heart, scales, keycap)", () => {
		for (const s of ["\u2764\uFE0F", "\u2696\uFE0F", "1\uFE0F\u20E3"]) {
			assert.equal(clean(s).text, s, s);
		}
	});

	test("heart on fire (VS16 + ZWJ chain) survives", () => {
		const s = "\u2764\uFE0F\u200D\u{1F525}";
		assert.equal(clean(s).text, s);
	});

	test("subdivision flag (England) tag sequence survives", () => {
		const eng = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
		assert.equal(clean(eng).text, eng);
	});

	test("Persian ZWNJ between Arabic-script letters survives", () => {
		const s = "\u0645\u06CC\u200C\u0631\u0648\u0645";
		assert.equal(clean(s).text, s);
	});

	test("Devanagari ZWJ survives", () => {
		const s = "\u0915\u094D\u200D\u0937";
		assert.equal(clean(s).text, s);
	});

	test("LRM/RLM and isolates survive; paired LRE...PDF survives", () => {
		const s = "abc \u200F\u05E9\u05DC\u05D5\u05DD\u200E \u2067x\u2069 \u202Ay\u202C";
		assert.equal(clean(s).text, s);
	});

	test("CJK ideographic variation selector survives", () => {
		const s = "\u845B\u{E0100}";
		assert.equal(clean(s).text, s);
	});

	test("Arabic number sign (orthographic Cf) survives", () => {
		const s = "\u0600\u0661\u0662";
		assert.equal(clean(s).text, s);
	});

	test("carrier next to a preserved sequence is still stripped", () => {
		const family = "\u{1F468}\u200D\u{1F469}";
		assert.equal(clean(`${family}\u200B!`).text, `${family}!`);
	});
});

describe("cleanInvisibleUnicode: properties", () => {
	test("idempotent", () => {
		const once = clean("a\u200Bb\u00A0c\u202Ed\u{E0041}");
		const twice = clean(once.text);
		assert.equal(twice.text, once.text);
		assert.equal(twice.removed + twice.replaced, 0);
	});

	test("surrogate pairs are never split", () => {
		const s = "\u{1F600}\u200B\u{1F601}";
		assert.equal(clean(s).text, "\u{1F600}\u{1F601}");
	});
});
