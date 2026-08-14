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
			"rules.add_group",
			"rules.add_project",
			"rules.assign_project",
			"rules.create",
			"rules.disable",
			"rules.enable",
			"rules.gate",
			"rules.list",
			"rules.preview",
			"rules.remove_group",
			"rules.remove_project",
			"rules.replace_groups",
			"rules.replace_projects",
			"rules.scope",
			"rules.set_global",
			"rules.set_none",
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

	it("accepts subtype and template_id, the same create-time surface docs.create already exposes (papyrus-defect-unify-template-subtype-53b3a1eb)", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("rules.create", 1, { title: "Security rule", subtype: "security" }, PERMS)) as {
			subtype: string;
		};
		expect(created.subtype).toBe("security");
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

	it("list returns a lean summary by default -- no body/extra (condition/action live in extra)", async () => {
		const { registry, service } = harness();
		await registry.invoke(
			"rules.create",
			1,
			{ title: "Big Rule", condition: "a".repeat(100), rule_action: "a".repeat(100), project_root: PROJECT },
			PERMS,
		);

		const rows = (await registry.invoke("rules.list", 1, { project_root: PROJECT }, PERMS)) as Array<Record<string, unknown>>;
		const row = rows.find((candidate) => candidate.title === "Big Rule")!;
		expect(row.id).toBeDefined();
		expect(row.title).toBe("Big Rule");
		expect(row.status).toBeDefined();
		expect(row.extra).toBeUndefined();
		service.close();
	});

	it("list returns the full artifact, including extra.condition/action, when full: true is passed", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"rules.create",
			1,
			{ title: "Full Rule", condition: "when X", rule_action: "do Y", project_root: PROJECT },
			PERMS,
		)) as { id: string };

		const rows = (await registry.invoke("rules.list", 1, { project_root: PROJECT, full: true }, PERMS)) as Array<Record<string, unknown>>;
		const row = rows.find((candidate) => candidate.id === created.id)!;
		expect((row.extra as { condition?: string }).condition).toBe("when X");
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

	it("enable/disable transition a rule's status -- plain rules default to active on create", async () => {
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

	it("creates a template-derived Rule as draft and refuses rules.enable until completionRequired fields are present", async () => {
		const { registry, service } = harness();
		const template = (await service.execute("artifact.create", {
			kind: "rule",
			subtype: "artifact-template",
			title: "Complete rule template",
			extra: { targetKind: "rule", completionRequired: ["body"] },
		})) as { id: string };
		const created = (await registry.invoke(
			"rules.create",
			1,
			{ title: "Draft policy", template_id: template.id, project_root: PROJECT },
			PERMS,
		)) as { id: string; status: string };
		expect(created.status).toBe("draft");
		await expect(registry.invoke("rules.enable", 1, { id: created.id }, PERMS)).rejects.toThrow(/completion-required field "body"/);

		await registry.invoke("rules.update", 1, { id: created.id, body: "Run the complete verification suite." }, PERMS);
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

	it("create/update/show carry combinedLength, with a warning only once it exceeds the 600-character soft target", async () => {
		const { registry, service } = harness();
		const small = (await registry.invoke(
			"rules.create",
			1,
			{ title: "Small", condition: "before commit", rule_action: "Run tests", project_root: PROJECT },
			PERMS,
		)) as { combinedLength: number; warning?: string };
		expect(small.combinedLength).toBe("before commit".length + "Run tests".length);
		expect(small.warning).toBeUndefined();

		const big = (await registry.invoke(
			"rules.create",
			1,
			{ title: "Big", condition: "x".repeat(400), rule_action: "y".repeat(400), project_root: PROJECT },
			PERMS,
		)) as { id: string; combinedLength: number; warning?: string };
		expect(big.combinedLength).toBe(800);
		expect(big.warning).toContain("800 characters");
		expect(big.warning).toContain("600-character soft target");

		const shown = (await registry.invoke("rules.show", 1, { id: big.id }, PERMS)) as { combinedLength: number; warning?: string };
		expect(shown.combinedLength).toBe(800);
		expect(shown.warning).toContain("600-character soft target");

		const updated = (await registry.invoke("rules.update", 1, { id: big.id, title: "Big v2" }, PERMS)) as {
			combinedLength: number;
			warning?: string;
		};
		expect(updated.combinedLength).toBe(800);
		expect(updated.warning).toContain("600-character soft target");
		service.close();
	});

	it("preview returns { preview, combinedLength, warning? } instead of a bare string", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"rules.create",
			1,
			{ title: "Test before commit", condition: "before commit", rule_action: "Run bun test", project_root: PROJECT },
			PERMS,
		)) as { id: string };

		const preview = (await registry.invoke("rules.preview", 1, { id: created.id }, PERMS)) as {
			preview: string;
			combinedLength: number;
			warning?: string;
		};
		expect(preview.preview).toContain("before commit");
		expect(preview.preview).toContain("Run bun test");
		expect(preview.combinedLength).toBe("before commit".length + "Run bun test".length);
		expect(preview.warning).toBeUndefined();
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

	it("exposes scope/add_project/remove_project/replace_projects/set_global end to end (rules-enforce-global-or-multi-project-applicabilit)", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/scope-project-a", name: "Scope Project A" });
		await service.execute("tasks.register_project", { project_root: "/tmp/scope-project-b", name: "Scope Project B" });
		const created = (await registry.invoke("rules.create", 1, { title: "Scope surface rule" }, PERMS)) as { id: string };

		expect(await registry.invoke("rules.scope", 1, { id: created.id }, PERMS)).toEqual({
			artifactId: created.id,
			mode: "all",
			members: [],
			source: "unscoped",
		});

		const afterAdd = (await registry.invoke("rules.add_project", 1, { id: created.id, project: "Scope Project A" }, PERMS)) as {
			mode: string;
			members: Array<{ type: string; id: string }>;
		};
		expect(afterAdd.mode).toBe("explicit");
		expect(afterAdd.members).toHaveLength(1);

		const afterAddSecond = (await registry.invoke("rules.add_project", 1, { id: created.id, project: "Scope Project B" }, PERMS)) as {
			members: Array<{ type: string; id: string }>;
		};
		expect(afterAddSecond.members).toHaveLength(2);

		const afterRemove = (await registry.invoke("rules.remove_project", 1, { id: created.id, project: "Scope Project B" }, PERMS)) as {
			members: Array<{ type: string; id: string }>;
		};
		expect(afterRemove.members).toHaveLength(1);

		const afterReplace = (await registry.invoke(
			"rules.replace_projects",
			1,
			{ id: created.id, projects: ["Scope Project A", "Scope Project B"] },
			PERMS,
		)) as { members: Array<{ type: string; id: string }> };
		expect(afterReplace.members).toHaveLength(2);

		const afterGlobal = (await registry.invoke("rules.set_global", 1, { id: created.id }, PERMS)) as {
			artifactId: string;
			mode: string;
			members: Array<{ type: string; id: string }>;
			source: string;
		};
		expect(afterGlobal).toEqual({ artifactId: created.id, mode: "all", members: [], source: "explicit" });
		service.close();
	});

	it("rejects removing an active Rule's last project membership -- set_global must be called explicitly instead of accidentally broadening scope", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/last-membership-project", name: "Last Membership Project" });
		const created = (await registry.invoke(
			"rules.create",
			1,
			{ title: "Last membership rule", projects: ["Last Membership Project"] },
			PERMS,
		)) as { id: string };

		await expect(registry.invoke("rules.remove_project", 1, { id: created.id, project: "Last Membership Project" }, PERMS)).rejects.toThrow(
			/set_global|last|only remaining|non-empty/i,
		);

		const madeGlobal = (await registry.invoke("rules.set_global", 1, { id: created.id }, PERMS)) as { mode: string };
		expect(madeGlobal.mode).toBe("all");
		service.close();
	});

	it("never widens a name-based rules.* mutation across projects -- a same-named Rule in a different project is invisible, but the searching project's own scoped or global Rule still resolves", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/widen-project-a", name: "Widen Project A" });
		await service.execute("tasks.register_project", { project_root: "/tmp/widen-project-b", name: "Widen Project B" });

		const ruleInA = (await registry.invoke(
			"rules.create",
			1,
			{ title: "Shared Name", body: "Belongs to A", projects: ["Widen Project A"] },
			PERMS,
		)) as { id: string };
		const ruleInB = (await registry.invoke(
			"rules.create",
			1,
			{ title: "Shared Name", body: "Belongs to B", projects: ["Widen Project B"] },
			PERMS,
		)) as { id: string };

		// Resolving "Shared Name" from project B's context must hit B's own rule, never A's --
		// even though A's scoped search comes up empty first and used to widen to every project.
		const shownFromB = (await registry.invoke("rules.show", 1, { name: "Shared Name", project_root: "/tmp/widen-project-b" }, PERMS)) as {
			id: string;
		};
		expect(shownFromB.id).toBe(ruleInB.id);
		expect(shownFromB.id).not.toBe(ruleInA.id);

		const globalRule = (await registry.invoke("rules.create", 1, { title: "Global Shared Name", body: "Applies everywhere" }, PERMS)) as {
			id: string;
		};
		// A global rule is still found via the widen fallback even when a project_root is given and
		// nothing is scoped to that project under this name -- widening to "applies here" is fine;
		// widening to "some other project entirely" is the bug this guards against.
		const shownGlobal = (await registry.invoke(
			"rules.show",
			1,
			{ name: "Global Shared Name", project_root: "/tmp/widen-project-a" },
			PERMS,
		)) as { id: string };
		expect(shownGlobal.id).toBe(globalRule.id);
		service.close();
	});
});
