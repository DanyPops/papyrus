import { describe, expect, it } from "bun:test";
import { formatMetadata } from "../extension/src/artifact-format.ts";

describe("nested artifact metadata formatter", () => {
	it("renders nested checklists with status glyphs", () => {
		const lines = formatMetadata({
			checklist: [
				"Write failing tests",
				{
					title: "Implement browser",
					status: "done",
					children: [{ title: "Wire command", status: "pending" }],
				},
			],
		});

		expect(lines).toContain("checklist:");
		expect(lines).toContain("  - Write failing tests");
		expect(lines).toContain("  - ■ Implement browser");
		expect(lines).toContain("    children:");
		expect(lines).toContain("      - ○ Wire command");
	});

	it("renders template defaults and truncates at a configured depth", () => {
		const lines = formatMetadata({
			targetKind: "task",
			defaults: { extra: { policy: { nested: "hidden" } } },
		}, { maxDepth: 2 });

		expect(lines).toContain("targetKind: task");
		expect(lines).toContain("defaults:");
		expect(lines).toContain("  extra:");
		expect(lines).toContain("    …");
		expect(lines).not.toContain("hidden");
	});
});
