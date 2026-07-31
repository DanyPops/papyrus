import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/example-project";
const PERMS = { permissions: ["skills:read", "skills:write", "artifact:read", "artifact:write"] };

const WORKFLOW_DEFINITION = {
	version: 1,
	inputs: { project: { type: "string", required: true } },
	blueprints: {
		docs: [{ ref: "context", title: "{{project}} context", body: "Context for {{project}}" }],
		rules: [{ ref: "safety", title: "Protect {{project}}", condition: "changing {{project}}", action: "Use reviewed changes" }],
		tasks: [{ ref: "verify", title: "Verify {{project}}" }],
	},
};

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

	it("run instantiates a workflow: docs/rules/tasks are created, and the output carries its own model-facing content summary instead of the raw execution DAG", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("skills.create", 1, { title: "Deploy workflow", definition: WORKFLOW_DEFINITION, project_root: PROJECT }, PERMS)) as { id: string };

		const run = (await registry.invoke("skills.run", 1, { id: created.id, run_id: "run-1", arguments: { project: "Papyrus" }, project_root: PROJECT }, PERMS)) as {
			runId: string;
			created: { docs: string[]; rules: string[]; tasks: string[] };
			content: Array<{ type: string; text: string }>;
		};
		expect(run.created.docs).toHaveLength(1);
		expect(run.created.rules).toHaveLength(1);
		expect(run.created.tasks).toHaveLength(1);

		expect(run.content).toHaveLength(1);
		expect(run.content[0]!.type).toBe("text");
		expect(run.content[0]!.text).toContain(`Created Skill run ${run.runId}: 1 tasks, 1 rules, 1 docs.`);
		expect(run.content[0]!.text).toContain("Ready roots:");
		expect(run.content[0]!.text).toContain("Papyrus context");
		expect(run.content[0]!.text).toContain("Protect Papyrus");
		expect(run.content[0]!.text).not.toContain('"layers"');
		expect(run.content[0]!.text).not.toContain('"cycleIds"');
		service.close();
	});

	it("run resolves the skill by name and requires project_root explicitly (no ambient cwd server-side)", async () => {
		const { registry, service } = harness();
		await registry.invoke("skills.create", 1, { title: "Named workflow", definition: WORKFLOW_DEFINITION, project_root: PROJECT }, PERMS);

		await expect(registry.invoke("skills.run", 1, { name: "Named workflow", arguments: { project: "Papyrus" } }, PERMS)).rejects.toThrow(/invalid input/);
		service.close();
	});

	it("instantiate: a non-task-target template creates a plain artifact", async () => {
		const { registry, service } = harness();
		const template = (await registry.invoke("skills.create_template", 1, { title: "Doc template", target_kind: "doc", project_root: PROJECT }, PERMS)) as { id: string };

		const artifact = (await registry.invoke("skills.instantiate", 1, {
			template_id: template.id, title: "Generated doc", kind: "doc", project_root: PROJECT,
		}, PERMS)) as { id: string; kind: string; title: string };
		expect(artifact.kind).toBe("doc");
		expect(artifact.title).toBe("Generated doc");
		service.close();
	});

	it("instantiate: a task-target template calls tasks.create() directly", async () => {
		const { registry, service } = harness();
		const template = (await registry.invoke("skills.create_template", 1, { title: "Task template", target_kind: "task", project_root: PROJECT }, PERMS)) as { id: string };

		const task = (await registry.invoke("skills.instantiate", 1, {
			template_id: template.id, title: "Generated task", project_root: PROJECT,
		}, PERMS)) as { id: string; kind: string; title: string };
		expect(task.kind).toBe("task");
		expect(task.title).toBe("Generated task");
		service.close();
	});

	it("instantiate resolves the template by name", async () => {
		const { registry, service } = harness();
		await registry.invoke("skills.create_template", 1, { title: "Named template", target_kind: "doc", project_root: PROJECT }, PERMS);

		const artifact = (await registry.invoke("skills.instantiate", 1, {
			template_name: "Named template", title: "From named template", project_root: PROJECT,
		}, PERMS)) as { id: string; title: string };
		expect(artifact.title).toBe("From named template");
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
