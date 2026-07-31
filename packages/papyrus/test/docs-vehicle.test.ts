import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/example-project";
const PERMS = { permissions: ["docs:read", "docs:write", "artifact:read", "artifact:write"] };

function harness() {
	const directory = tempDir("papyrus-docs-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("registerDocsVehicleOperations (wired through createPapyrusService)", () => {
	it("registers exactly one honest VehicleOperation per real docs.* action, never an action-dispatch schema", () => {
		const { registry, service } = harness();
		const names = registry.manifest().operations.map((op: VehicleManifestOperation) => op.name).filter((name: string) => name.startsWith("docs.")).sort();
		expect(names).toEqual(["docs.activate", "docs.archive", "docs.assign_project", "docs.create", "docs.link", "docs.list", "docs.reopen", "docs.show", "docs.update"]);
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("docs.list", 1, {})).rejects.toThrow(/requires permissions/);
		service.close();
	});

	it("creates a doc (draft by default) and lists it by project", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("docs.create", 1, { title: "Architecture overview", project_root: PROJECT }, PERMS)) as { id: string; title: string; status: string };
		expect(created.title).toBe("Architecture overview");
		expect(created.status).toBe("draft");

		const rows = (await registry.invoke("docs.list", 1, { project_root: PROJECT }, PERMS)) as Array<{ id: string }>;
		expect(rows.map((row) => row.id)).toContain(created.id);
		service.close();
	});

	it("show resolves a doc by name, without a separate round trip", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("docs.create", 1, { title: "Storage schema", project_root: PROJECT }, PERMS)) as { id: string };

		const byId = await registry.invoke("docs.show", 1, { id: created.id }, PERMS);
		const byName = await registry.invoke("docs.show", 1, { name: "Storage schema" }, PERMS);
		expect(byName).toEqual(byId);
		service.close();
	});

	it("activate/archive/reopen walk the full doc lifecycle", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("docs.create", 1, { title: "Lifecycle doc", project_root: PROJECT }, PERMS)) as { id: string; status: string };
		expect(created.status).toBe("draft");

		const activated = (await registry.invoke("docs.activate", 1, { id: created.id }, PERMS)) as { status: string };
		expect(activated.status).toBe("active");

		const archived = (await registry.invoke("docs.archive", 1, { id: created.id }, PERMS)) as { status: string };
		expect(archived.status).toBe("archived");

		const reopened = (await registry.invoke("docs.reopen", 1, { id: created.id }, PERMS)) as { status: string };
		expect(reopened.status).toBe("draft");
		service.close();
	});

	it("link resolves both the doc and a cross-kind target (a rule) by name in one call", async () => {
		const { registry, service } = harness();
		const doc = (await registry.invoke("docs.create", 1, { title: "Research notes", project_root: PROJECT }, PERMS)) as { id: string };
		const rule = (await service.execute("rules.create", { title: "Follow the research notes", project_root: PROJECT })) as { id: string };

		const linked = (await registry.invoke("docs.link", 1, { name: "Research notes", relation: "references", target_name: "Follow the research notes" }, PERMS)) as { id: string };
		expect(linked.id).toBe(doc.id);

		const relationships = (await service.execute("graph.tree", { id: doc.id, depth: 1 })) as unknown;
		expect(relationships).toBeTruthy();
		service.close();
	});

	it("update changes title/body", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("docs.create", 1, { title: "Draft title", project_root: PROJECT }, PERMS)) as { id: string };
		const updated = (await registry.invoke("docs.update", 1, { id: created.id, title: "Final title" }, PERMS)) as { title: string };
		expect(updated.title).toBe("Final title");
		service.close();
	});

	it("assign_project reassigns or unscopes a doc", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("docs.create", 1, { title: "Movable doc", project_root: PROJECT }, PERMS)) as { id: string };
		await registry.invoke("docs.assign_project", 1, { id: created.id, project_root: "/tmp/other-project" }, PERMS);

		const rows = (await registry.invoke("docs.list", 1, { project_root: "/tmp/other-project" }, PERMS)) as Array<{ id: string }>;
		expect(rows.map((row) => row.id)).toContain(created.id);
		service.close();
	});

	it("remove/restore go through the shared kind-agnostic artifact.* operations, not a docs-namespaced duplicate", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("docs.create", 1, { title: "Trash me", project_root: PROJECT }, PERMS)) as { id: string };

		await registry.invoke("artifact.remove", 1, { id: created.id }, PERMS);
		const trashStatus = (await service.execute("artifact.trash_status", { id: created.id })) as { artifactId: string } | null;
		expect(trashStatus?.artifactId).toBe(created.id);

		const restored = (await registry.invoke("artifact.restore", 1, { id: created.id }, PERMS)) as { restored: boolean };
		expect(restored.restored).toBe(true);
		service.close();
	});
});
