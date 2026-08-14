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
		const names = registry
			.manifest()
			.operations.map((op: VehicleManifestOperation) => op.name)
			.filter((name: string) => name.startsWith("docs."))
			.sort();
		expect(names).toEqual([
			"docs.activate",
			"docs.add_group",
			"docs.add_project",
			"docs.archive",
			"docs.assign_project",
			"docs.create",
			"docs.link",
			"docs.list",
			"docs.remove_group",
			"docs.remove_project",
			"docs.reopen",
			"docs.replace_groups",
			"docs.replace_projects",
			"docs.scope",
			"docs.set_global",
			"docs.set_none",
			"docs.show",
			"docs.update",
		]);
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("docs.list", 1, {})).rejects.toThrow(/requires permissions/);
		service.close();
	});

	it("creates a doc (draft by default) and lists it by project", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("docs.create", 1, { title: "Architecture overview", project_root: PROJECT }, PERMS)) as {
			id: string;
			title: string;
			status: string;
		};
		expect(created.title).toBe("Architecture overview");
		expect(created.status).toBe("draft");

		const rows = (await registry.invoke("docs.list", 1, { project_root: PROJECT }, PERMS)) as Array<{ id: string }>;
		expect(rows.map((row) => row.id)).toContain(created.id);
		service.close();
	});

	it("list returns a lean summary by default -- no body/extra", async () => {
		const { registry, service } = harness();
		await registry.invoke("docs.create", 1, { title: "Big Doc", body: "a".repeat(2000), project_root: PROJECT }, PERMS);

		const rows = (await registry.invoke("docs.list", 1, { project_root: PROJECT }, PERMS)) as Array<Record<string, unknown>>;
		const row = rows.find((candidate) => candidate.title === "Big Doc")!;
		expect(row.id).toBeDefined();
		expect(row.title).toBe("Big Doc");
		expect(row.status).toBeDefined();
		expect(row.body).toBeUndefined();
		expect(row.extra).toBeUndefined();
		service.close();
	});

	it("list returns the full artifact, including body, when full: true is passed", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"docs.create",
			1,
			{ title: "Full Doc", body: "real body text", project_root: PROJECT },
			PERMS,
		)) as { id: string };

		const rows = (await registry.invoke("docs.list", 1, { project_root: PROJECT, full: true }, PERMS)) as Array<Record<string, unknown>>;
		const row = rows.find((candidate) => candidate.id === created.id)!;
		expect(row.body).toBe("real body text");
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

	it("resolves a doc by alias with zero ambiguity, even when another doc's title would otherwise fuzzy-match the same string", async () => {
		const { registry, service } = harness();
		const target = (await registry.invoke("docs.create", 1, { title: "Storage schema", project_root: PROJECT }, PERMS)) as {
			id: string;
			alias: string;
		};
		await registry.invoke("docs.create", 1, { title: target.alias, project_root: PROJECT }, PERMS);
		const shown = await registry.invoke("docs.show", 1, { name: target.alias }, PERMS);
		expect((shown as { id: string }).id).toBe(target.id);
		service.close();
	});

	it("activate/archive/reopen walk the full doc lifecycle", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("docs.create", 1, { title: "Lifecycle doc", project_root: PROJECT }, PERMS)) as {
			id: string;
			status: string;
		};
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
		const _rule = (await service.execute("rules.create", { title: "Follow the research notes", project_root: PROJECT })) as { id: string };

		const linked = (await registry.invoke(
			"docs.link",
			1,
			{ name: "Research notes", relation: "references", target_name: "Follow the research notes" },
			PERMS,
		)) as { id: string };
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

	it("create accepts bounded projectReferences (multi-project at creation), taking precedence over project_root", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/docs-create-scope-a", name: "Docs Create Scope A" });
		await service.execute("tasks.register_project", { project_root: "/tmp/docs-create-scope-b", name: "Docs Create Scope B" });
		const created = (await registry.invoke(
			"docs.create",
			1,
			{ title: "Multi-scoped doc", project_root: PROJECT, projects: ["Docs Create Scope A", "Docs Create Scope B"] },
			PERMS,
		)) as { id: string };
		const scope = (await registry.invoke("docs.scope", 1, { id: created.id }, PERMS)) as {
			mode: string;
			members: Array<{ type: string; id: string }>;
		};
		expect(scope.mode).toBe("explicit");
		expect(scope.members).toHaveLength(2);
		service.close();
	});

	it("exposes scope/add_project/remove_project/replace_projects/set_global end to end (docs-add-bounded-multi-project-membership-and-fail)", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/docs-scope-project-a", name: "Docs Scope Project A" });
		await service.execute("tasks.register_project", { project_root: "/tmp/docs-scope-project-b", name: "Docs Scope Project B" });
		const created = (await registry.invoke("docs.create", 1, { title: "Scope surface doc" }, PERMS)) as { id: string };

		expect(await registry.invoke("docs.scope", 1, { id: created.id }, PERMS)).toEqual({
			artifactId: created.id,
			mode: "all",
			members: [],
			source: "unscoped",
		});

		const afterAdd = (await registry.invoke("docs.add_project", 1, { id: created.id, project: "Docs Scope Project A" }, PERMS)) as {
			mode: string;
			members: Array<{ type: string; id: string }>;
		};
		expect(afterAdd.mode).toBe("explicit");
		expect(afterAdd.members).toHaveLength(1);

		// Idempotent: adding an already-present project is a no-op, not a duplicate or an error.
		const afterDuplicateAdd = (await registry.invoke(
			"docs.add_project",
			1,
			{ id: created.id, project: "Docs Scope Project A" },
			PERMS,
		)) as {
			members: Array<{ type: string; id: string }>;
		};
		expect(afterDuplicateAdd.members).toHaveLength(1);

		const afterAddSecond = (await registry.invoke("docs.add_project", 1, { id: created.id, project: "Docs Scope Project B" }, PERMS)) as {
			members: Array<{ type: string; id: string }>;
		};
		expect(afterAddSecond.members).toHaveLength(2);

		const afterRemove = (await registry.invoke("docs.remove_project", 1, { id: created.id, project: "Docs Scope Project B" }, PERMS)) as {
			members: Array<{ type: string; id: string }>;
		};
		expect(afterRemove.members).toHaveLength(1);

		const afterReplace = (await registry.invoke(
			"docs.replace_projects",
			1,
			{ id: created.id, projects: ["Docs Scope Project A", "Docs Scope Project B"] },
			PERMS,
		)) as { members: Array<{ type: string; id: string }> };
		expect(afterReplace.members).toHaveLength(2);

		const afterGlobal = (await registry.invoke("docs.set_global", 1, { id: created.id }, PERMS)) as {
			artifactId: string;
			mode: string;
			members: Array<{ type: string; id: string }>;
			source: string;
		};
		expect(afterGlobal).toEqual({ artifactId: created.id, mode: "all", members: [], source: "explicit" });
		service.close();
	});

	it("rejects removing an active Doc's last project membership -- set_global must be called explicitly instead of accidentally broadening scope", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", {
			project_root: "/tmp/docs-last-membership-project",
			name: "Docs Last Membership Project",
		});
		const created = (await registry.invoke(
			"docs.create",
			1,
			{ title: "Last membership doc", projects: ["Docs Last Membership Project"] },
			PERMS,
		)) as { id: string };

		await expect(
			registry.invoke("docs.remove_project", 1, { id: created.id, project: "Docs Last Membership Project" }, PERMS),
		).rejects.toThrow(/set_global|last|only remaining|non-empty/i);

		const madeGlobal = (await registry.invoke("docs.set_global", 1, { id: created.id }, PERMS)) as { mode: string };
		expect(madeGlobal.mode).toBe("all");
		service.close();
	});

	it("never widens a name-based docs.* mutation across projects -- a same-named Doc in a different project is invisible, but the searching project's own scoped or global Doc still resolves", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/docs-widen-project-a", name: "Docs Widen Project A" });
		await service.execute("tasks.register_project", { project_root: "/tmp/docs-widen-project-b", name: "Docs Widen Project B" });

		const docInA = (await registry.invoke(
			"docs.create",
			1,
			{ title: "Shared Doc Name", body: "Belongs to A", projects: ["Docs Widen Project A"] },
			PERMS,
		)) as { id: string };
		const docInB = (await registry.invoke(
			"docs.create",
			1,
			{ title: "Shared Doc Name", body: "Belongs to B", projects: ["Docs Widen Project B"] },
			PERMS,
		)) as { id: string };

		// Resolving "Shared Doc Name" from project B's context must hit B's own doc, never A's --
		// even though A's scoped search comes up empty first and used to widen to every project.
		const shownFromB = (await registry.invoke(
			"docs.show",
			1,
			{ name: "Shared Doc Name", project_root: "/tmp/docs-widen-project-b" },
			PERMS,
		)) as { id: string };
		expect(shownFromB.id).toBe(docInB.id);
		expect(shownFromB.id).not.toBe(docInA.id);

		const globalDoc = (await registry.invoke("docs.create", 1, { title: "Global Shared Doc Name", body: "Applies everywhere" }, PERMS)) as {
			id: string;
		};
		// A global doc is still found via the widen fallback even when a project_root is given and
		// nothing is scoped to that project under this name -- widening to "applies here" is fine;
		// widening to "some other project entirely" is the bug this guards against.
		const shownGlobal = (await registry.invoke(
			"docs.show",
			1,
			{ name: "Global Shared Doc Name", project_root: "/tmp/docs-widen-project-a" },
			PERMS,
		)) as { id: string };
		expect(shownGlobal.id).toBe(globalDoc.id);
		service.close();
	});

	it("docs.list applicable:true returns global Docs plus Docs scoped to that project, distinct from project_root's exact-membership default", async () => {
		const { registry, service } = harness();
		await service.execute("tasks.register_project", { project_root: "/tmp/docs-applicable-a", name: "Docs Applicable A" });
		await service.execute("tasks.register_project", { project_root: "/tmp/docs-applicable-b", name: "Docs Applicable B" });

		const scopedToA = (await registry.invoke("docs.create", 1, { title: "Scoped to A", projects: ["Docs Applicable A"] }, PERMS)) as {
			id: string;
		};
		const scopedToB = (await registry.invoke("docs.create", 1, { title: "Scoped to B", projects: ["Docs Applicable B"] }, PERMS)) as {
			id: string;
		};
		const global = (await registry.invoke("docs.create", 1, { title: "Global doc" }, PERMS)) as { id: string };

		const exactMembership = (await registry.invoke(
			"docs.list",
			1,
			{ project_root: "/tmp/docs-applicable-a", full: true },
			PERMS,
		)) as Array<{ id: string }>;
		expect(exactMembership.map((row) => row.id)).toEqual([scopedToA.id]);

		const applicable = (await registry.invoke(
			"docs.list",
			1,
			{ project_root: "/tmp/docs-applicable-a", applicable: true, full: true },
			PERMS,
		)) as Array<{ id: string }>;
		const applicableIds = applicable.map((row) => row.id).sort();
		expect(applicableIds).toContain(scopedToA.id);
		expect(applicableIds).toContain(global.id);
		expect(applicableIds).not.toContain(scopedToB.id);
		service.close();
	});

	it("docs.list rejects applicable:true without project_root", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("docs.list", 1, { applicable: true }, PERMS)).rejects.toThrow(/applicable requires project_root/);
		service.close();
	});

	it("every new docs scope mutation rejects Note subtype -- Notes stay behind notes.*", async () => {
		const { registry, service } = harness();
		const note = (await service.execute("notes.capture", { body: "a captured note", project_root: PROJECT })) as { id: string };

		await expect(registry.invoke("docs.scope", 1, { id: note.id }, PERMS)).rejects.toThrow(/note access requires a notes/);
		await expect(registry.invoke("docs.set_global", 1, { id: note.id }, PERMS)).rejects.toThrow(/note access requires a notes/);
		await expect(registry.invoke("docs.add_project", 1, { id: note.id, project: "anything" }, PERMS)).rejects.toThrow(
			/note access requires a notes/,
		);
		await expect(registry.invoke("docs.remove_project", 1, { id: note.id, project: "anything" }, PERMS)).rejects.toThrow(
			/note access requires a notes/,
		);
		await expect(registry.invoke("docs.replace_projects", 1, { id: note.id, projects: ["anything"] }, PERMS)).rejects.toThrow(
			/note access requires a notes/,
		);
		service.close();
	});
});
