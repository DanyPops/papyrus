/**
 * Real end-to-end coverage of the tri-state (none/all/explicit) scope model plus nested scope
 * groups, through the full Vehicle-registry stack (createPapyrusService), not just the
 * artifact-scope-store.test.ts unit level. Proves the actual user-facing story: a scope group
 * created via scope_groups.*, referenced by a Doc's explicit scope via docs.add_group, correctly
 * makes that Doc applicable to every project reachable through the group -- including
 * transitively through a nested group -- and set_none correctly hides it from every project
 * regardless of membership.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const DOCS_PERMS = { permissions: ["docs:read", "docs:write", "artifact:read", "artifact:write"] };
const SCOPE_GROUPS_PERMS = { permissions: ["scope_groups:read", "scope_groups:write"] };
const TASKS_PERMS = { permissions: ["tasks:read", "tasks:write"] };

function harness() {
	const directory = tempDir("papyrus-scope-groups-e2e-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("scope groups end to end: none/all/explicit tri-state scope with nested groups, through the real Vehicle stack", () => {
	it("a Doc scoped to a group applies to every project reachable through it, including transitively through a nested group", async () => {
		const { registry, service } = harness();
		const projectA = (await registry.invoke(
			"tasks.register_project",
			1,
			{ project_root: "/tmp/scope-e2e-a", name: "Scope E2E A" },
			TASKS_PERMS,
		)) as { id: string };
		const projectB = (await registry.invoke(
			"tasks.register_project",
			1,
			{ project_root: "/tmp/scope-e2e-b", name: "Scope E2E B" },
			TASKS_PERMS,
		)) as { id: string };
		const projectC = (await registry.invoke(
			"tasks.register_project",
			1,
			{ project_root: "/tmp/scope-e2e-c", name: "Scope E2E C" },
			TASKS_PERMS,
		)) as { id: string };
		const unrelatedProject = (await registry.invoke(
			"tasks.register_project",
			1,
			{ project_root: "/tmp/scope-e2e-unrelated", name: "Scope E2E Unrelated" },
			TASKS_PERMS,
		)) as { id: string };

		// Two-level nesting: outerGroup contains projectA directly and innerGroup as a nested member;
		// innerGroup contains projectB and projectC.
		const innerGroup = (await registry.invoke("scope_groups.register", 1, { name: "Inner Group" }, SCOPE_GROUPS_PERMS)) as { id: string };
		await registry.invoke(
			"scope_groups.add_member",
			1,
			{ group: innerGroup.id, member_type: "project", member_reference: projectB.id },
			SCOPE_GROUPS_PERMS,
		);
		await registry.invoke(
			"scope_groups.add_member",
			1,
			{ group: innerGroup.id, member_type: "project", member_reference: projectC.id },
			SCOPE_GROUPS_PERMS,
		);
		const outerGroup = (await registry.invoke("scope_groups.register", 1, { name: "Outer Group" }, SCOPE_GROUPS_PERMS)) as { id: string };
		await registry.invoke(
			"scope_groups.add_member",
			1,
			{ group: outerGroup.id, member_type: "project", member_reference: projectA.id },
			SCOPE_GROUPS_PERMS,
		);
		await registry.invoke(
			"scope_groups.add_member",
			1,
			{ group: outerGroup.id, member_type: "group", member_reference: innerGroup.id },
			SCOPE_GROUPS_PERMS,
		);

		const shown = (await registry.invoke("scope_groups.show", 1, { group: outerGroup.id }, SCOPE_GROUPS_PERMS)) as {
			members: Array<{ type: string; id: string }>;
		};
		expect(shown.members).toEqual(
			expect.arrayContaining([
				{ type: "project", id: projectA.id },
				{ type: "group", id: innerGroup.id },
			]),
		);
		expect(shown.members).toHaveLength(2); // direct membership only -- not expanded through the nested group

		const created = (await registry.invoke("docs.create", 1, { title: "Scoped via nested group" }, DOCS_PERMS)) as { id: string };
		const scope = (await registry.invoke("docs.add_group", 1, { id: created.id, group: outerGroup.id }, DOCS_PERMS)) as {
			mode: string;
			members: Array<{ type: string; id: string }>;
		};
		expect(scope.mode).toBe("explicit");
		expect(scope.members).toEqual([{ type: "group", id: outerGroup.id }]);

		// Applicable to A (direct member) and B/C (through the nested inner group), never to the unrelated project.
		const rootA = "/tmp/scope-e2e-a";
		const rootB = "/tmp/scope-e2e-b";
		const rootC = "/tmp/scope-e2e-c";
		const rootUnrelated = "/tmp/scope-e2e-unrelated";
		for (const root of [rootA, rootB, rootC]) {
			const applicable = (await registry.invoke("docs.list", 1, { applicable: true, project_root: root }, DOCS_PERMS)) as Array<{
				id: string;
			}>;
			expect(applicable.map((doc) => doc.id)).toContain(created.id);
		}
		const applicableUnrelated = (await registry.invoke(
			"docs.list",
			1,
			{ applicable: true, project_root: rootUnrelated },
			DOCS_PERMS,
		)) as Array<{ id: string }>;
		expect(applicableUnrelated.map((doc) => doc.id)).not.toContain(created.id);

		// set_none fully hides it from every project, including ones it was just applicable to.
		const none = (await registry.invoke("docs.set_none", 1, { id: created.id }, DOCS_PERMS)) as {
			artifactId: string;
			mode: string;
			members: unknown[];
			source: string;
		};
		expect(none).toEqual({ artifactId: created.id, mode: "none", members: [], source: "explicit" });
		for (const root of [rootA, rootB, rootC, rootUnrelated]) {
			const applicable = (await registry.invoke("docs.list", 1, { applicable: true, project_root: root }, DOCS_PERMS)) as Array<{
				id: string;
			}>;
			expect(applicable.map((doc) => doc.id)).not.toContain(created.id);
		}

		// Deleting a still-referenced group is refused (the Doc no longer references outerGroup after
		// set_none above, so re-add it first to prove the refusal, then remove it to prove deletion then works).
		await registry.invoke("docs.add_group", 1, { id: created.id, group: outerGroup.id }, DOCS_PERMS);
		await expect(registry.invoke("scope_groups.delete", 1, { group: outerGroup.id }, SCOPE_GROUPS_PERMS)).rejects.toThrow();
		await registry.invoke("docs.set_none", 1, { id: created.id }, DOCS_PERMS);
		const deleted = (await registry.invoke("scope_groups.delete", 1, { group: outerGroup.id }, SCOPE_GROUPS_PERMS)) as {
			deleted: boolean;
		};
		expect(deleted.deleted).toBe(true);

		// A group still nested inside another group is also refused.
		await expect(registry.invoke("scope_groups.delete", 1, { group: innerGroup.id }, SCOPE_GROUPS_PERMS)).resolves.toEqual({
			deleted: true,
			id: innerGroup.id,
		}); // outerGroup (the only thing that referenced innerGroup) was just deleted above, so this now succeeds.

		service.close();
	});

	it("scope_groups.delete refuses while a group is still nested inside another group", async () => {
		const { registry, service } = harness();
		const inner = (await registry.invoke("scope_groups.register", 1, { name: "Still Nested Inner" }, SCOPE_GROUPS_PERMS)) as { id: string };
		const outer = (await registry.invoke("scope_groups.register", 1, { name: "Still Nested Outer" }, SCOPE_GROUPS_PERMS)) as { id: string };
		await registry.invoke(
			"scope_groups.add_member",
			1,
			{ group: outer.id, member_type: "group", member_reference: inner.id },
			SCOPE_GROUPS_PERMS,
		);
		await expect(registry.invoke("scope_groups.delete", 1, { group: inner.id }, SCOPE_GROUPS_PERMS)).rejects.toThrow(
			/still a member of scope group/,
		);
		service.close();
	});

	it("scope_groups.add_member refuses a cycle", async () => {
		const { registry, service } = harness();
		const a = (await registry.invoke("scope_groups.register", 1, { name: "Cycle A" }, SCOPE_GROUPS_PERMS)) as { id: string };
		const b = (await registry.invoke("scope_groups.register", 1, { name: "Cycle B" }, SCOPE_GROUPS_PERMS)) as { id: string };
		await registry.invoke("scope_groups.add_member", 1, { group: a.id, member_type: "group", member_reference: b.id }, SCOPE_GROUPS_PERMS);
		await expect(
			registry.invoke("scope_groups.add_member", 1, { group: b.id, member_type: "group", member_reference: a.id }, SCOPE_GROUPS_PERMS),
		).rejects.toThrow(/cycle/);
		service.close();
	});
});
