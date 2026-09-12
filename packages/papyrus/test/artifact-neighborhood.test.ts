import { describe, expect, it, spyOn } from "bun:test";
import type { Artifact } from "../src/artifact/artifact.ts";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import { createArtifact, getArtifact, linkArtifacts } from "../src/ops.ts";
import { createPapyrusService } from "../src/service.ts";
import { Tasks } from "../src/task/task-service.ts";

describe("artifact neighborhoods", () => {
	it("keeps task details on direct relationships", () => {
		const db = openDb(":memory:");
		try {
			const store = new SQLiteArtifactStore(db);
			const tasks = new Tasks(store, { run: () => [], runAsync: async () => [] });
			const parent = tasks.create({ title: "Epic" });
			const child = tasks.create({ title: "Child", parentId: parent.id });
			const sibling = tasks.create({ title: "Sibling", parentId: parent.id });
			const detail = tasks.show(child.id);
			expect(detail.edges?.length).toBeGreaterThan(0);
			expect(detail.edges?.every((edge) => edge.from === child.id || edge.to === child.id)).toBe(true);
			expect(detail.edges?.some((edge) => edge.from === sibling.id || edge.to === sibling.id)).toBe(false);
			expect(store.get(child.id, { tree: true, depth: 4 })?.edges?.some((edge) => edge.to === sibling.id)).toBe(true);
		} finally {
			db.close();
		}
	});

	it("keeps every detail domain local and explicit graph reads deep", async () => {
		const service = createPapyrusService(":memory:");
		try {
			const parent = (await service.execute("docs.create", { title: "Shared reference" })) as Artifact;
			const sibling = (await service.execute("docs.create", {
				title: "Other project reference",
				project_root: "/tmp/other-example",
			})) as Artifact;
			await service.execute("graph.link", { from: parent.id, relation: "references", to: sibling.id });
			for (const domain of ["tasks", "docs", "rules", "playbooks", "notes"]) {
				const input = {
					title: `${domain} detail`,
					body: "Content",
					condition: "active",
					action: "record",
					project_root: "/tmp/example-project",
				};
				const root = (await service.execute(domain === "notes" ? "notes.capture" : `${domain}.create`, input)) as Artifact;
				if (domain === "notes") {
					await service.execute("notes.promote", {
						id: root.id,
						target_id: parent.id,
						project_root: input.project_root,
						reason: "Reference captured",
					});
				} else {
					await service.execute("graph.link", { from: root.id, relation: "references", to: parent.id });
				}
				const detail = (await service.execute(`${domain}.show`, { id: root.id, project_root: input.project_root })) as Artifact;
				expect(detail.edges?.length).toBeGreaterThan(0);
				expect(detail.edges?.every((edge) => edge.from === root.id || edge.to === root.id)).toBe(true);
				const graph = (await service.execute("graph.tree", { id: root.id })) as Artifact;
				expect(graph.edges?.some((edge) => edge.to === sibling.id)).toBe(true);
			}
		} finally {
			service.close();
		}
	});

	it("uses bounded indexed queries on a high-degree graph", () => {
		const db = openDb(":memory:");
		try {
			const root = createArtifact(db, { kind: "doc", title: "Root" });
			for (let i = 0; i < 1200; i++) {
				const child = createArtifact(db, { kind: "doc", title: `Node ${i}` });
				linkArtifacts(db, root.id, "references", child.id);
			}
			const prepare = spyOn(db, "prepare");
			const graph = getArtifact(db, root.id, { tree: true, maxNodes: 1000 })!;
			const queries = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("FROM edges"));
			prepare.mockRestore();
			expect(graph.graphCompleteness?.truncated).toBe(true);
			expect(graph.graphCompleteness?.examinedEdges).toBeLessThanOrEqual(4096);
			expect(graph.edges!.length).toBeLessThanOrEqual(1000);
			expect(Buffer.byteLength(JSON.stringify(graph.edges))).toBeLessThanOrEqual(65536);
			expect(queries).toHaveLength(2);
			for (const sql of queries) {
				expect(sql).toContain("LIMIT ?");
				const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(root.id, 4096));
				expect(plan).toContain("SEARCH edges");
				expect(plan).not.toContain("TEMP B-TREE");
			}
		} finally {
			db.close();
		}
	});

	it("omits oversized identifiers without rewriting relationships", () => {
		const db = openDb(":memory:");
		try {
			const root = createArtifact(db, { kind: "doc", title: "Root" });
			const child = createArtifact(db, { id: "x".repeat(1025), kind: "doc", title: "Long identifier" });
			linkArtifacts(db, root.id, "references", child.id);
			const graph = getArtifact(db, root.id, { tree: true });
			expect(graph?.edges).toEqual([]);
			expect(graph?.graphCompleteness?.truncated).toBe(true);
			expect(db.prepare("SELECT to_id FROM edges WHERE from_id = ?").get(root.id)).toEqual({ to_id: child.id });
		} finally {
			db.close();
		}
	});

	it("rejects invalid traversal bounds", () => {
		const db = openDb(":memory:");
		try {
			const root = createArtifact(db, { kind: "doc", title: "Root" });
			for (const depth of [NaN, Infinity, -1, 1.5, 21]) {
				expect(() => getArtifact(db, root.id, { tree: true, depth })).toThrow("invalid artifact graph bounds");
			}
			expect(getArtifact(db, root.id, { tree: true, depth: 0 })?.edges).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("reports saturated node bounds deterministically", () => {
		const db = openDb(":memory:");
		try {
			const root = createArtifact(db, { kind: "doc", title: "Root" });
			for (let i = 0; i < 30; i++) {
				const child = createArtifact(db, { kind: "doc", title: `Child ${i}` });
				linkArtifacts(db, root.id, "references", child.id);
			}
			const first = getArtifact(db, root.id, { tree: true, depth: 4, maxNodes: 3 });
			expect(first).toMatchObject({ graphCompleteness: { truncated: true, visitedNodes: 3 } });
			expect(first?.edges).toHaveLength(2);
			expect(getArtifact(db, root.id, { tree: true, depth: 4, maxNodes: 3 })).toEqual(first);
		} finally {
			db.close();
		}
	});
});
