import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/example-project";
const PERMS = { permissions: ["notes:read", "notes:write"] };

function harness() {
	const directory = tempDir("papyrus-notes-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("createNotesVehicleRegistry (wired through createPapyrusService)", () => {
	it("registers exactly one honest VehicleOperation per real notes.* action, never an action-dispatch schema", () => {
		const { registry, service } = harness();
		const manifest = registry.manifest();
		const names = manifest.operations
			.map((op: VehicleManifestOperation) => op.name)
			.filter((name: string) => name.startsWith("notes."))
			.sort();
		expect(names).toEqual([
			"notes.archive",
			"notes.capture",
			"notes.consume",
			"notes.history",
			"notes.list",
			"notes.list_page",
			"notes.promote",
			"notes.show",
		]);
		// No operation's own schema is itself an action-dispatch blob -- confirms the
		// "God Parameters" shape audited against pi-papyrus's other domain tools
		// doesn't recur one level down inside a single operation's own input.
		for (const op of manifest.operations) {
			const properties = (op.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
			expect(Object.keys(properties)).not.toContain("action");
		}
		service.close();
	});

	it("gives each action its own honest effect -- reads are 'read', mutations are 'local-write'", () => {
		const { registry, service } = harness();
		const effectOf = (name: string) => registry.manifest().operations.find((op) => op.name === name)?.effect;
		expect(effectOf("notes.list")).toBe("read");
		expect(effectOf("notes.list_page")).toBe("read");
		expect(effectOf("notes.show")).toBe("read");
		expect(effectOf("notes.history")).toBe("read");
		expect(effectOf("notes.capture")).toBe("local-write");
		expect(effectOf("notes.consume")).toBe("local-write");
		expect(effectOf("notes.promote")).toBe("local-write");
		expect(effectOf("notes.archive")).toBe("local-write");
		service.close();
	});

	it("denies a call with no permissions granted, even for a read -- secure by default, not just documentation", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("notes.list", 1, { project_root: PROJECT })).rejects.toThrow(/requires permissions/);
		service.close();
	});

	it("capture creates a note and list finds it by project", async () => {
		const { registry, service } = harness();
		const captured = (await registry.invoke("notes.capture", 1, { body: "call the vet", project_root: PROJECT }, PERMS)) as {
			id: string;
			title: string;
		};
		expect(captured.title).toBe("call the vet");

		const rows = (await registry.invoke("notes.list", 1, { project_root: PROJECT }, PERMS)) as Array<{ id: string }>;
		expect(rows.map((row) => row.id)).toContain(captured.id);
		service.close();
	});

	it("list_page enumerates Notes across projects with a bounded cursor", async () => {
		const { registry, service } = harness();
		const expected = new Set<string>();
		for (let index = 0; index < 5; index++) {
			const note = (await registry.invoke(
				"notes.capture",
				1,
				{ body: `note ${index}`, project_root: index % 2 === 0 ? PROJECT : "/tmp/other-project" },
				PERMS,
			)) as { id: string };
			expected.add(note.id);
		}
		const seen = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = (await registry.invoke("notes.list_page", 1, { limit: 2, ...(cursor ? { cursor } : {}) }, PERMS)) as {
				items: Array<{ id: string }>;
				nextCursor?: string;
			};
			for (const note of page.items) seen.add(note.id);
			cursor = page.nextCursor;
		} while (cursor);
		expect(seen).toEqual(expected);
		service.close();
	});

	it("show resolves a note by name, exactly like the id path, without a separate round trip", async () => {
		const { registry, service } = harness();
		const captured = (await registry.invoke("notes.capture", 1, { body: "renew the domain", project_root: PROJECT }, PERMS)) as {
			id: string;
			title: string;
		};

		const byId = await registry.invoke("notes.show", 1, { id: captured.id, project_root: PROJECT }, PERMS);
		const byName = await registry.invoke("notes.show", 1, { name: captured.title, project_root: PROJECT }, PERMS);

		expect(byName).toEqual(byId);
		service.close();
	});

	it("show by an unknown name fails clearly instead of resolving to nothing -- a real VehicleError, not the opaque generic handler-failed wrap", async () => {
		const { registry, service } = harness();
		try {
			await registry.invoke("notes.show", 1, { name: "does not exist", project_root: PROJECT }, PERMS);
			throw new Error("expected invoke to reject");
		} catch (error) {
			expect((error as { code?: string }).code).toBe("artifact-not-found");
			expect((error as { category?: string }).category).toBe("not_found");
			expect((error as Error).message).toMatch(/no artifact named/);
		}
		service.close();
	});

	it("consume transitions a note from draft to active, and is a no-op the second time", async () => {
		const { registry, service } = harness();
		const captured = (await registry.invoke("notes.capture", 1, { body: "read the RFC", project_root: PROJECT }, PERMS)) as { id: string };

		const consumed = (await registry.invoke("notes.consume", 1, { id: captured.id, project_root: PROJECT }, PERMS)) as { status: string };
		expect(consumed.status).toBe("active");

		const consumedAgain = (await registry.invoke("notes.consume", 1, { id: captured.id, project_root: PROJECT }, PERMS)) as {
			status: string;
		};
		expect(consumedAgain.status).toBe("active");
		service.close();
	});

	it("archive's schema rejects an invalid disposition before the domain logic ever runs", async () => {
		const { registry, service } = harness();
		const captured = (await registry.invoke("notes.capture", 1, { body: "stale idea", project_root: PROJECT }, PERMS)) as { id: string };

		await expect(
			registry.invoke("notes.archive", 1, { id: captured.id, project_root: PROJECT, disposition: "not-a-real-disposition" }, PERMS),
		).rejects.toThrow();

		const archived = (await registry.invoke(
			"notes.archive",
			1,
			{ id: captured.id, project_root: PROJECT, disposition: "declined" },
			PERMS,
		)) as { status: string };
		expect(archived.status).toBe("archived");
		service.close();
	});

	it("promote resolves both the note and its cross-kind target by name in one call", async () => {
		const { registry, service } = harness();
		const captured = (await registry.invoke("notes.capture", 1, { body: "build the widget", project_root: PROJECT }, PERMS)) as {
			id: string;
			title: string;
		};
		// Deliberately a distinct title from the note's own -- matchArtifactByName's
		// cross-kind lookup is case-insensitive-exact and searches across every kind,
		// so a target sharing the note's own name (even by case) would collide with
		// the note this test just captured, exactly the "ambiguous, refuse to guess"
		// case another test already covers on purpose -- not what this test is about.
		// subtype must not be NOTE_SUBTYPE -- docs.create for a note-shaped artifact is
		// rejected by the notes AuthorityClaim ("note creation requires notes.capture").
		const target = (await service.execute("docs.create", { title: "Widget project plan", subtype: "research" })) as {
			id: string;
			title: string;
		};

		const promoted = (await registry.invoke(
			"notes.promote",
			1,
			{ name: captured.title, target_name: target.title, project_root: PROJECT },
			PERMS,
		)) as {
			status: string;
		};

		expect(promoted.status).toBe("archived");
		service.close();
	});

	it("history returns this note's own real event log, most recent first", async () => {
		const { registry, service } = harness();
		const captured = (await registry.invoke("notes.capture", 1, { body: "ping the team", project_root: PROJECT }, PERMS)) as { id: string };
		await registry.invoke("notes.consume", 1, { id: captured.id, project_root: PROJECT }, PERMS);

		const page = (await registry.invoke("notes.history", 1, { id: captured.id, project_root: PROJECT }, PERMS)) as {
			events: Array<{ type: string }>;
		};

		expect(page.events.map((event) => event.type)).toEqual(["consumed", "captured"]);
		service.close();
	});
});
