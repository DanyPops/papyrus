import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/adapters/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteTaskEventStore } from "../src/adapters/sqlite-task-event-store.ts";
import { SQLiteTaskScopeStore } from "../src/adapters/sqlite-task-scope-store.ts";
import { openDb } from "../src/db.ts";
import { AuthorityRegistry } from "../src/authority-registry.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { docsOperations } from "../src/modules/docs.ts";
import { rulesOperations } from "../src/modules/rules.ts";
import { skillsOperations } from "../src/modules/skills.ts";
import { EXPECTED_OPERATION_NAMES } from "../src/service.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const events = new SQLiteTaskEventStore(db);
	const scopes = new SQLiteTaskScopeStore(db);
	const artifactScopes = new SQLiteArtifactScopeStore(db);
	const authority = new AuthorityRegistry();
	const registry = new OperationRegistry();
	registry.registerAll(docsOperations(artifacts, artifactScopes, authority));
	registry.registerAll(rulesOperations(artifacts, artifactScopes));
	registry.registerAll(skillsOperations({ artifacts, events, scopes, artifactScopes, authority }));
	return { registry, artifacts };
}

describe("modules/docs — a Papyrus-native registered module", () => {
	it("registers exactly the docs.* operations EXPECTED_OPERATION_NAMES declares", () => {
		const { registry } = fixture();
		const expected = EXPECTED_OPERATION_NAMES.filter((name) => name.startsWith("docs."));
		const registered = registry.list().filter((name) => name.startsWith("docs."));
		expect(registered).toEqual([...expected].sort());
	});

	it("delegates create/show/lifecycle to the same field mapping as the prior inline handlers", async () => {
		const { registry } = fixture();
		const created = await registry.get("docs.create")!.execute({ title: "Design note" }) as { id: string; status: string };
		expect(created.status).toBe("draft");
		const activated = await registry.get("docs.activate")!.execute({ id: created.id }) as { status: string };
		expect(activated.status).toBe("active");
		const shown = await registry.get("docs.show")!.execute({ id: created.id }) as { id: string };
		expect(shown.id).toBe(created.id);
	});
});

describe("modules/rules — a Papyrus-native registered module (excluding rules.injectable)", () => {
	it("registers exactly the rules.* operations EXPECTED_OPERATION_NAMES declares, except the documented rules.injectable exception", () => {
		const { registry } = fixture();
		const expected = EXPECTED_OPERATION_NAMES.filter((name) => name.startsWith("rules.") && name !== "rules.injectable");
		const registered = registry.list().filter((name) => name.startsWith("rules."));
		expect(registered).toEqual([...expected].sort());
		expect(registry.has("rules.injectable")).toBe(false);
	});

	it("delegates create/gate to the same field mapping as the prior inline handlers", async () => {
		const { registry, artifacts } = fixture();
		const task = artifacts.create({ kind: "task", title: "Gated task", extra: { projectRoot: "/x" } });
		const rule = await registry.get("rules.create")!.execute({ title: "A rule" }) as { id: string };
		const gated = await registry.get("rules.gate")!.execute({ id: rule.id, task_id: task.id }) as { id: string };
		expect(gated.id).toBe(rule.id);
	});
});

describe("modules/skills — a Papyrus-native registered module (excluding skills.instantiate)", () => {
	it("registers exactly the skills.* operations EXPECTED_OPERATION_NAMES declares, except the documented skills.instantiate exception", () => {
		const { registry } = fixture();
		const expected = EXPECTED_OPERATION_NAMES.filter((name) => name.startsWith("skills.") && name !== "skills.instantiate");
		const registered = registry.list().filter((name) => name.startsWith("skills."));
		expect(registered).toEqual([...expected].sort());
		expect(registry.has("skills.instantiate")).toBe(false);
	});

	it("delegates create/show to the same field mapping as the prior inline handlers", async () => {
		const { registry } = fixture();
		const created = await registry.get("skills.create")!.execute({ title: "A skill", trigger: "manual" }) as { id: string };
		const shown = await registry.get("skills.show")!.execute({ id: created.id }) as { id: string };
		expect(shown.id).toBe(created.id);
	});
});
