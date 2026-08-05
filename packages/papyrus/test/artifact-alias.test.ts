import { describe, expect, it } from "bun:test";
import { generateUniqueAlias, isValidAlias, slugify } from "../src/domain/artifact-alias.ts";

describe("slugify", () => {
	it("lowercases, hyphenates, and strips punctuation", () => {
		expect(slugify("Migrate Papyrus's ServiceSpec usage")).toBe("migrate-papyruss-servicespec-usage");
	});

	it("collapses repeated separators and trims leading/trailing hyphens", () => {
		expect(slugify("  -- Multiple   spaces & symbols!! --  ")).toBe("multiple-spaces-symbols");
	});

	it("truncates to a bounded length without leaving a trailing hyphen", () => {
		const slug = slugify("a".repeat(40) + " " + "b".repeat(40));
		expect(slug.length).toBeLessThanOrEqual(50);
		expect(slug.endsWith("-")).toBe(false);
	});

	it("falls back to a generic base when the title has no alias-safe (ASCII alphanumeric) characters", () => {
		expect(slugify("日本語 🎉 -- ++")).toBe("artifact");
	});
});

describe("generateUniqueAlias", () => {
	it("returns the bare slug when it is not already taken", () => {
		expect(generateUniqueAlias("fix-timeout", () => false)).toBe("fix-timeout");
	});

	it("appends the lowest available numeric suffix on collision", () => {
		const taken = new Set(["fix-timeout", "fix-timeout-2"]);
		expect(generateUniqueAlias("fix-timeout", (candidate) => taken.has(candidate))).toBe("fix-timeout-3");
	});
});

describe("isValidAlias", () => {
	it("accepts lowercase alphanumeric-and-hyphen strings within the length bound", () => {
		expect(isValidAlias("fix-timeout-2")).toBe(true);
	});

	it("rejects empty, uppercase, leading/trailing hyphen, or over-length aliases", () => {
		expect(isValidAlias("")).toBe(false);
		expect(isValidAlias("Fix-Timeout")).toBe(false);
		expect(isValidAlias("-fix-timeout")).toBe(false);
		expect(isValidAlias("fix-timeout-")).toBe(false);
		expect(isValidAlias("a".repeat(51))).toBe(false);
	});
});
