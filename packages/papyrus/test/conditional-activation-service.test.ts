import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/workspace/papyrus";

function fixture() {
	const service = createPapyrusService(join(tempDir("papyrus-activation-"), "papyrus.db"));
	return { service };
}

describe("conditional artifact activation", () => {
	test("rules.injectable evaluates typed predicates and fails closed when context is absent", async () => {
		const { service } = fixture();
		const rule = (await service.execute("rules.create", {
			title: "TypeScript safety",
			rule_action: "Run the TypeScript checks",
			activation: {
				predicate: { field: "languages", operator: "contains_any", value: ["typescript"] },
				priority: 20,
			},
		})) as { id: string };

		expect(await service.execute("rules.injectable", { project_root: PROJECT })).toEqual([]);
		expect(
			(
				(await service.execute("rules.injectable", {
					project_root: PROJECT,
					activation_context: { languages: ["typescript"] },
				})) as Array<{ id: string }>
			).map((artifact) => artifact.id),
		).toEqual([rule.id]);
		service.close();
	});

	test("playbooks.list activated applies both project scope and activation predicates", async () => {
		const { service } = fixture();
		const playbook = (await service.execute("playbooks.create", {
			title: "Rust audit",
			trigger: "editing Rust",
			activation: {
				predicate: { field: "languages", operator: "contains_any", value: ["rust"] },
				injection: "catalog",
			},
		})) as { id: string };

		expect(
			await service.execute("playbooks.list", {
				status: "active",
				project_root: PROJECT,
				applicable: true,
				activated: true,
				activation_context: { languages: ["typescript"] },
			}),
		).toEqual([]);
		expect(
			(
				(await service.execute("playbooks.list", {
					status: "active",
					project_root: PROJECT,
					applicable: true,
					activated: true,
					activation_context: { languages: ["rust"] },
				})) as Array<{ id: string }>
			).map((artifact) => artifact.id),
		).toEqual([playbook.id]);
		service.close();
	});

	test("activation.audit explains enabled and disabled decisions across Rules and Playbooks", async () => {
		const { service } = fixture();
		await service.execute("rules.create", { title: "Always", rule_action: "A" });
		await service.execute("playbooks.create", {
			title: "Rust only",
			activation: { predicate: { field: "languages", operator: "contains_any", value: ["rust"] } },
		});
		const audit = (await service.execute("activation.audit", {
			project_root: PROJECT,
			activation_context: { languages: ["typescript"] },
		})) as {
			summary: { total: number; enabled: number; disabled: number; global: number };
			entries: Array<{ title: string; enabled: boolean; reason: string }>;
		};
		expect(audit.summary).toMatchObject({ total: 2, enabled: 1, disabled: 1, global: 2 });
		expect(audit.entries.find((entry) => entry.title === "Rust only")).toMatchObject({
			enabled: false,
			reason: "activation languages did not match contains_any",
		});
		service.close();
	});

	test("remembers the manual flag and bridges normalized artifact labels to the active Task", async () => {
		const { service } = fixture();
		const rule = (await service.execute("rules.create", {
			title: "Security review",
			rule_action: "Review security-sensitive work",
			labels: [" Security "],
			activation: { labels: "any", priority: 10 },
		})) as { id: string };
		const task = (await service.execute("tasks.create", {
			title: "Audit authentication",
			labels: ["security"],
			project_root: PROJECT,
		})) as { id: string };
		await service.execute("tasks.focus", { id: task.id });

		expect(
			((await service.execute("rules.injectable", { project_root: PROJECT })) as Array<{ id: string }>).map((entry) => entry.id),
		).toEqual([rule.id]);
		const paused = (await service.execute("rules.update", { id: rule.id, activation_enabled: false })) as {
			extra: { activation: { enabled: boolean; labels: string; priority: number } };
		};
		expect(paused.extra.activation).toMatchObject({ enabled: false, labels: "any", priority: 10 });
		expect(await service.execute("rules.injectable", { project_root: PROJECT })).toEqual([]);
		const audit = (await service.execute("activation.audit", { project_root: PROJECT })) as {
			entries: Array<{ id: string; reason: string }>;
		};
		expect(audit.entries.find((entry) => entry.id === rule.id)?.reason).toBe("activation flag is disabled");
		await service.execute("rules.update", { id: rule.id, activation_enabled: true });
		expect(
			((await service.execute("rules.injectable", { project_root: PROJECT })) as Array<{ id: string }>).map((entry) => entry.id),
		).toEqual([rule.id]);
		service.close();
	});

	test("create and update reject malformed predicates before writing", async () => {
		const { service } = fixture();
		await expect(
			service.execute("rules.create", {
				title: "Invalid",
				activation: { predicate: { field: "cwd", operator: "eq", value: "x" } },
			}),
		).rejects.toThrow(/unsupported activation field/);
		const playbook = (await service.execute("playbooks.create", { title: "Conditional" })) as { id: string };
		await expect(
			service.execute("playbooks.update", {
				id: playbook.id,
				activation: { predicate: { field: "project.root", operator: "matches", value: ".*" } },
			}),
		).rejects.toThrow(/unsupported activation operator/);
		service.close();
	});
});
