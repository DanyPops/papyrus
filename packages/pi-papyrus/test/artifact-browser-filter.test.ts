import { describe, expect, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import { filterArtifactRows } from "../extension/src/artifact/artifact-browser.ts";

/**
 * Regression coverage for a real crash: list operations (docs.list, rules.list,
 * playbooks.list, notes.list, discuss.list) hand back summarizeArtifact() rows with
 * body/extra omitted entirely, and subtype can be blank/absent too -- yet
 * filterArtifactRows is typed against the full Artifact and used to unconditionally
 * call .toLowerCase() on every field. Typing into any artifact browser's filter box
 * threw "Cannot read properties of undefined (reading 'toLowerCase')".
 */
function summaryRow(overrides: Partial<Artifact> = {}): Artifact {
	// Cast mirrors what actually flows through at runtime: an ArtifactSummary (no
	// body/extra) forced through the wider Artifact type the browser config declares.
	return {
		id: "doc-1",
		kind: "doc",
		title: "Runbook",
		status: "draft",
		subtype: "",
		labels: [],
		created_at: "",
		updated_at: "",
		alias: "runbook",
		...overrides,
	} as Artifact;
}

describe("filterArtifactRows", () => {
	it("does not throw when body/extra are missing (summary rows)", () => {
		const rows = [summaryRow()];
		expect(() => filterArtifactRows(rows, "runbook")).not.toThrow();
	});

	it("still matches on fields that are present despite missing body/extra", () => {
		const rows = [summaryRow({ title: "Deploy Runbook" }), summaryRow({ id: "doc-2", title: "Other" })];
		const filtered = filterArtifactRows(rows, "runbook");
		expect(filtered.map((r) => r.id)).toEqual(["doc-1"]);
	});

	it("does not throw when subtype is undefined", () => {
		const rows = [summaryRow({ subtype: undefined as unknown as string })];
		expect(() => filterArtifactRows(rows, "anything")).not.toThrow();
	});

	it("still matches full rows with body/extra populated", () => {
		const rows = [summaryRow({ body: "Contains the word beacon", extra: { key: "value" } })];
		expect(filterArtifactRows(rows, "beacon")).toHaveLength(1);
		expect(filterArtifactRows(rows, "value")).toHaveLength(1);
	});

	it("returns all rows for a blank query", () => {
		const rows = [summaryRow(), summaryRow({ id: "doc-2" })];
		expect(filterArtifactRows(rows, "   ")).toHaveLength(2);
	});
});
