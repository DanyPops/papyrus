import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PERMS = { permissions: ["playbooks:read", "playbooks:write", "artifact:read", "artifact:write"] };

function harness() {
	const directory = tempDir("papyrus-playbooks-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("registerPlaybooksVehicleOperations (wired through createPapyrusService)", () => {
	it("registers exactly one honest VehicleOperation per real playbooks.* action, never an action-dispatch schema", () => {
		const { registry, service } = harness();
		const names = registry.manifest().operations.map((op: VehicleManifestOperation) => op.name).filter((name: string) => name.startsWith("playbooks.")).sort();
		expect(names).toEqual([
			"playbooks.assign_project", "playbooks.contain", "playbooks.create", "playbooks.depend", "playbooks.disable",
			"playbooks.enable", "playbooks.invoke", "playbooks.list", "playbooks.preview", "playbooks.show",
			"playbooks.uncontain", "playbooks.undepend", "playbooks.update",
		]);
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("playbooks.list", 1, {})).rejects.toThrow(/requires permissions/);
		service.close();
	});

	it("creates a playbook and lists it", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] }, PERMS)) as { id: string; title: string };
		expect(created.title).toBe("New Project");

		const rows = (await registry.invoke("playbooks.list", 1, {}, PERMS)) as Array<{ id: string }>;
		expect(rows.map((row) => row.id)).toContain(created.id);
		service.close();
	});

	it("show resolves a playbook by name, without a separate round trip", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Lab Deploy", steps: ["Provision"] }, PERMS)) as { id: string };

		const byId = await registry.invoke("playbooks.show", 1, { id: created.id }, PERMS);
		const byName = await registry.invoke("playbooks.show", 1, { name: "Lab Deploy" }, PERMS);
		expect(byName).toEqual(byId);
		service.close();
	});

	it("preview renders the composition tree as text with no side effects", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] }, PERMS)) as { id: string };

		const preview = (await registry.invoke("playbooks.preview", 1, { id: created.id }, PERMS)) as string;
		expect(preview).toContain("1. Frame the problem");
		const graph = (await service.execute("artifact.query", { kind: "task" })) as unknown[];
		expect(graph).toHaveLength(0);
		service.close();
	});

	it("invoke materializes real tasks and focuses the entry task, with a model-facing content summary instead of the raw execution DAG", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] }, PERMS)) as { id: string };

		const invocation = (await registry.invoke("playbooks.invoke", 1, { id: created.id }, PERMS)) as {
			entryTaskId: string;
			created: { tasks: string[] };
			content: Array<{ type: string; text: string }>;
		};
		expect(invocation.created.tasks).toHaveLength(2); // container + one step

		expect(invocation.content).toHaveLength(1);
		expect(invocation.content[0]!.type).toBe("text");
		expect(invocation.content[0]!.text).toContain("Invoked playbook run");
		expect(invocation.content[0]!.text).toContain("Entry task now focused: Frame the problem");
		expect(invocation.content[0]!.text).not.toContain('"layers"');
		expect(invocation.content[0]!.text).not.toContain('"cycleIds"');
		service.close();
	});

	it("invoke returns missingArguments (with its own content text) and creates nothing when a required argument is absent", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Needs env", steps: ["Deploy to {{environment}}"], arguments: [{ name: "environment", required: true }] }, PERMS)) as { id: string };

		const result = (await registry.invoke("playbooks.invoke", 1, { id: created.id }, PERMS)) as { missingArguments: string[]; content: Array<{ type: string; text: string }> };
		expect(result.missingArguments).toEqual(["environment"]);
		expect(result.content[0]!.text).toContain("Missing required argument(s): environment");
		expect(result.content[0]!.text).toContain("Nothing was created");

		const graph = (await service.execute("artifact.query", { kind: "task" })) as unknown[];
		expect(graph).toHaveLength(0);
		service.close();
	});

	it("invoke accepts a JSON-encoded string for arguments -- a known LLM tool-calling quirk", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Needs env 2", steps: ["Deploy to {{environment}}"], arguments: [{ name: "environment", required: true }] }, PERMS)) as { id: string };

		const invocation = (await registry.invoke("playbooks.invoke", 1, { id: created.id, arguments: JSON.stringify({ environment: "staging" }) }, PERMS)) as { entryTaskId: string };
		expect(invocation.entryTaskId).toBeTruthy();
		service.close();
	});

	it("enable/disable transition a playbook's status", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Toggle me", steps: ["Step"] }, PERMS)) as { id: string; status: string };

		const disabled = (await registry.invoke("playbooks.disable", 1, { id: created.id }, PERMS)) as { status: string };
		expect(disabled.status).not.toBe(created.status);

		const enabled = (await registry.invoke("playbooks.enable", 1, { id: created.id }, PERMS)) as { status: string };
		expect(enabled.status).toBe(created.status);
		service.close();
	});

	it("update changes title/body", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Old title", steps: ["Step"] }, PERMS)) as { id: string };
		const updated = (await registry.invoke("playbooks.update", 1, { id: created.id, title: "New title" }, PERMS)) as { title: string };
		expect(updated.title).toBe("New title");
		service.close();
	});

	it("contain/uncontain resolve parent_name/child_name server-side", async () => {
		const { registry, service } = harness();
		const parent = (await registry.invoke("playbooks.create", 1, { title: "Parent playbook", steps: ["Parent step"] }, PERMS)) as { id: string };
		const child = (await registry.invoke("playbooks.create", 1, { title: "Child playbook", steps: ["Child step"] }, PERMS)) as { id: string };

		await registry.invoke("playbooks.contain", 1, { parent_name: "Parent playbook", child_name: "Child playbook" }, PERMS);
		const tree = (await service.execute("graph.tree", { id: parent.id, depth: 1 })) as { edges?: Array<{ from: string; to: string; relation: string }> };
		expect(tree.edges?.some((edge) => edge.relation === "contains" && edge.to === child.id)).toBe(true);

		await registry.invoke("playbooks.uncontain", 1, { parent_name: "Parent playbook", child_name: "Child playbook" }, PERMS);
		const afterUncontain = (await service.execute("graph.tree", { id: parent.id, depth: 1 })) as { edges?: Array<{ from: string; to: string; relation: string }> };
		expect(afterUncontain.edges?.some((edge) => edge.relation === "contains" && edge.to === child.id)).toBe(false);
		service.close();
	});

	it("depend/undepend resolve dependency_name server-side", async () => {
		const { registry, service } = harness();
		const dependent = (await registry.invoke("playbooks.create", 1, { title: "Dependent playbook", steps: ["Step"] }, PERMS)) as { id: string };
		await registry.invoke("playbooks.create", 1, { title: "Prerequisite playbook", steps: ["Step"] }, PERMS);

		await registry.invoke("playbooks.depend", 1, { name: "Dependent playbook", dependency_name: "Prerequisite playbook" }, PERMS);
		const tree = (await service.execute("graph.tree", { id: dependent.id, depth: 1 })) as { edges?: Array<{ from: string; to: string; relation: string }> };
		expect(tree.edges?.some((edge) => edge.relation === "depends_on")).toBe(true);

		await registry.invoke("playbooks.undepend", 1, { name: "Dependent playbook", dependency_name: "Prerequisite playbook" }, PERMS);
		const afterUndepend = (await service.execute("graph.tree", { id: dependent.id, depth: 1 })) as { edges?: Array<{ from: string; to: string; relation: string }> };
		expect(afterUndepend.edges?.some((edge) => edge.relation === "depends_on")).toBe(false);
		service.close();
	});

	it("invoke authorizes its internal focus write via principal.claims.sessionId/sessionSecret, never a model-visible input field", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Session-scoped", steps: ["Step"] }, PERMS)) as { id: string };

		const { secret } = (await service.execute("session.register", { session_id: "session-1" })) as { sessionId: string; secret: string };

		// A wrong secret for a REGISTERED session id is refused -- assertAuthorized's real check runs.
		// VehicleRegistry wraps the real domain error in a generic "handler failed" VehicleError,
		// with the original preserved as .cause.
		const rejection = await registry.invoke("playbooks.invoke", 1, { id: created.id }, {
			...PERMS,
			principal: { id: "pi-papyrus", claims: { sessionId: "session-1", sessionSecret: "wrong-secret" } },
		}).catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as { cause?: unknown }).cause).toBeInstanceOf(Error);
		expect(((rejection as { cause: Error }).cause).message).toContain("session_secret");

		// The real cached secret authorizes it.
		const invocation = (await registry.invoke("playbooks.invoke", 1, { id: created.id }, {
			...PERMS,
			principal: { id: "pi-papyrus", claims: { sessionId: "session-1", sessionSecret: secret } },
		})) as { entryTaskId: string };
		expect(invocation.entryTaskId).toBeTruthy();
		service.close();
	});

	it("remove/restore go through the shared kind-agnostic artifact.* operations, not a playbooks-namespaced duplicate", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Trash me", steps: ["Step"] }, PERMS)) as { id: string };

		await registry.invoke("artifact.remove", 1, { id: created.id }, PERMS);
		const trashStatus = (await service.execute("artifact.trash_status", { id: created.id })) as { artifactId: string } | null;
		expect(trashStatus?.artifactId).toBe(created.id);

		const restored = (await registry.invoke("artifact.restore", 1, { id: created.id }, PERMS)) as { restored: boolean };
		expect(restored.restored).toBe(true);
		service.close();
	});
});
