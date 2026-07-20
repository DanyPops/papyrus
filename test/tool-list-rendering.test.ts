import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ArtifactListCard, TaskHierarchyPreview } from "../extension/src/tool-rendering/artifact-list.ts";
import { createArtifactListDetails, createGraphDetails } from "../extension/src/tool-rendering/render-model.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import { TOOL_COLLAPSED_ROW_LIMIT } from "../src/constants.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

function artifact(index: number, status = index % 2 === 0 ? "todo" : "in-progress"): Artifact {
	return {
		id: `task-${index}`,
		kind: "task",
		title: `Task ${index} with enough title text to exercise narrow rendering`,
		status,
		subtype: index === 0 ? "architecture" : "",
		body: "",
		labels: index === 0 ? ["papyrus", "context-mesh"] : [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
}

describe("Papyrus list and hierarchy rendering", () => {
	it("renders a bounded collapsed preview with status counts", () => {
		const rows = Array.from({ length: TOOL_COLLAPSED_ROW_LIMIT + 3 }, (_, index) => artifact(index));
		const card = new ArtifactListCard(createArtifactListDetails("tasks.list", rows), theme, false);
		const output = card.render(80).join("\n");
		expect(output).toContain("8 tasks");
		expect(output).toContain("todo 4");
		expect(output).toContain("in-progress 4");
		expect(output).toContain("3 more");
		expect(output).not.toContain(`task-${TOOL_COLLAPSED_ROW_LIMIT + 2}`);
	});

	it("renders expanded IDs, subtype, and labels without raw JSON", () => {
		const rows = [artifact(0), artifact(1)];
		const card = new ArtifactListCard(createArtifactListDetails("tasks.list", rows), theme, true);
		const output = card.render(80).join("\n");
		expect(output).toContain("task-0");
		expect(output).toContain("architecture · papyrus · context-mesh");
		expect(output).not.toContain('{"');
	});

	it("renders bounded hierarchy connectors at responsive widths", () => {
		const nodes = [artifact(0), artifact(1), artifact(2)];
		const graph = createGraphDetails("tasks.graph", nodes, [
			{ from: "task-0", relation: "contains", to: "task-1" },
			{ from: "task-0", relation: "contains", to: "task-2" },
		]);
		const preview = new TaskHierarchyPreview(graph, theme, true);
		for (const width of [40, 80, 120]) {
			const lines = preview.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.join("\n")).toContain("├─");
			expect(lines.join("\n")).toContain("└─");
		}
	});
});
