import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

describe("activation Vehicle operation", () => {
	test("persists activation flags through Rule and Playbook Vehicle schemas", async () => {
		const service = createPapyrusService(join(tempDir("papyrus-activation-flag-vehicle-"), "papyrus.db"));
		const rule = (await service.execute("rules.create", { title: "Rule", rule_action: "A" })) as { id: string };
		const playbook = (await service.execute("playbooks.create", { title: "Playbook" })) as { id: string };
		const ruleResult = (await service.vehicle.invoke(
			"rules.update",
			1,
			{ id: rule.id, activation_enabled: false },
			{ permissions: ["rules:read", "rules:write"] },
		)) as { extra: { activation: { enabled: boolean } } };
		const playbookResult = (await service.vehicle.invoke(
			"playbooks.update",
			1,
			{ id: playbook.id, activation_enabled: false },
			{ permissions: ["playbooks:read", "playbooks:write"] },
		)) as { extra: { activation: { enabled: boolean } } };
		expect(ruleResult.extra.activation.enabled).toBe(false);
		expect(playbookResult.extra.activation.enabled).toBe(false);
		service.close();
	});

	test("audits Rule and Playbook decisions through the public Vehicle surface", async () => {
		const service = createPapyrusService(join(tempDir("papyrus-activation-vehicle-"), "papyrus.db"));
		await service.execute("rules.create", { title: "Always", rule_action: "A" });
		await service.execute("playbooks.create", {
			title: "Rust only",
			activation: { predicate: { field: "languages", operator: "contains_any", value: ["rust"] } },
		});
		const result = (await service.vehicle.invoke(
			"activation.audit",
			1,
			{ project_root: "/workspace/papyrus", activation_context: { languages: ["typescript"] } },
			{ permissions: ["rules:read", "playbooks:read"] },
		)) as { summary: { enabled: number; disabled: number }; entries: Array<{ title: string; reason: string }> };
		expect(result.summary).toMatchObject({ enabled: 1, disabled: 1 });
		expect(result.entries.find((entry) => entry.title === "Rust only")?.reason).toBe("activation languages did not match contains_any");
		service.close();
	});
});
