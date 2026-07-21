import { describe, expect, it } from "bun:test";
import { OperationRegistry } from "../src/module-registry.ts";
import { notesOperations, NOTES_OPERATION_NAMES } from "../src/modules/notes.ts";
import { Notes } from "../src/note-service.ts";
import type { ArtifactStore } from "../src/ports/artifact-store.ts";
import type { Artifact, ArtifactLink, ArtifactQuery, CreateArtifactInput, UpdateArtifactInput } from "../src/domain/artifact.ts";

const PROJECT_ROOT = "/workspace/papyrus";

class FakeArtifactStore implements ArtifactStore {
	private sequence = 0;
	readonly artifacts = new Map<string, Artifact>();

	create(input: CreateArtifactInput): Artifact {
		const id = input.id ?? `note-${++this.sequence}`;
		const artifact: Artifact = {
			id, kind: input.kind ?? "doc", title: input.title ?? "Untitled", status: input.status ?? "draft",
			subtype: input.subtype ?? "", body: input.body ?? "", labels: input.labels ?? [], extra: input.extra ?? {},
			created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		};
		this.artifacts.set(id, artifact);
		return structuredClone(artifact);
	}
	get(id: string): Artifact | null { const artifact = this.artifacts.get(id); return artifact ? structuredClone(artifact) : null; }
	query(filter: ArtifactQuery): Artifact[] {
		return [...this.artifacts.values()]
			.filter((a) => (!filter.kind || a.kind === filter.kind) && (!filter.subtype || a.subtype === filter.subtype))
			.map((a) => structuredClone(a));
	}
	link(_link: ArtifactLink): void {}
	unlink(): boolean { return false; }
	atomic<T>(operation: () => T): T { return operation(); }
	setStatus(id: string, status: string): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		artifact.status = status;
		return structuredClone(artifact);
	}
	setExtra(id: string, extra: Record<string, unknown>): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		artifact.extra = extra;
		return structuredClone(artifact);
	}
	updateContent(id: string, input: UpdateArtifactInput): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		if (input.title !== undefined) artifact.title = input.title;
		if (input.body !== undefined) artifact.body = input.body;
		return structuredClone(artifact);
	}
	relationships() { return []; }
	events() { return { events: [] }; }
}

describe("modules/notes — the first Papyrus-native registered module", () => {
	it("registers exactly the notes.* operations EXPECTED_OPERATION_NAMES declares, no more, no fewer", () => {
		const registry = new OperationRegistry();
		registry.registerAll(notesOperations(new Notes(new FakeArtifactStore())));
		expect(registry.list()).toEqual([...NOTES_OPERATION_NAMES].sort());
	});

	it("each registered operation is owned by the notes module", () => {
		const registry = new OperationRegistry();
		registry.registerAll(notesOperations(new Notes(new FakeArtifactStore())));
		for (const name of registry.list()) {
			expect(registry.get(name)?.moduleId).toBe("notes");
		}
	});

	it("delegates to the real Notes instance with the same field mapping as the prior inline handler", async () => {
		const registry = new OperationRegistry();
		const notes = new Notes(new FakeArtifactStore());
		registry.registerAll(notesOperations(notes));

		const captured = await registry.get("notes.capture")!.execute({ body: "deferred idea", title: "Title", project_root: PROJECT_ROOT }) as { id: string; status: string };
		expect(captured.status).toBe("draft");

		const listed = await registry.get("notes.list")!.execute({ project_root: PROJECT_ROOT }) as Array<{ id: string }>;
		expect(listed.map((n) => n.id)).toContain(captured.id);

		const shown = await registry.get("notes.show")!.execute({ id: captured.id, project_root: PROJECT_ROOT }) as { id: string };
		expect(shown.id).toBe(captured.id);

		const consumed = await registry.get("notes.consume")!.execute({ id: captured.id, project_root: PROJECT_ROOT }) as { status: string };
		expect(consumed.status).toBe("active");
	});

	it("rejects a request missing a required field, matching the prior inline handler's validation", () => {
		const registry = new OperationRegistry();
		registry.registerAll(notesOperations(new Notes(new FakeArtifactStore())));
		expect(() => registry.get("notes.capture")!.execute({ project_root: PROJECT_ROOT })).toThrow("body is required");
	});
});
