import { describe, expect, it } from "bun:test";
import type {
	Artifact,
	ArtifactEdge,
	ArtifactGraphOptions,
	ArtifactLink,
	ArtifactQuery,
	CreateArtifactInput,
	RelationshipQuery,
} from "../src/domain/artifact.ts";
import type { GateResult } from "../src/domain/gate.ts";
import type { ArtifactStore } from "../src/ports/artifact-store.ts";
import type { GateRunner } from "../src/ports/gate-runner.ts";
import { Tasks } from "../src/task-service.ts";

class FakeArtifactStore implements ArtifactStore {
	private sequence = 0;
	readonly artifacts = new Map<string, Artifact>();
	readonly edges: ArtifactEdge[] = [];

	create(input: CreateArtifactInput): Artifact {
		const id = input.id ?? `task-${++this.sequence}`;
		const artifact: Artifact = {
			id,
			kind: input.kind ?? "doc",
			title: input.title ?? "Untitled",
			status: input.status ?? (input.kind === "task" ? "pending" : "draft"),
			subtype: input.subtype ?? "",
			body: input.body ?? "",
			labels: input.labels ?? [],
			extra: input.extra ?? {},
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		};
		this.artifacts.set(id, artifact);
		return structuredClone(artifact);
	}

	get(id: string, options?: ArtifactGraphOptions): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		return {
			...structuredClone(artifact),
			...(options?.tree ? { edges: this.edges.filter((edge) => edge.from === id || edge.to === id) } : {}),
		};
	}

	query(filter: ArtifactQuery): Artifact[] {
		return [...this.artifacts.values()]
			.filter((artifact) => !filter.kind || artifact.kind === filter.kind)
			.filter((artifact) => !filter.status || artifact.status === filter.status)
			.map((artifact) => structuredClone(artifact));
	}

	link(link: ArtifactLink): void {
		if (!this.edges.some((edge) => edge.from === link.from && edge.relation === link.relation && edge.to === link.to)) {
			this.edges.push({ ...link });
		}
	}

	setStatus(id: string, status: string): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		artifact.status = status;
		return structuredClone(artifact);
	}

	setExtra(id: string, extra: Record<string, unknown>): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		artifact.extra = structuredClone(extra);
		return structuredClone(artifact);
	}

	relationships(filter: RelationshipQuery = {}): ArtifactEdge[] {
		const ids = filter.artifactIds ? new Set(filter.artifactIds) : undefined;
		return this.edges.filter((edge) => !ids || ids.has(edge.from) || ids.has(edge.to)).map((edge) => ({ ...edge }));
	}
}

class FakeGateRunner implements GateRunner {
	results: GateResult[] = [];
	run(): GateResult[] { return structuredClone(this.results); }
	async runAsync(): Promise<GateResult[]> { return this.run(); }
}

describe("Tasks port behavior", () => {
	it("builds task composition through the ArtifactStore port without SQLite", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		const epic = tasks.create({ title: "Epic" });
		const dependency = tasks.create({ title: "Dependency" });
		const child = tasks.create({ title: "Child", parentId: epic.id, dependsOn: [dependency.id] });

		const graph = tasks.graph();
		expect(graph.nodes.find((node) => node.task.id === epic.id)?.childIds).toEqual([child.id]);
		expect(graph.nodes.find((node) => node.task.id === child.id)?.dependencyIds).toEqual([dependency.id]);
	});

	it("requires every checklist item to carry an evidence reference", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const created = tasks.create({
			title: "Evidence-bearing task",
			checklist: {
				"Write failing tests": { proof: [{ type: "test", target: "test/task-service.test.ts", expect: "proof requirement" }] },
				"Implement service": { proof: [{ type: "symbol", target: "src/task-service.ts#Tasks.create" }] },
			},
		});

		expect(created.extra["checklist"]).toEqual({
			"Write failing tests": { proof: [{ type: "test", target: "test/task-service.test.ts", expect: "proof requirement" }] },
			"Implement service": { proof: [{ type: "symbol", target: "src/task-service.ts#Tasks.create" }] },
		});
		expect(() => tasks.create({ title: "Legacy", checklist: ["No proof"] as unknown as never })).toThrow("item-to-proof map");
		expect(() => tasks.create({
			title: "Missing target",
			checklist: { "Implement it": { proof: [{ type: "symbol", target: "" }] } },
		})).toThrow("non-empty proof target");
	});

	it("replaces a checklist without overwriting gates or other task metadata", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const created = tasks.create({
			title: "Update checklist",
			extra: { owner: "agent" },
			gates: [{ type: "command", target: "bun test" }],
		});
		const checklist = {
			"Write tests": { proof: [{ type: "test" as const, target: "test/task-service.test.ts" }] },
		};

		const updated = tasks.setChecklist(created.id, checklist);

		expect(updated.extra).toEqual({
			owner: "agent",
			gates: [{ type: "command", target: "bun test" }],
			checklist,
		});
	});

	it("keeps a task active when the injected gate runner reports failure", () => {
		const artifacts = new FakeArtifactStore();
		const gates = new FakeGateRunner();
		gates.results = [{ gate: { type: "command", target: "test" }, passed: false, output: "failed" }];
		const tasks = new Tasks(artifacts, gates);
		const task = tasks.create({ title: "Gated" });
		tasks.transition(task.id, "start");

		expect(tasks.complete(task.id).completed).toBe(false);
		expect(tasks.show(task.id).status).toBe("active");
	});
});
