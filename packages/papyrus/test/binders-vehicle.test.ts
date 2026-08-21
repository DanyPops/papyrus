import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { BINDERS_OPERATION_NAMES } from "../src/modules/binders.ts";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/binders-vehicle-project";
const PERMS = { permissions: ["binders:read", "binders:write"] };

function harness() {
	const service = createPapyrusService(join(tempDir("papyrus-binders-vehicle-"), "papyrus.db"));
	return { service, registry: service.vehicle };
}

describe("Binder Vehicle operations", () => {
	it("registers every Binder action through the shared registry", () => {
		const { service, registry } = harness();
		const names = registry
			.manifest()
			.operations.map((operation: VehicleManifestOperation) => operation.name)
			.filter((name: string) => name.startsWith("binders."))
			.sort();
		expect(names).toEqual([...BINDERS_OPERATION_NAMES].sort());
		service.close();
	});

	it("resolves parent paths and returns effective labels through the public Vehicle", async () => {
		const { service, registry } = harness();
		const root = (await registry.invoke(
			"binders.create",
			1,
			{ title: "Knowledge", labels: ["knowledge"], project_root: PROJECT },
			PERMS,
		)) as { id: string };
		const child = (await registry.invoke(
			"binders.create",
			1,
			{ title: "Decisions", parent_name: "/Knowledge", labels: ["decision"], project_root: PROJECT },
			PERMS,
		)) as { id: string };
		const doc = (await service.execute("docs.create", { title: "Storage", project_root: PROJECT, labels: ["sqlite"] })) as { id: string };
		await registry.invoke("binders.file", 1, { binder_name: "/Knowledge/Decisions", artifact_id: doc.id, project_root: PROJECT }, PERMS);
		const tree = (await registry.invoke("binders.tree", 1, { project_root: PROJECT, artifact_ids: [doc.id] }, PERMS)) as {
			nodes: Array<{ binder: { id: string }; path: string }>;
			artifacts: Array<{ binderId?: string; effectiveLabels: string[] }>;
		};
		expect(tree.nodes.find((node) => node.binder.id === root.id)?.path).toBe("/Knowledge");
		expect(tree.nodes.find((node) => node.binder.id === child.id)?.path).toBe("/Knowledge/Decisions");
		expect(tree.artifacts[0]).toMatchObject({ binderId: child.id, effectiveLabels: ["knowledge", "decision", "sqlite"] });
		service.close();
	});

	it("protects Binder relations from the generic graph surface", async () => {
		const { service } = harness();
		const binder = (await service.execute("binders.create", { title: "Protected" })) as { id: string };
		const doc = (await service.execute("docs.create", { title: "Doc" })) as { id: string };
		await expect(service.execute("graph.link", { from: binder.id, relation: "organizes", to: doc.id })).rejects.toThrow(/binders\.\*/i);
		await expect(service.execute("artifact.remove", { id: binder.id })).rejects.toThrow(/binders\.remove/i);
		service.close();
	});
});
