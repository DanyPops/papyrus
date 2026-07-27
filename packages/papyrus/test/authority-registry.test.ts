import { describe, expect, it } from "bun:test";
import { AuthorityRegistry, AuthorizedArtifactWriter, type AuthorityClaim } from "../src/authority-registry.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";

function claim(owner: string, subtype: string, message = `${owner}-owned`): AuthorityClaim {
	return {
		owner,
		matchesArtifact: (_kind, s) => s === subtype,
		matchesRelation: (relation) => relation === `${owner}-relation`,
		denyMessage: () => message,
	};
}

describe("AuthorityRegistry — one deep enforcement point replacing scattered subtype checks", () => {
	it("finds no claim for an unclaimed kind/subtype and allows any caller", () => {
		const registry = new AuthorityRegistry();
		registry.claim(claim("forum", "forum-message"));
		expect(registry.claimForArtifact("doc", "plain", "create")).toBeUndefined();
		expect(() => registry.requireArtifactAllowed("doc", "plain", "create", "anyone")).not.toThrow();
	});

	it("allows the owning module and rejects every other caller with the claim's message", () => {
		const registry = new AuthorityRegistry();
		registry.claim(claim("notes", "note", "note creation requires notes.capture"));
		expect(() => registry.requireArtifactAllowed("doc", "note", "create", "notes")).not.toThrow();
		expect(() => registry.requireArtifactAllowed("doc", "note", "create", "docs")).toThrow("note creation requires notes.capture");
		expect(() => registry.requireArtifactAllowed("doc", "note", "create", "generic")).toThrow("note creation requires notes.capture");
	});

	it("checks relations the same way, independent of artifact claims", () => {
		const registry = new AuthorityRegistry();
		registry.claim(claim("forum", "forum-message", "forum-owned"));
		expect(() => registry.requireRelationAllowed("forum-relation", "link", "generic")).toThrow("forum-owned");
		expect(() => registry.requireRelationAllowed("forum-relation", "link", "forum")).not.toThrow();
		expect(() => registry.requireRelationAllowed("relates_to", "link", "generic")).not.toThrow();
	});
});

describe("AuthorityClaim.appliesToAction — a claim can be scoped to only some actions", () => {
	it("does not leak into an action the claim was never checked for historically", () => {
		// Regression: a naive claim matching kind==="task" for every action would wrongly reject
		// artifact.create's kind="task" path, which historically redirects to tasks.create rather
		// than being rejected — only graph.status ever rejected task-kind writes.
		const registry = new AuthorityRegistry();
		registry.claim({
			owner: "tasks",
			matchesArtifact: (kind) => kind === "task",
			appliesToAction: (action) => action === "status",
			denyMessage: () => "task lifecycle changes require a tasks.* operation",
		});
		expect(() => registry.requireArtifactAllowed("task", undefined, "create", "generic")).not.toThrow();
		expect(() => registry.requireArtifactAllowed("task", undefined, "status", "generic")).toThrow("task lifecycle changes require a tasks.* operation");
	});
});

describe("AuthorizedArtifactWriter — scoped write path bound to one caller identity", () => {
	function fixture(caller: string) {
		const db = openDb(":memory:");
		const store = new SQLiteArtifactStore(db);
		const registry = new AuthorityRegistry();
		registry.claim({
			owner: "notes",
			matchesArtifact: (_kind, subtype) => subtype === "note",
			denyMessage: (action) => action === "link" ? "note relationships require a notes.* operation" : "note lifecycle changes require a notes.* operation",
		});
		return { writer: new AuthorizedArtifactWriter(store, registry, caller), store };
	}

	it("blocks a non-owner from linking a claimed artifact, checking the persisted subtype not a cached assumption", () => {
		const { writer, store } = fixture("generic");
		const note = store.create({ kind: "doc", subtype: "note", title: "A note" });
		const other = store.create({ kind: "doc", title: "Other doc" });
		expect(() => writer.link({ from: other.id, relation: "relates_to", to: note.id })).toThrow("note relationships require a notes.* operation");
	});

	it("allows the owning caller to link its own claimed artifact", () => {
		const { writer, store } = fixture("notes");
		const note = store.create({ kind: "doc", subtype: "note", title: "A note" });
		const other = store.create({ kind: "doc", title: "Other doc" });
		expect(() => writer.link({ from: note.id, relation: "relates_to", to: other.id })).not.toThrow();
	});

	it("blocks a non-owner from unlinking and from changing status on a claimed artifact", () => {
		const { writer, store } = fixture("generic");
		const note = store.create({ kind: "doc", subtype: "note", title: "A note" });
		expect(() => writer.unlink({ from: note.id, relation: "relates_to", to: note.id })).toThrow("note relationships require a notes.* operation");
		expect(() => writer.setStatus(note.id, "active")).toThrow("note lifecycle changes require a notes.* operation");
	});

	it("passes unclaimed artifacts through unchanged", () => {
		const { writer, store } = fixture("generic");
		const doc = store.create({ kind: "doc", title: "Plain doc" });
		expect(() => writer.setStatus(doc.id, "active")).not.toThrow();
		expect(store.get(doc.id)?.status).toBe("active");
	});
});
