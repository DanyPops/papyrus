import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/adapters/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { playbooksOperations, PLAYBOOKS_OPERATION_NAMES } from "../src/modules/playbooks.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const artifactScopes = new SQLiteArtifactScopeStore(db);
	const registry = new OperationRegistry();
	registry.registerAll(playbooksOperations(artifacts, artifactScopes));
	return { registry, artifacts };
}

describe("modules/playbooks — a Papyrus-native registered module, a completely different beast from Skills", () => {
	it("registers exactly the playbooks.* operations PLAYBOOKS_OPERATION_NAMES declares", () => {
		const { registry } = fixture();
		const registered = registry.list().filter((name) => name.startsWith("playbooks."));
		expect(registered).toEqual([...PLAYBOOKS_OPERATION_NAMES].sort());
	});

	it("creates, invokes, updates, and lists a playbook through the registered operations", async () => {
		const { registry } = fixture();
		const created = await registry.get("playbooks.create")!.execute({ title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] }) as { id: string; kind: string };
		expect(created.kind).toBe("playbook");
		const invocation = await registry.get("playbooks.invoke")!.execute({ id: created.id }) as string;
		expect(invocation).toContain("1. Frame the problem");
		const updated = await registry.get("playbooks.update")!.execute({ id: created.id, title: "New Project v2" }) as { title: string };
		expect(updated.title).toBe("New Project v2");
		const shown = await registry.get("playbooks.show")!.execute({ id: created.id }) as { id: string };
		expect(shown.id).toBe(created.id);
		const disabled = await registry.get("playbooks.disable")!.execute({ id: created.id }) as { status: string };
		expect(disabled.status).toBe("deprecated");
	});

	it("declares arguments at create and supplies values at invoke through the registered operations", async () => {
		const { registry } = fixture();
		const created = await registry.get("playbooks.create")!.execute({
			title: "Deploy service", trigger: "deploying", steps: ["Deploy it"],
			arguments: [{ name: "environment", required: true }],
		}) as { id: string };
		const withoutValue = await registry.get("playbooks.invoke")!.execute({ id: created.id }) as string;
		expect(withoutValue).toContain("Missing required argument(s): environment.");
		const withValue = await registry.get("playbooks.invoke")!.execute({ id: created.id, arguments: { environment: "staging" } }) as string;
		expect(withValue).toContain("- environment: staging");
		expect(withValue).not.toContain("Missing required argument");
	});
});
