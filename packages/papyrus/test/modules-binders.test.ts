import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/artifact/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { BINDERS_OPERATION_NAMES, bindersOperations } from "../src/modules/binders.ts";
import { SQLiteProjectRegistryStore } from "../src/project-registry/sqlite-project-registry-store.ts";
import { SQLiteScopeGroupStore } from "../src/scope-group/sqlite-scope-group-store.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const scopes = new SQLiteArtifactScopeStore(db);
	const projects = new SQLiteProjectRegistryStore(db);
	const groups = new SQLiteScopeGroupStore(db);
	const registry = new OperationRegistry();
	registry.registerAll(bindersOperations(artifacts, scopes, projects, groups));
	return { db, registry, artifacts };
}

describe("modules/binders", () => {
	it("registers exactly the declared Binder operations", () => {
		const { db, registry } = fixture();
		expect(registry.list()).toEqual([...BINDERS_OPERATION_NAMES].sort());
		db.close();
	});

	it("creates, nests, files, and projects effective labels through the module boundary", async () => {
		const { db, registry, artifacts } = fixture();
		const root = (await registry.get("binders.create")!.execute({ title: "Product", labels: ["product"] })) as { id: string };
		const child = (await registry.get("binders.create")!.execute({ title: "API", parent_id: root.id, labels: ["api"] })) as { id: string };
		const doc = artifacts.create({ kind: "doc", status: "draft", title: "Contract", labels: ["v2"] });
		await registry.get("binders.file")!.execute({ artifact_id: doc.id, binder_id: child.id });
		const tree = (await registry.get("binders.tree")!.execute({ artifact_ids: [doc.id] })) as {
			nodes: Array<{ path: string }>;
			artifacts: Array<{ effectiveLabels: string[] }>;
		};
		expect(tree.nodes.map((node) => node.path)).toEqual(["/Product", "/Product/API"]);
		expect(tree.artifacts[0]?.effectiveLabels).toEqual(["product", "api", "v2"]);
		db.close();
	});
});
