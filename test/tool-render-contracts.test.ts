import { describe, expect, it } from "bun:test";
import {
	createArtifactDetails,
	createArtifactListDetails,
	createErrorDetails,
	createGateRunDetails,
	createGraphDetails,
	createInvocationDetails,
	createModelContent,
	createPreviewDetails,
	createTransitionDetails,
	parsePapyrusToolDetails,
} from "../extension/src/tool-rendering/render-model.ts";
import {
	TOOL_DETAILS_BODY_MAX_CHARACTERS,
	TOOL_DETAILS_MAX_EDGES,
	TOOL_DETAILS_MAX_ITEMS,
	TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS,
	TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS,
	TOOL_MODEL_CONTENT_MAX_CHARACTERS,
} from "../src/constants.ts";
import type { Artifact } from "../src/domain/artifact.ts";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "task-1",
		kind: "task",
		title: "Build the context mesh",
		status: "todo",
		subtype: "",
		body: "Keep every context-bearing identity linked.",
		labels: ["papyrus"],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("Papyrus tool render contracts", () => {
	it("creates every discriminated presentation outcome", () => {
		const outcomes = [
			createArtifactDetails("tasks.show", artifact()),
			createArtifactListDetails("tasks.list", [artifact()], 1),
			createTransitionDetails("tasks.start", artifact({ status: "in-progress" }), "todo", "in-progress"),
			createGraphDetails("tasks.graph", [artifact()], [{ from: "task-1", relation: "depends_on", to: "task-2" }]),
			createGateRunDetails("tasks.run_gates", "task-1", "Ship the feature", [{ passed: true, type: "command", target: "bun test", output: "ok" }]),
			createInvocationDetails("skills.run", "run-1", { tasks: ["task-1"], docs: [], rules: [], roots: ["task-1"] }),
			createPreviewDetails("rules.preview", "Rule preview", "Use the typed boundary."),
			createErrorDetails("tasks.show", "NOT_FOUND", "Task was not found."),
		];

		expect(outcomes.map((outcome) => outcome.kind)).toEqual([
			"artifact",
			"artifact-list",
			"transition",
			"graph",
			"gate-run",
			"invocation",
			"preview",
			"error",
		]);
		for (const outcome of outcomes) {
			expect(outcome.schemaVersion).toBe("papyrus.tool-details/v1");
			expect(parsePapyrusToolDetails(JSON.parse(JSON.stringify(outcome)))).toEqual(outcome);
		}
	});

	it("bounds artifact bodies, lists, graph edges, and model content independently", () => {
		const longBody = "b".repeat(TOOL_DETAILS_BODY_MAX_CHARACTERS + 50);
		const artifactDetails = createArtifactDetails("tasks.show", artifact({ body: longBody }));
		expect(artifactDetails.artifact.body).toHaveLength(TOOL_DETAILS_BODY_MAX_CHARACTERS);
		expect(artifactDetails.completeness).toEqual({ truncated: true, omitted: 50 });

		const rows = Array.from({ length: TOOL_DETAILS_MAX_ITEMS + 3 }, (_, index) => artifact({ id: `task-${index}` }));
		const list = createArtifactListDetails("tasks.list", rows, rows.length);
		expect(list.rows).toHaveLength(TOOL_DETAILS_MAX_ITEMS);
		expect(list.completeness).toEqual({ truncated: true, omitted: 3 });

		const edges = Array.from({ length: TOOL_DETAILS_MAX_EDGES + 2 }, (_, index) => ({
			from: `task-${index}`,
			relation: "depends_on",
			to: `task-${index + 1}`,
		}));
		const graph = createGraphDetails("tasks.graph", rows, edges);
		expect(graph.edges).toHaveLength(TOOL_DETAILS_MAX_EDGES);
		expect(graph.edgeCompleteness).toEqual({ truncated: true, omitted: 2 });

		const gateRun = createGateRunDetails("tasks.run_gates", "task-1", "Ship the feature", [{
			passed: false,
			type: "command",
			target: "bun test",
			output: "o".repeat(TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS + 10),
		}]);
		expect(gateRun.gates[0]?.output).toHaveLength(TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS);

		const content = createModelContent("x".repeat(TOOL_MODEL_CONTENT_MAX_CHARACTERS + 20));
		expect(content.text.length).toBeLessThanOrEqual(TOOL_MODEL_CONTENT_MAX_CHARACTERS);
		expect(content.truncated).toBe(true);
		expect(content.text).toContain(`[truncated ${content.omitted} characters]`);
	});

	it("rejects malformed, unknown, and oversized persisted details", () => {
		expect(parsePapyrusToolDetails(null)).toBeUndefined();
		expect(parsePapyrusToolDetails({ schemaVersion: "papyrus.tool-details/v2", kind: "artifact" })).toBeUndefined();
		expect(parsePapyrusToolDetails({ schemaVersion: "papyrus.tool-details/v1", kind: "surprise" })).toBeUndefined();
		expect(parsePapyrusToolDetails({
			schemaVersion: "papyrus.tool-details/v1",
			kind: "preview",
			operation: "rules.preview",
			title: "Preview",
			content: "x".repeat(TOOL_DETAILS_BODY_MAX_CHARACTERS + 1),
			completeness: { truncated: false, omitted: 0 },
		})).toBeUndefined();

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(parsePapyrusToolDetails(cyclic)).toBeUndefined();

		const oversized = createPreviewDetails("rules.preview", "Preview", "bounded");
		expect(parsePapyrusToolDetails({
			...oversized,
			unexpected: "x".repeat(TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS),
		})).toBeUndefined();
	});
});
