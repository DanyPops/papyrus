import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/example-project";
const PERMS = { permissions: ["artifact:read", "artifact:write", "docs:read", "docs:write"] };

function harness() {
	const directory = tempDir("papyrus-artifact-trash-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("registerArtifactTrashOperations (wired through createPapyrusService) -- shared, kind-agnostic", () => {
	it("registers exactly one honest VehicleOperation per real artifact.* action", () => {
		const { registry, service } = harness();
		const names = registry
			.manifest()
			.operations.map((op: VehicleManifestOperation) => op.name)
			.filter((name: string) => name.startsWith("artifact."))
			.sort();
		expect(names).toEqual(["artifact.remove", "artifact.remove_subtree", "artifact.restore", "artifact.show"]);
		service.close();
	});

	it("show works for any kind, not just one domain", async () => {
		const { registry, service } = harness();
		const doc = (await service.execute("docs.create", { title: "A doc", project_root: PROJECT })) as { id: string };
		const rule = (await service.execute("rules.create", { title: "A rule", project_root: PROJECT })) as { id: string };

		const shownDoc = (await registry.invoke("artifact.show", 1, { id: doc.id }, PERMS)) as { kind: string };
		const shownRule = (await registry.invoke("artifact.show", 1, { id: rule.id }, PERMS)) as { kind: string };
		expect(shownDoc.kind).toBe("doc");
		expect(shownRule.kind).toBe("rule");
		service.close();
	});

	it("remove_subtree trashes a whole contains subtree in one call", async () => {
		const { registry, service } = harness();
		const parent = (await registry.invoke("docs.create", 1, { title: "Parent doc", project_root: PROJECT }, PERMS)) as { id: string };
		const child = (await registry.invoke("docs.create", 1, { title: "Child doc", project_root: PROJECT }, PERMS)) as { id: string };
		await service.execute("graph.link", { from: parent.id, relation: "contains", to: child.id });

		const result = (await registry.invoke("artifact.remove_subtree", 1, { id: parent.id }, PERMS)) as { removed: string[] };
		expect(result.removed.sort()).toEqual([child.id, parent.id].sort());

		const parentTrash = (await service.execute("artifact.trash_status", { id: parent.id })) as { artifactId: string } | null;
		const childTrash = (await service.execute("artifact.trash_status", { id: child.id })) as { artifactId: string } | null;
		expect(parentTrash?.artifactId).toBe(parent.id);
		expect(childTrash?.artifactId).toBe(child.id);
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("artifact.show", 1, { id: "does-not-matter" })).rejects.toThrow(/requires permissions/);
		service.close();
	});
});
