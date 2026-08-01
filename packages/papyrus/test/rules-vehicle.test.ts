import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/example-project";
const PERMS = { permissions: ["rules:read", "rules:write", "artifact:read", "artifact:write"] };

function harness() {
	const directory = tempDir("papyrus-rules-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("registerRulesVehicleOperations (wired through createPapyrusService)", () => {
	it("registers exactly one honest VehicleOperation per real rules.* action, never an action-dispatch schema", () => {
		const { registry, service } = harness();
		const names = registry
			.manifest()
			.operations.map((op: VehicleManifestOperation) => op.name)
			.filter((name: string) => name.startsWith("rules."))
			.sort();
		expect(names).toEqual([
			"rules.assign_project",
			"rules.create",
			"rules.disable",
			"rules.enable",
			"rules.gate",
			"rules.list",
			"rules.preview",
			"rules.show",
			"rules.update",
		]);
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("rules.list", 1, {})).rejects.toThrow(/requires permissions/);
		service.close();
	});

	it("creates a rule and lists it by project", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("rules.create", 1, { title: "Always run tests", project_root: PROJECT }, PERMS)) as {
			id: string;
			title: string;
		};
		expect(created.title).toBe("Always run tests");

		const rows = (await registry.invoke("rules.list", 1, { project_root: PROJECT }, PERMS)) as Array<{ id: string }>;
		expect(rows.map((row) => row.id)).toContain(created.id);
		service.close();
	});

	it("show resolves a rule by name, without a separate round trip", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("rules.create", 1, { title: "Prefer edit over sed", project_root: PROJECT }, PERMS)) as {
			id: string;
		};

		const byId = await registry.invoke("rules.show", 1, { id: created.id }, PERMS);
		const byName = await registry.invoke("rules.show", 1, { name: "Prefer edit over sed" }, PERMS);
		expect(byName).toEqual(byId);
		service.close();
	});

	it("show by an unscoped name still resolves via the widen-past-scope fallback", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("rules.create", 1, { title: "Scoped rule", project_root: PROJECT }, PERMS)) as { id: string };

		// No project_root given -- the in-scope lookup (unscoped) finds nothing since the
		// rule itself IS scoped, so this must fall back to the widened (cross-project) search.
		const resolved = (await registry.invoke("rules.show", 1, { name: "Scoped rule" }, PERMS)) as { id: string };
		expect(resolved.id).toBe(created.id);
		service.close();
	});

	it("enable/disable transition a rule's status -- rules default to active on create", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("rules.create", 1, { title: "Toggle me", project_root: PROJECT }, PERMS)) as {
			id: string;
			status: string;
		};
		expect(created.status).toBe("active");

		const disabled = (await registry.invoke("rules.disable", 1, { id: created.id }, PERMS)) as { status: string };
		expect(disabled.status).toBe("deprecated");

		const enabled = (await registry.invoke("rules.enable", 1, { id: created.id }, PERMS)) as { status: string };
		expect(enabled.status).toBe("active");
		service.close();
	});

	it("gate resolves both the rule and the target task by name in one call", async () => {
		const { registry, service } = harness();
		const rule = (await registry.invoke("rules.create", 1, { title: "Must pass CI", project_root: PROJECT }, PERMS)) as { id: string };
		const _task = (await service.execute("tasks.create", { title: "Ship the feature", project_root: PROJECT })) as { id: string };

		const gated = (await registry.invoke("rules.gate", 1, { name: "Must pass CI", task_name: "Ship the feature" }, PERMS)) as {
			id: string;
		};
		expect(gated.id).toBe(rule.id);
		service.close();
	});

	it("update changes title/body", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("rules.create", 1, { title: "Old title", project_root: PROJECT }, PERMS)) as { id: string };
		const updated = (await registry.invoke("rules.update", 1, { id: created.id, title: "New title" }, PERMS)) as { title: string };
		expect(updated.title).toBe("New title");
		service.close();
	});

	it("remove/restore go through the shared kind-agnostic artifact.* operations, not a rules-namespaced duplicate", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("rules.create", 1, { title: "Trash me", project_root: PROJECT }, PERMS)) as { id: string };

		await registry.invoke("artifact.remove", 1, { id: created.id }, PERMS);
		// Trashed artifacts stay directly showable by id (only excluded from list/query) --
		// trash_status, not show, is the real signal an artifact was actually trashed.
		const trashStatus = (await service.execute("artifact.trash_status", { id: created.id })) as { artifactId: string } | null;
		expect(trashStatus?.artifactId).toBe(created.id);

		const restored = (await registry.invoke("artifact.restore", 1, { id: created.id }, PERMS)) as { restored: boolean };
		expect(restored.restored).toBe(true);
		const afterRestore = (await service.execute("artifact.trash_status", { id: created.id })) as unknown;
		expect(afterRestore).toBeNull();
		service.close();
	});
});
