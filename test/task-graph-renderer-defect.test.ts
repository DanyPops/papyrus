import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { BeautifulMermaidRenderer } from "../extension/src/beautiful-mermaid-renderer.ts";
import { TaskGraphViewport } from "../extension/src/task-graph.ts";
import type { GraphRenderer } from "../src/ports/graph-renderer.ts";
import type { TaskGraph } from "../src/task-service.ts";

const graph: TaskGraph = {
	nodes: [{
		task: {
			id: "task", kind: "task", title: "Task", status: "todo", subtype: "", body: "", labels: [], extra: {},
			created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		},
		active: true,
		parentIds: [],
		childIds: [],
		dependencyIds: [],
	}],
	rootIds: ["task"],
};

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

class RendererThatFailsOnTab implements GraphRenderer {
	private calls = 0;
	render() {
		this.calls += 1;
		if (this.calls > 1) throw new RangeError("Map maximum size exceeded");
		return { lines: ["┌────┐", "│Task│", "└────┘"] };
	}
}

describe("task graph renderer defect containment", () => {
	it("bypasses routed rendering for the reproduced 55-node dependency topology", () => {
		const nodes = Array.from({ length: 55 }, (_, index) => ({ id: `n${index}`, label: `Task ${index}` }));
		const edges = Array.from({ length: 54 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}`, label: "unlocks" }));

		const rendered = new BeautifulMermaidRenderer().render({ direction: "TD", nodes, edges });

		expect(rendered.lines.join("\n")).toContain("routed layout skipped");
		expect(rendered.lines.some((line) => line.includes("─unlocks─→"))).toBe(true);
		expect(rendered.lines.length).toBeLessThanOrEqual(200);
	});

	it("contains a beautiful-mermaid-style failure while switching views", () => {
		const viewport = new TaskGraphViewport(
			{ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
			theme,
			graph,
			new RendererThatFailsOnTab(),
			() => {},
		);

		expect(() => viewport.handleInput("\t")).not.toThrow();
		const lines = viewport.render(40);
		expect(lines.join("\n")).toContain("Graph rendering failed");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});
});
