import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/adapters/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteTaskEventStore } from "../src/adapters/sqlite-task-event-store.ts";
import { SQLiteTaskFocusStore } from "../src/adapters/sqlite-task-focus-store.ts";
import { SQLiteTaskLeaseStore } from "../src/adapters/sqlite-task-lease-store.ts";
import { SQLiteTaskScopeStore } from "../src/adapters/sqlite-task-scope-store.ts";
import { SQLiteGateRunner } from "../src/adapters/sqlite-gate-runner.ts";
import { openDb } from "../src/db.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { playbooksOperations, PLAYBOOKS_OPERATION_NAMES } from "../src/modules/playbooks.ts";
import { Tasks } from "../src/task-service.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const artifactScopes = new SQLiteArtifactScopeStore(db);
	const events = new SQLiteTaskEventStore(db);
	const scopes = new SQLiteTaskScopeStore(db);
	const tasks = new Tasks(artifacts, new SQLiteGateRunner(db), new SQLiteTaskFocusStore(db), events, scopes, new SQLiteTaskLeaseStore(db));
	const registry = new OperationRegistry();
	registry.registerAll(playbooksOperations({ artifacts, events, scopes, artifactScopes, tasks }));
	return { registry, artifacts, tasks };
}

describe("modules/playbooks — a Papyrus-native registered module, recycling the Skill workflow engine for invoke", () => {
	it("registers exactly the playbooks.* operations PLAYBOOKS_OPERATION_NAMES declares", () => {
		const { registry } = fixture();
		const registered = registry.list().filter((name) => name.startsWith("playbooks."));
		expect(registered).toEqual([...PLAYBOOKS_OPERATION_NAMES].sort());
	});

	it("previews a playbook as rendered text without creating any tasks", async () => {
		const { registry, artifacts } = fixture();
		const created = await registry.get("playbooks.create")!.execute({ title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] }) as { id: string };
		const preview = await registry.get("playbooks.preview")!.execute({ id: created.id }) as string;
		expect(preview).toContain("1. Frame the problem");
		expect(artifacts.query({ kind: "task" })).toHaveLength(0);
	});

	it("invokes a playbook by materializing real tasks and focusing the entry task, not rendering text", async () => {
		const { registry, artifacts, tasks } = fixture();
		const created = await registry.get("playbooks.create")!.execute({ title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] }) as { id: string; kind: string };
		expect(created.kind).toBe("playbook");

		const invocation = await registry.get("playbooks.invoke")!.execute({ id: created.id }) as { entryTaskId: string; created: { tasks: string[] }; rootTaskIds: string[] };
		expect(invocation.created.tasks).toHaveLength(2); // container + one step
		const entry = artifacts.get(invocation.entryTaskId)!;
		expect(entry.kind).toBe("task");
		expect(entry.body).toBe("Frame the problem");
		expect(tasks.active()?.id).toBe(invocation.entryTaskId);

		const updated = await registry.get("playbooks.update")!.execute({ id: created.id, title: "New Project v2" }) as { title: string };
		expect(updated.title).toBe("New Project v2");
		const shown = await registry.get("playbooks.show")!.execute({ id: created.id }) as { id: string };
		expect(shown.id).toBe(created.id);
		const disabled = await registry.get("playbooks.disable")!.execute({ id: created.id }) as { status: string };
		expect(disabled.status).toBe("deprecated");
	});

	it("declares arguments at create; invoke without a required value creates nothing and reports it; invoke with the value substitutes it into the step task", async () => {
		const { registry, artifacts } = fixture();
		const created = await registry.get("playbooks.create")!.execute({
			title: "Deploy service", trigger: "deploying", steps: ["Deploy to {{environment}}"],
			arguments: [{ name: "environment", required: true }],
		}) as { id: string };

		const withoutValue = await registry.get("playbooks.invoke")!.execute({ id: created.id }) as { missingArguments?: string[] };
		expect(withoutValue.missingArguments).toEqual(["environment"]);
		expect(artifacts.query({ kind: "task" })).toHaveLength(0);

		const withValue = await registry.get("playbooks.invoke")!.execute({ id: created.id, arguments: { environment: "staging" } }) as { entryTaskId: string };
		const entry = artifacts.get(withValue.entryTaskId)!;
		expect(entry.body).toBe("Deploy to staging");
	});
});
