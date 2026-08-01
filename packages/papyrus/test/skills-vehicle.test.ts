import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/example-project";
const PERMS = { permissions: ["skills:read", "skills:write", "artifact:read", "artifact:write"] };

function harness() {
	const directory = tempDir("papyrus-skills-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("registerSkillsVehicleOperations (wired through createPapyrusService)", () => {
	it("registers exactly one honest VehicleOperation per real skills.* action, never an action-dispatch schema", () => {
		const { registry, service } = harness();
		const names = registry.manifest().operations.map((op: VehicleManifestOperation) => op.name).filter((name: string) => name.startsWith("skills.")).sort();
		expect(names).toEqual([
			"skills.assign_project", "skills.create", "skills.create_template", "skills.disable", "skills.enable",
			"skills.instantiate", "skills.invoke", "skills.list", "skills.run", "skills.show", "skills.update",
		]);
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("skills.list", 1, {})).rejects.toThrow(/requires permissions/);
		service.close();
	});

	it("creates a skill and lists it by project", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("skills.create", 1, { title: "Deploy checklist", project_root: PROJECT }, PERMS)) as { id: string; title: string };
		expect(created.title).toBe("Deploy checklist");

		const rows = (await registry.invoke("skills.list", 1, { project_root: PROJECT }, PERMS)) as Array<{ id: string }>;
		expect(rows.map((row) => row.id)).toContain(created.id);
		service.close();
	});

	it("show resolves a skill by name, without a separate round trip", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("skills.create", 1, { title: "Rollback plan", project_root: PROJECT }, PERMS)) as { id: string };

		const byId = await registry.invoke("skills.show", 1, { id: created.id }, PERMS);
		const byName = await registry.invoke("skills.show", 1, { name: "Rollback plan" }, PERMS);
		expect(byName).toEqual(byId);
		service.close();
	});

	it("enable/disable transition a skill's status", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("skills.create", 1, { title: "Toggle me", project_root: PROJECT }, PERMS)) as { id: string; status: string };
		expect(created.status).toBe("active");

		const disabled = (await registry.invoke("skills.disable", 1, { id: created.id }, PERMS)) as { status: string };
		expect(disabled.status).toBe("deprecated");

		const enabled = (await registry.invoke("skills.enable", 1, { id: created.id }, PERMS)) as { status: string };
		expect(enabled.status).toBe("active");
		service.close();
	});

	it("update changes title/body", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("skills.create", 1, { title: "Old title", project_root: PROJECT }, PERMS)) as { id: string };
		const updated = (await registry.invoke("skills.update", 1, { id: created.id, title: "New title" }, PERMS)) as { title: string };
		expect(updated.title).toBe("New title");
		service.close();
	});

	// skills.create's definition-based path, skills.create_template, skills.instantiate, and
	// skills.run are all retired -- workflow richness now lives entirely on Playbook (structured
	// doc/rule/call steps), and the artifact-template compatibility mechanism had zero real
	// production usage, ever, in any environment checked. See modules/playbooks.ts.
	// VehicleRegistry wraps the real domain error in a generic "handler failed" VehicleError,
	// with the original preserved as .cause -- see playbooks-vehicle.test.ts's own precedent.
	async function rejectionCause(promise: Promise<unknown>): Promise<string> {
		const rejection = await promise.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as { cause?: unknown }).cause).toBeInstanceOf(Error);
		return ((rejection as { cause: Error }).cause).message;
	}

	it("skills.create rejects a workflow Skill definition -- retired, use playbooks.create's structured steps instead", async () => {
		const { registry, service } = harness();
		const message = await rejectionCause(registry.invoke("skills.create", 1, { title: "Old-style workflow", definition: { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [] } }, project_root: PROJECT }, PERMS));
		expect(message).toContain("workflow Skill definitions are retired");
		service.close();
	});

	it("skills.create_template is retired -- zero real production usage, ever", async () => {
		const { registry, service } = harness();
		const message = await rejectionCause(registry.invoke("skills.create_template", 1, { title: "Doc template", target_kind: "doc", project_root: PROJECT }, PERMS));
		expect(message).toContain("artifact templates are retired");
		service.close();
	});

	it("skills.instantiate is retired -- zero real production usage, ever", async () => {
		const { registry, service } = harness();
		const legacyTemplate = (await service.execute("artifact.create", {
			kind: "skill", subtype: "artifact-template", title: "Legacy template", extra: { targetKind: "doc", defaults: {} },
		})) as { id: string };
		const message = await rejectionCause(registry.invoke("skills.instantiate", 1, { template_id: legacyTemplate.id, title: "Bypass", project_root: PROJECT }, PERMS));
		expect(message).toContain("artifact templates are retired");
		service.close();
	});

	it("skills.run is retired -- author a Playbook with structured steps and call playbooks.invoke instead", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("skills.create", 1, { title: "Not runnable", project_root: PROJECT }, PERMS)) as { id: string };
		const message = await rejectionCause(registry.invoke("skills.run", 1, { id: created.id, project_root: PROJECT }, PERMS));
		expect(message).toContain("workflow Skill execution is retired");
		service.close();
	});

	it("remove/restore go through the shared kind-agnostic artifact.* operations, not a skills-namespaced duplicate", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("skills.create", 1, { title: "Trash me", project_root: PROJECT }, PERMS)) as { id: string };

		await registry.invoke("artifact.remove", 1, { id: created.id }, PERMS);
		const trashStatus = (await service.execute("artifact.trash_status", { id: created.id })) as { artifactId: string } | null;
		expect(trashStatus?.artifactId).toBe(created.id);

		const restored = (await registry.invoke("artifact.restore", 1, { id: created.id }, PERMS)) as { restored: boolean };
		expect(restored.restored).toBe(true);
		service.close();
	});
});
