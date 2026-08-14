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
		const names = registry
			.manifest()
			.operations.map((op: VehicleManifestOperation) => op.name)
			.filter((name: string) => name.startsWith("playbooks."))
			.sort();
		expect(names).toEqual([
			"playbooks.add_group",
			"playbooks.add_project",
			"playbooks.assign_project",
			"playbooks.contain",
			"playbooks.create",
			"playbooks.depend",
			"playbooks.disable",
			"playbooks.enable",
			"playbooks.invoke",
			"playbooks.list",
			"playbooks.preview",
			"playbooks.remove_group",
			"playbooks.remove_project",
			"playbooks.replace_groups",
			"playbooks.replace_projects",
			"playbooks.scope",
			"playbooks.set_global",
			"playbooks.set_none",
			"playbooks.show",
			"playbooks.uncontain",
			"playbooks.undepend",
			"playbooks.update",
		]);
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("playbooks.list", 1, {})).rejects.toThrow(/requires permissions/);
		service.close();
	});

	it("accepts subtype and template_id, the same create-time surface docs.create already exposes (papyrus-defect-unify-template-subtype-53b3a1eb)", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Runbook", subtype: "incident-response" }, PERMS)) as {
			subtype: string;
		};
		expect(created.subtype).toBe("incident-response");
		service.close();
	});

	it("creates a playbook and lists it", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] },
			PERMS,
		)) as { id: string; title: string };
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

	it("round-trips a title containing HTML-special characters byte-for-byte through create/show/list, never entity-encoded", async () => {
		const { registry, service } = harness();
		const title = "Data Hygiene Audit & Scrub";
		const created = (await registry.invoke("playbooks.create", 1, { title, steps: ["Scan"] }, PERMS)) as { id: string; title: string };
		expect(created.title).toBe(title);
		const shown = (await registry.invoke("playbooks.show", 1, { id: created.id }, PERMS)) as { title: string };
		expect(shown.title).toBe(title);
		const rows = (await registry.invoke("playbooks.list", 1, {}, PERMS)) as Array<{ title: string }>;
		expect(rows.map((row) => row.title)).toContain(title);
		service.close();
	});

	it("list returns a lean summary by default -- no body/extra, so browsing dozens of playbooks isn't as expensive as showing every one of them", async () => {
		const { registry, service } = harness();
		await registry.invoke("playbooks.create", 1, { title: "Big Runbook", body: "a".repeat(2000), steps: ["step one", "step two"] }, PERMS);

		const rows = (await registry.invoke("playbooks.list", 1, {}, PERMS)) as Array<Record<string, unknown>>;
		const row = rows.find((candidate) => candidate.title === "Big Runbook")!;
		expect(row.id).toBeDefined();
		expect(row.title).toBe("Big Runbook");
		expect(row.status).toBeDefined();
		expect(row.alias).toBeDefined();
		expect(row.body).toBeUndefined();
		expect(row.extra).toBeUndefined();
		service.close();
	});

	it("list returns the full artifact, including body/extra/steps, when full: true is passed", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "Full Runbook", body: "real body text", steps: ["step one"] },
			PERMS,
		)) as { id: string };

		const rows = (await registry.invoke("playbooks.list", 1, { full: true }, PERMS)) as Array<Record<string, unknown>>;
		const row = rows.find((candidate) => candidate.id === created.id)!;
		expect(row.body).toBe("real body text");
		expect((row.extra as { steps?: unknown[] }).steps).toEqual(["step one"]);
		service.close();
	});

	it("preview renders the composition tree as text with no side effects", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] },
			PERMS,
		)) as { id: string };

		const preview = (await registry.invoke("playbooks.preview", 1, { id: created.id }, PERMS)) as string;
		expect(preview).toContain("1. Frame the problem");
		const graph = (await service.execute("artifact.query", { kind: "task" })) as unknown[];
		expect(graph).toHaveLength(0);
		service.close();
	});

	it("invoke materializes real tasks and focuses the entry task, with a model-facing content summary instead of the raw execution DAG", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] },
			PERMS,
		)) as { id: string };

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
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "Needs env", steps: ["Deploy to {{environment}}"], arguments: [{ name: "environment", required: true }] },
			PERMS,
		)) as { id: string };

		const result = (await registry.invoke("playbooks.invoke", 1, { id: created.id }, PERMS)) as {
			missingArguments: string[];
			content: Array<{ type: string; text: string }>;
		};
		expect(result.missingArguments).toEqual(["environment"]);
		expect(result.content[0]!.text).toContain("Missing required argument(s): environment");
		expect(result.content[0]!.text).toContain("Nothing was created");

		const graph = (await service.execute("artifact.query", { kind: "task" })) as unknown[];
		expect(graph).toHaveLength(0);
		service.close();
	});

	it("create/invoke accept structured (doc/rule/call) steps and typed arguments through the real Vehicle JSON schema, not just the module layer directly", async () => {
		const { registry, service } = harness();
		const target = (await registry.invoke("playbooks.create", 1, { title: "Nested target", steps: ["Target step"] }, PERMS)) as {
			id: string;
		};
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{
				title: "Rich playbook",
				steps: [
					"Plain step",
					{ kind: "doc", title: "A doc", body: "content" },
					{ kind: "rule", title: "A rule", condition: "always" },
					{ kind: "call", title: "Run target", playbookId: target.id },
				],
				arguments: [{ name: "count", type: "number", required: true }],
			},
			PERMS,
		)) as { id: string };

		const invocation = (await registry.invoke("playbooks.invoke", 1, { id: created.id, arguments: { count: 3 } }, PERMS)) as {
			created: { docs: string[]; rules: string[]; tasks: string[] };
			arguments: Record<string, unknown>;
		};
		expect(invocation.created.docs).toHaveLength(1);
		expect(invocation.created.rules).toHaveLength(1);
		expect(invocation.arguments.count).toBe(3);
		service.close();
	});

	it("invoke accepts a JSON-encoded string for arguments -- a known LLM tool-calling quirk", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "Needs env 2", steps: ["Deploy to {{environment}}"], arguments: [{ name: "environment", required: true }] },
			PERMS,
		)) as { id: string };

		const invocation = (await registry.invoke(
			"playbooks.invoke",
			1,
			{ id: created.id, arguments: JSON.stringify({ environment: "staging" }) },
			PERMS,
		)) as { entryTaskId: string };
		expect(invocation.entryTaskId).toBeTruthy();
		service.close();
	});

	it("enable/disable transition a playbook's status", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Toggle me", steps: ["Step"] }, PERMS)) as {
			id: string;
			status: string;
		};

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

	it("update also revises steps/trigger through the real Vehicle wire protocol -- not just title/body/labels", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "Project-specific playbook", trigger: "Old trigger", steps: ["Old, project-specific step"] },
			PERMS,
		)) as { id: string };
		const updated = (await registry.invoke(
			"playbooks.update",
			1,
			{ id: created.id, trigger: "New, generic trigger", steps: ["New, generic step"] },
			PERMS,
		)) as { extra: { trigger: string; steps: unknown[] } };
		expect(updated.extra.trigger).toBe("New, generic trigger");
		expect(updated.extra.steps).toEqual(["New, generic step"]);
		service.close();
	});

	it("contain/uncontain resolve parent_name/child_name server-side", async () => {
		const { registry, service } = harness();
		const parent = (await registry.invoke("playbooks.create", 1, { title: "Parent playbook", steps: ["Parent step"] }, PERMS)) as {
			id: string;
		};
		const child = (await registry.invoke("playbooks.create", 1, { title: "Child playbook", steps: ["Child step"] }, PERMS)) as {
			id: string;
		};

		await registry.invoke("playbooks.contain", 1, { parent_name: "Parent playbook", child_name: "Child playbook" }, PERMS);
		const tree = (await service.execute("graph.tree", { id: parent.id, depth: 1 })) as {
			edges?: Array<{ from: string; to: string; relation: string }>;
		};
		expect(tree.edges?.some((edge) => edge.relation === "contains" && edge.to === child.id)).toBe(true);

		await registry.invoke("playbooks.uncontain", 1, { parent_name: "Parent playbook", child_name: "Child playbook" }, PERMS);
		const afterUncontain = (await service.execute("graph.tree", { id: parent.id, depth: 1 })) as {
			edges?: Array<{ from: string; to: string; relation: string }>;
		};
		expect(afterUncontain.edges?.some((edge) => edge.relation === "contains" && edge.to === child.id)).toBe(false);
		service.close();
	});

	it("depend/undepend resolve dependency_name server-side", async () => {
		const { registry, service } = harness();
		const dependent = (await registry.invoke("playbooks.create", 1, { title: "Dependent playbook", steps: ["Step"] }, PERMS)) as {
			id: string;
		};
		await registry.invoke("playbooks.create", 1, { title: "Prerequisite playbook", steps: ["Step"] }, PERMS);

		await registry.invoke("playbooks.depend", 1, { name: "Dependent playbook", dependency_name: "Prerequisite playbook" }, PERMS);
		const tree = (await service.execute("graph.tree", { id: dependent.id, depth: 1 })) as {
			edges?: Array<{ from: string; to: string; relation: string }>;
		};
		expect(tree.edges?.some((edge) => edge.relation === "depends_on")).toBe(true);

		await registry.invoke("playbooks.undepend", 1, { name: "Dependent playbook", dependency_name: "Prerequisite playbook" }, PERMS);
		const afterUndepend = (await service.execute("graph.tree", { id: dependent.id, depth: 1 })) as {
			edges?: Array<{ from: string; to: string; relation: string }>;
		};
		expect(afterUndepend.edges?.some((edge) => edge.relation === "depends_on")).toBe(false);
		service.close();
	});

	it("invoking a playbook whose own composition tree contains a depends_on cycle reports its own classified error instead of an opaque handler-failed wrap", async () => {
		const { registry, service } = harness();
		const first = (await registry.invoke("playbooks.create", 1, { title: "Cycle A", steps: ["Step"] }, PERMS)) as { id: string };
		const second = (await registry.invoke("playbooks.create", 1, { title: "Cycle B", steps: ["Step"] }, PERMS)) as { id: string };
		await registry.invoke("playbooks.depend", 1, { id: first.id, dependency_id: second.id }, PERMS);
		await registry.invoke("playbooks.depend", 1, { id: second.id, dependency_id: first.id }, PERMS);

		const rejection = await registry.invoke("playbooks.invoke", 1, { id: first.id }, PERMS).catch((error: unknown) => error);
		// Real incident: this used to arrive only as an opaque "playbooks.invoke@1 handler failed" --
		// see playbook-definition.ts's compileNode, which throws PlaybookCompositionError for exactly this.
		expect((rejection as { code?: string }).code).toBe("playbook-composition-invalid");
		expect((rejection as { category?: string }).category).toBe("validation");
		expect((rejection as { cause?: unknown }).cause).toBeUndefined();
		expect((rejection as Error).message).toContain("composition cycle");
		service.close();
	});

	it("invoke authorizes its internal focus write via principal.claims.sessionId/sessionSecret, never a model-visible input field", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("playbooks.create", 1, { title: "Session-scoped", steps: ["Step"] }, PERMS)) as { id: string };

		const { secret } = (await service.execute("session.register", { session_id: "session-1" })) as { sessionId: string; secret: string };

		// A wrong secret for a REGISTERED session id is refused -- assertAuthorized's real check runs
		// and must surface as its own classified VehicleError directly, not buried inside .cause of an
		// opaque "handler failed" wrap invisible to a caller that doesn't already know to dig for it.
		const rejection = await registry
			.invoke(
				"playbooks.invoke",
				1,
				{ id: created.id },
				{
					...PERMS,
					principal: { id: "pi-papyrus", claims: { sessionId: "session-1", sessionSecret: "wrong-secret" } },
				},
			)
			.catch((error: unknown) => error);
		expect((rejection as { code?: string }).code).toBe("invalid-session-secret");
		expect((rejection as { category?: string }).category).toBe("authorization");
		expect((rejection as { cause?: unknown }).cause).toBeUndefined();
		expect((rejection as Error).message).toContain("session_secret");

		// The real cached secret authorizes it.
		const invocation = (await registry.invoke(
			"playbooks.invoke",
			1,
			{ id: created.id },
			{
				...PERMS,
				principal: { id: "pi-papyrus", claims: { sessionId: "session-1", sessionSecret: secret } },
			},
		)) as { entryTaskId: string };
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

	it("create accepts bounded projectReferences (multi-project at creation), taking precedence over project_root", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/playbooks-create-scope-a", name: "Playbooks Create Scope A" });
		await service.execute("tasks.register_project", { project_root: "/tmp/playbooks-create-scope-b", name: "Playbooks Create Scope B" });
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "Multi-scoped playbook", project_root: "/tmp/other", projects: ["Playbooks Create Scope A", "Playbooks Create Scope B"] },
			PERMS,
		)) as { id: string };
		const scope = (await registry.invoke("playbooks.scope", 1, { id: created.id }, PERMS)) as {
			mode: string;
			members: Array<{ type: string; id: string }>;
		};
		expect(scope.mode).toBe("explicit");
		expect(scope.members).toHaveLength(2);
		service.close();
	});

	it("exposes scope/add_project/remove_project/replace_projects/set_global end to end (playbooks-add-multi-project-applicability-and-prop)", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/playbooks-scope-project-a", name: "Playbooks Scope Project A" });
		await service.execute("tasks.register_project", { project_root: "/tmp/playbooks-scope-project-b", name: "Playbooks Scope Project B" });
		const created = (await registry.invoke("playbooks.create", 1, { title: "Scope surface playbook" }, PERMS)) as { id: string };

		expect(await registry.invoke("playbooks.scope", 1, { id: created.id }, PERMS)).toEqual({
			artifactId: created.id,
			mode: "all",
			members: [],
			source: "unscoped",
		});

		const afterAdd = (await registry.invoke(
			"playbooks.add_project",
			1,
			{ id: created.id, project: "Playbooks Scope Project A" },
			PERMS,
		)) as { mode: string; members: Array<{ type: string; id: string }> };
		expect(afterAdd.mode).toBe("explicit");
		expect(afterAdd.members).toHaveLength(1);

		const afterAddSecond = (await registry.invoke(
			"playbooks.add_project",
			1,
			{ id: created.id, project: "Playbooks Scope Project B" },
			PERMS,
		)) as { members: Array<{ type: string; id: string }> };
		expect(afterAddSecond.members).toHaveLength(2);

		const afterRemove = (await registry.invoke(
			"playbooks.remove_project",
			1,
			{ id: created.id, project: "Playbooks Scope Project B" },
			PERMS,
		)) as { members: Array<{ type: string; id: string }> };
		expect(afterRemove.members).toHaveLength(1);

		const afterReplace = (await registry.invoke(
			"playbooks.replace_projects",
			1,
			{ id: created.id, projects: ["Playbooks Scope Project A", "Playbooks Scope Project B"] },
			PERMS,
		)) as { members: Array<{ type: string; id: string }> };
		expect(afterReplace.members).toHaveLength(2);

		const afterGlobal = (await registry.invoke("playbooks.set_global", 1, { id: created.id }, PERMS)) as {
			artifactId: string;
			mode: string;
			members: Array<{ type: string; id: string }>;
			source: string;
		};
		expect(afterGlobal).toEqual({ artifactId: created.id, mode: "all", members: [], source: "explicit" });
		service.close();
	});

	it("rejects removing an active Playbook's last project membership -- set_global must be called explicitly instead of accidentally broadening scope", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", {
			project_root: "/tmp/playbooks-last-membership-project",
			name: "Playbooks Last Membership Project",
		});
		const created = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "Last membership playbook", projects: ["Playbooks Last Membership Project"] },
			PERMS,
		)) as { id: string };

		await expect(
			registry.invoke("playbooks.remove_project", 1, { id: created.id, project: "Playbooks Last Membership Project" }, PERMS),
		).rejects.toThrow(/set_global|last|only remaining|non-empty/i);

		const madeGlobal = (await registry.invoke("playbooks.set_global", 1, { id: created.id }, PERMS)) as { mode: string };
		expect(madeGlobal.mode).toBe("all");
		service.close();
	});

	it("playbooks.list applicable:true returns global Playbooks plus Playbooks scoped to that project, distinct from project_root's exact-membership default -- this is what pi-papyrus's before_agent_start now uses instead of every active Playbook unscoped", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/playbooks-applicable-a", name: "Playbooks Applicable A" });
		await service.execute("tasks.register_project", { project_root: "/tmp/playbooks-applicable-b", name: "Playbooks Applicable B" });

		const scopedToA = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "Scoped to A", projects: ["Playbooks Applicable A"] },
			PERMS,
		)) as { id: string };
		const scopedToB = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "Scoped to B", projects: ["Playbooks Applicable B"] },
			PERMS,
		)) as { id: string };
		const global = (await registry.invoke("playbooks.create", 1, { title: "Global playbook" }, PERMS)) as { id: string };

		const exactMembership = (await registry.invoke(
			"playbooks.list",
			1,
			{ project_root: "/tmp/playbooks-applicable-a", full: true },
			PERMS,
		)) as Array<{ id: string }>;
		expect(exactMembership.map((row) => row.id)).toEqual([scopedToA.id]);

		const applicable = (await registry.invoke(
			"playbooks.list",
			1,
			{ project_root: "/tmp/playbooks-applicable-a", applicable: true, full: true },
			PERMS,
		)) as Array<{ id: string }>;
		const applicableIds = applicable.map((row) => row.id).sort();
		expect(applicableIds).toContain(scopedToA.id);
		expect(applicableIds).toContain(global.id);
		expect(applicableIds).not.toContain(scopedToB.id);
		service.close();
	});

	it("playbooks.list rejects applicable:true without project_root", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("playbooks.list", 1, { applicable: true }, PERMS)).rejects.toThrow(/applicable requires project_root/);
		service.close();
	});

	it("invocation destination is not conflated with definition scope: an unscoped/global Playbook can still be invoked with an explicit destination project_root for its generated Tasks/Docs/Rules", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", {
			project_root: "/tmp/playbooks-invoke-destination",
			name: "Playbooks Invoke Destination",
		});
		const playbook = (await registry.invoke(
			"playbooks.create",
			1,
			{ title: "Destination playbook", steps: [{ kind: "doc", title: "Generated doc" }, "Plain step"] },
			PERMS,
		)) as { id: string };
		// The Playbook DEFINITION itself stays global/unscoped -- invoking it with a destination
		// project_root is a per-invocation concern, never a mutation of the definition's own scope.
		const definitionScope = (await registry.invoke("playbooks.scope", 1, { id: playbook.id }, PERMS)) as { mode: string };
		expect(definitionScope.mode).toBe("all");

		const invocation = (await registry.invoke(
			"playbooks.invoke",
			1,
			{ id: playbook.id, project_root: "/tmp/playbooks-invoke-destination" },
			PERMS,
		)) as { created: { docs: string[] } };
		expect(invocation.created.docs).toHaveLength(1);
		const generatedDocScope = (await service.execute("docs.scope", { id: invocation.created.docs[0] })) as {
			mode: string;
			members: Array<{ type: string; id: string }>;
		};
		expect(generatedDocScope.mode).toBe("explicit");
		expect(generatedDocScope.members).toHaveLength(1);

		// The definition itself is unaffected by the invocation's own destination.
		const definitionScopeAfter = (await registry.invoke("playbooks.scope", 1, { id: playbook.id }, PERMS)) as { mode: string };
		expect(definitionScopeAfter.mode).toBe("all");
		service.close();
	});
});
