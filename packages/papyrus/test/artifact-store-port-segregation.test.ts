import { describe, expect, it } from "bun:test";
import type {
	Artifact,
	ArtifactEdge,
	ArtifactLink,
	ArtifactQuery,
	CreateArtifactInput,
	RelationshipQuery,
	UpdateArtifactInput,
} from "../src/artifact/artifact.ts";
import type { ArtifactStore } from "../src/artifact/artifact-store.ts";
import { Notes } from "../src/note/note-service.ts";

/**
 * Minimal in-memory fake implementing ONLY the narrow ArtifactStore -- deliberately no
 * trash/restore/trashStatus/listTrash/purgeDueTrash/events. If ArtifactStore still required
 * those (the pre-split shape), this class would fail to satisfy the type and this file
 * wouldn't compile -- that's the actual proof the split changed something real, not just
 * documentation splitting an interface that was never enforced.
 */
class InMemoryArtifactStore implements ArtifactStore {
	private readonly rows = new Map<string, Artifact>();
	private counter = 0;

	create(input: CreateArtifactInput): Artifact {
		const id = input.id ?? `fake-${++this.counter}`;
		const artifact: Artifact = {
			id,
			kind: input.kind ?? "doc",
			title: input.title ?? "",
			status: input.status ?? "draft",
			subtype: input.subtype ?? "",
			body: input.body ?? "",
			labels: input.labels ?? [],
			extra: input.extra ?? {},
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			alias: input.alias ?? id,
		};
		this.rows.set(id, artifact);
		return artifact;
	}
	get(id: string): Artifact | null {
		return this.rows.get(id) ?? null;
	}
	getByAlias(alias: string): Artifact | null {
		return [...this.rows.values()].find((candidate) => candidate.alias === alias) ?? null;
	}
	query(filter: ArtifactQuery): Artifact[] {
		return [...this.rows.values()].filter(
			(row) =>
				(!filter.kind || row.kind === filter.kind) &&
				(!filter.subtype || row.subtype === filter.subtype) &&
				(!filter.extraEquals || Object.entries(filter.extraEquals).every(([key, value]) => row.extra[key] === value)),
		);
	}
	link(_link: ArtifactLink): void {}
	unlink(_link: ArtifactLink): boolean {
		return false;
	}
	setStatus(id: string, status: string): Artifact | null {
		const row = this.rows.get(id);
		if (!row) return null;
		row.status = status;
		return row;
	}
	setExtra(id: string, extra: Record<string, unknown>): Artifact | null {
		const row = this.rows.get(id);
		if (!row) return null;
		row.extra = extra;
		return row;
	}
	updateContent(id: string, input: UpdateArtifactInput): Artifact | null {
		const row = this.rows.get(id);
		if (!row) return null;
		if (input.title !== undefined) row.title = input.title;
		if (input.body !== undefined) row.body = input.body;
		if (input.labels !== undefined) row.labels = input.labels;
		return row;
	}
	relationships(_filter?: RelationshipQuery): ArtifactEdge[] {
		return [];
	}
}

describe("ArtifactStore port segregation: a domain service works against the narrow store alone", () => {
	it("Notes.capture/list work against a fake with no trash/event methods at all", () => {
		const artifacts = new InMemoryArtifactStore();
		const notes = new Notes(artifacts);
		notes.capture({ body: "remember to check the widget", projectRoot: "/workspace/papyrus" });
		const found = notes.list({ projectRoot: "/workspace/papyrus" });
		expect(found).toHaveLength(1);
		expect(found[0]?.body).toBe("remember to check the widget");
	});
});
