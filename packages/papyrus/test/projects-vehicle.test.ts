import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PERMS = { permissions: ["projects:read", "projects:write"] };

function harness() {
	const directory = tempDir("papyrus-projects-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("registerProjectsVehicleOperations (wired through createPapyrusService)", () => {
	it("registers exactly one honest VehicleOperation per real projects.* action", () => {
		const { registry, service } = harness();
		const names = registry
			.manifest()
			.operations.map((op: VehicleManifestOperation) => op.name)
			.filter((name: string) => name.startsWith("projects."))
			.sort();
		expect(names).toEqual(["projects.list", "projects.register", "projects.resolve"]);
		service.close();
	});

	it("register/list/resolve round trip through the shared catalog Tasks/Docs/Rules/Playbooks already use", async () => {
		const { registry, service } = harness();
		const registered = (await registry.invoke(
			"projects.register",
			1,
			{ project_root: "/tmp/shared-catalog-project", name: "Shared Catalog Project", aliases: ["scp"] },
			PERMS,
		)) as { id: string; name: string; projectRoot: string; aliases: string[] };
		expect(registered.name).toBe("Shared Catalog Project");
		expect(registered.aliases).toContain("scp");

		const listed = (await registry.invoke("projects.list", 1, { query: "Shared Catalog" }, PERMS)) as Array<{ id: string }>;
		expect(listed.map((project) => project.id)).toContain(registered.id);

		const resolvedByAlias = (await registry.invoke("projects.resolve", 1, { reference: "scp" }, PERMS)) as { id: string };
		expect(resolvedByAlias.id).toBe(registered.id);

		const resolvedByRoot = (await registry.invoke("projects.resolve", 1, { reference: "/tmp/shared-catalog-project" }, PERMS)) as {
			id: string;
		};
		expect(resolvedByRoot.id).toBe(registered.id);
		service.close();
	});

	it("fails closed with bounded candidates when a reference is unknown", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("projects.resolve", 1, { reference: "never-registered" }, PERMS)).rejects.toThrow(/no project named/);
		service.close();
	});

	it("is the SAME underlying catalog tasks.register_project/resolve_project/projects already use -- a project registered via one surface resolves via the other", async () => {
		const { registry, service } = harness();
		await registry.invoke("projects.register", 1, { project_root: "/tmp/cross-surface-project", name: "Cross Surface Project" }, PERMS);
		const viaTasks = (await service.execute("tasks.resolve_project", { name: "Cross Surface Project" })) as { projectRoot: string };
		expect(viaTasks.projectRoot).toBe("/tmp/cross-surface-project");

		await service.execute("tasks.register_project", { project_root: "/tmp/other-surface-project", name: "Other Surface Project" });
		const viaProjects = (await registry.invoke("projects.resolve", 1, { reference: "Other Surface Project" }, PERMS)) as {
			projectRoot: string;
		};
		expect(viaProjects.projectRoot).toBe("/tmp/other-surface-project");
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("projects.list", 1, {})).rejects.toThrow(/requires permissions/);
		service.close();
	});
});
