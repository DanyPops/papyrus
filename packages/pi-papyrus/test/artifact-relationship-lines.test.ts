import { describe, expect, it } from "bun:test";
import type { Artifact, DisplayGraph, GraphRenderer, RenderedGraph } from "@danypops/papyrus";
import { buildArtifactRelationshipLines } from "../extension/src/artifact-relationship-lines.ts";

function doc(id: string, title: string, overrides: Partial<Artifact> = {}): Artifact {
	return {
		id,
		kind: "doc",
		title,
		status: "active",
		subtype: "",
		body: "",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		alias: id,
		...overrides,
	};
}

class FakeRenderer implements GraphRenderer {
	calls: DisplayGraph[] = [];
	constructor(private readonly result: RenderedGraph = { lines: ["┌─┐", "│x│", "└─┘"] }) {}
	render(graph: DisplayGraph): RenderedGraph {
		this.calls.push(graph);
		return this.result;
	}
}

describe("buildArtifactRelationshipLines", () => {
	it("returns no lines for an artifact with no edges, without ever calling the renderer", () => {
		const renderer = new FakeRenderer();
		expect(buildArtifactRelationshipLines(doc("a", "A"), renderer)).toEqual([]);
		expect(renderer.calls).toHaveLength(0);
	});

	it("renders a real graph within bounds, delegating to the injected GraphRenderer", () => {
		const artifact = doc("a", "A", { edges: [{ from: "a", relation: "references", to: "b" }] });
		const renderer = new FakeRenderer({ lines: ["┌───┐   ┌───┐", "│ A │──▶│ b │", "└───┘   └───┘"] });
		const lines = buildArtifactRelationshipLines(artifact, renderer);
		expect(lines).toEqual(["┌───┐   ┌───┐", "│ A │──▶│ b │", "└───┘   └───┘"]);
		expect(renderer.calls).toHaveLength(1);
	});

	it("falls back to a readable plain arrow list (real labels, not raw ids) above the bounded-fallback thresholds, reusing the existing GRAPH_RENDER bound rather than inventing a new one", () => {
		const edges = Array.from({ length: 100 }, (_, index) => ({ from: "a", relation: "references", to: `node-abc${index}` }));
		const artifact = doc("a", "A", { edges });
		const renderer = new FakeRenderer();
		const lines = buildArtifactRelationshipLines(artifact, renderer);
		expect(renderer.calls).toHaveLength(0);
		expect(lines).toHaveLength(100);
		expect(lines[0]).toBe("A --references--> node");
	});

	it("falls back to the plain arrow list for a degenerate single-node graph (a self-referential edge)", () => {
		const artifact = doc("a", "A", { edges: [{ from: "a", relation: "relates_to", to: "a" }] });
		const renderer = new FakeRenderer();
		const lines = buildArtifactRelationshipLines(artifact, renderer);
		expect(renderer.calls).toHaveLength(0);
		expect(lines).toEqual(["A --relates_to--> A"]);
	});

	it("falls back to the plain arrow list if the renderer itself produces no lines", () => {
		const artifact = doc("a", "A", { edges: [{ from: "a", relation: "references", to: "b" }] });
		const renderer = new FakeRenderer({ lines: [] });
		expect(buildArtifactRelationshipLines(artifact, renderer)).toEqual(["A --references--> b"]);
	});
});
