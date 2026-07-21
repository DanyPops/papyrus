import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { migrateDb, openDb } from "../src/db.ts";
import {
	ARTIFACT_EVENT_DEFAULT_ACTOR,
	ARTIFACT_EVENT_DEFAULT_SOURCE,
	normalizeArtifactEventQuery,
	resolveArtifactEvent,
	type ArtifactEvent,
} from "../src/domain/artifact-event.ts";
import { createPapyrusService } from "../src/service.ts";

describe("generic mutation event log — domain validation", () => {
	it("defaults actor and source to explicit sentinels rather than a silent blank", () => {
		const event = resolveArtifactEvent({ artifactId: "doc-1", type: "created" });
		expect(event.actor).toBe(ARTIFACT_EVENT_DEFAULT_ACTOR);
		expect(event.source).toBe(ARTIFACT_EVENT_DEFAULT_SOURCE);
	});

	it("keeps caller-supplied actor, source, and sessionId", () => {
		const event = resolveArtifactEvent({ artifactId: "doc-1", type: "created", actor: "agent", source: "pi", sessionId: "ses-1" });
		expect(event.actor).toBe("agent");
		expect(event.source).toBe("pi");
		expect(event.sessionId).toBe("ses-1");
	});

	it("rejects an artifactId-less event and an oversized actor", () => {
		expect(() => resolveArtifactEvent({ artifactId: "", type: "created" })).toThrow("artifactId is required");
		expect(() => resolveArtifactEvent({ artifactId: "doc-1", type: "created", actor: "x".repeat(200) })).toThrow(/actor must be between/);
	});

	it("requires artifactId, actor, or sessionId to keep queries bounded and indexed", () => {
		expect(() => normalizeArtifactEventQuery({})).toThrow(/requires artifactId, actor, or sessionId/);
		expect(normalizeArtifactEventQuery({ actor: "agent" }).limit).toBe(25);
	});

	it("rejects an out-of-range limit and a non-positive cursor", () => {
		expect(() => normalizeArtifactEventQuery({ actor: "agent", limit: 0 })).toThrow(/limit must be between/);
		expect(() => normalizeArtifactEventQuery({ actor: "agent", limit: 500 })).toThrow(/limit must be between/);
		expect(() => normalizeArtifactEventQuery({ actor: "agent", cursor: 0 })).toThrow(/cursor must be a positive integer/);
	});
});

describe("generic mutation event log — every kind, one shared log", () => {
	function fixture() {
		const db = openDb(":memory:");
		return { db, artifacts: new SQLiteArtifactStore(db) };
	}

	it("records a create event for a Doc, a Rule, and a Skill — not just Task/Note", () => {
		const { artifacts } = fixture();
		const doc = artifacts.create({ kind: "doc", title: "Design note" });
		const rule = artifacts.create({ kind: "rule", title: "A rule" });
		const skill = artifacts.create({ kind: "skill", title: "A skill" });

		expect(artifacts.events({ artifactId: doc.id }).events.map((e) => e.type)).toEqual(["created"]);
		expect(artifacts.events({ artifactId: rule.id }).events.map((e) => e.type)).toEqual(["created"]);
		expect(artifacts.events({ artifactId: skill.id }).events.map((e) => e.type)).toEqual(["created"]);
	});

	it("stamps caller-supplied actor/source/sessionId on create, and defaults when omitted", () => {
		const { artifacts } = fixture();
		const withContext = artifacts.create({ kind: "doc", title: "Attributed" }, { actor: "agent-a", source: "pi", sessionId: "ses-42" });
		const withoutContext = artifacts.create({ kind: "doc", title: "Unattributed" });

		const [attributed] = artifacts.events({ artifactId: withContext.id }).events;
		expect(attributed?.actor).toBe("agent-a");
		expect(attributed?.source).toBe("pi");
		expect(attributed?.sessionId).toBe("ses-42");

		const [defaulted] = artifacts.events({ artifactId: withoutContext.id }).events;
		expect(defaulted?.actor).toBe(ARTIFACT_EVENT_DEFAULT_ACTOR);
		expect(defaulted?.source).toBe(ARTIFACT_EVENT_DEFAULT_SOURCE);
	});

	it("records status_changed, extra_set, and updated events with before/after status", () => {
		const { artifacts } = fixture();
		const doc = artifacts.create({ kind: "doc", title: "Lifecycle" });
		artifacts.setStatus(doc.id, "active", { actor: "reviewer" });
		artifacts.setExtra(doc.id, { note: "x" });
		artifacts.updateContent(doc.id, { title: "Renamed" });

		const events = artifacts.events({ artifactId: doc.id, direction: "asc" }).events;
		expect(events.map((e) => e.type)).toEqual(["created", "status_changed", "extra_set", "updated"]);
		const statusChanged = events[1]!;
		expect(statusChanged.fromStatus).toBe("draft");
		expect(statusChanged.toStatus).toBe("active");
		expect(statusChanged.actor).toBe("reviewer");
	});

	it("records one linked event per new edge, queryable from either side, and does not duplicate on relink", () => {
		const { artifacts } = fixture();
		const from = artifacts.create({ kind: "doc", title: "From" });
		const to = artifacts.create({ kind: "doc", title: "To" });
		artifacts.link({ from: from.id, relation: "relates_to", to: to.id }, { actor: "agent" });
		artifacts.link({ from: from.id, relation: "relates_to", to: to.id }); // idempotent re-link

		const fromEvents = artifacts.events({ artifactId: from.id, direction: "asc" }).events.filter((e) => e.type === "linked");
		expect(fromEvents.length).toBe(1);
		expect(fromEvents[0]?.relation).toBe("relates_to");
		expect(fromEvents[0]?.relatedId).toBe(to.id);

		const toEvents = artifacts.events({ artifactId: to.id }).events.filter((e) => e.type === "linked");
		expect(toEvents.length).toBe(1);
	});

	it("filters by actor and by sessionId across artifacts", () => {
		const { artifacts } = fixture();
		artifacts.create({ kind: "doc", title: "A" }, { actor: "agent-a", sessionId: "ses-1" });
		artifacts.create({ kind: "doc", title: "B" }, { actor: "agent-b", sessionId: "ses-2" });
		artifacts.create({ kind: "doc", title: "C" }, { actor: "agent-a", sessionId: "ses-1" });

		expect(artifacts.events({ actor: "agent-a" }).events.length).toBe(2);
		expect(artifacts.events({ sessionId: "ses-2" }).events.length).toBe(1);
	});

	it("paginates with a cursor and reports nextCursor only when more rows remain", () => {
		const { artifacts } = fixture();
		const doc = artifacts.create({ kind: "doc", title: "Paged" });
		for (let i = 0; i < 3; i++) artifacts.setExtra(doc.id, { i });

		const page1 = artifacts.events({ artifactId: doc.id, direction: "asc", limit: 2 });
		expect(page1.events.length).toBe(2);
		expect(page1.nextCursor).toBeDefined();

		const page2 = artifacts.events({ artifactId: doc.id, direction: "asc", limit: 2, cursor: page1.nextCursor });
		expect(page2.events.length).toBe(2);
		expect(page2.nextCursor).toBeUndefined();
	});

	it("is append-only: direct UPDATE and DELETE are rejected", () => {
		const { db, artifacts } = fixture();
		artifacts.create({ kind: "doc", title: "Immutable" });
		expect(() => db.prepare("UPDATE artifact_events SET actor = 'tampered'").run()).toThrow("artifact_events are append-only");
		expect(() => db.prepare("DELETE FROM artifact_events").run()).toThrow("artifact_events are append-only");
	});
});

describe("generic mutation event log — daemon operation layer", () => {
	function serviceFixture() {
		return createPapyrusService(":memory:");
	}

	it("stamps caller-supplied actor/source/sessionId through docs.create, rules.create, skills.create, and graph.link", async () => {
		const service = serviceFixture();
		const doc = await service.execute("docs.create", { title: "Doc", actor: "agent-a", source: "pi", session_id: "ses-1" }) as { id: string };
		const rule = await service.execute("rules.create", { title: "Rule", actor: "agent-a", source: "pi", session_id: "ses-1" }) as { id: string };
		const skill = await service.execute("skills.create", { title: "Skill", actor: "agent-a", source: "pi", session_id: "ses-1" }) as { id: string };
		await service.execute("graph.link", { from: doc.id, relation: "relates_to", to: rule.id, actor: "agent-a", source: "pi", session_id: "ses-1" });

		for (const id of [doc.id, rule.id, skill.id]) {
			const page = await service.execute("graph.history", { id }) as { events: ArtifactEvent[] };
			expect(page.events[0]).toEqual(expect.objectContaining({ actor: "agent-a", source: "pi", sessionId: "ses-1" }));
		}
		const linked = await service.execute("graph.history", { id: doc.id, direction: "asc" }) as { events: ArtifactEvent[] };
		expect(linked.events.map((event) => event.type)).toEqual(["created", "linked"]);
		service.close();
	});

	it("answers bounded who-did-what-when queries by actor and by session across kinds through graph.history", async () => {
		const service = serviceFixture();
		await service.execute("docs.create", { title: "Doc A", actor: "agent-a", session_id: "ses-1" });
		await service.execute("rules.create", { title: "Rule B", actor: "agent-b", session_id: "ses-2" });
		await service.execute("skills.create", { title: "Skill A", actor: "agent-a", session_id: "ses-1" });

		const byActor = await service.execute("graph.history", { actor: "agent-a" }) as { events: ArtifactEvent[] };
		expect(byActor.events.length).toBe(2);
		const bySession = await service.execute("graph.history", { session_id: "ses-2" }) as { events: ArtifactEvent[] };
		expect(bySession.events.length).toBe(1);
		await expect(service.execute("graph.history", {})).rejects.toThrow(/requires artifactId, actor, or sessionId/);
		service.close();
	});
});

describe("generic mutation event log — explicit migration", () => {
	it("adds artifact_events when migrating an existing schema 6 database forward", () => {
		const db = openDb(":memory:");
		new SQLiteArtifactStore(db).create({ kind: "doc", title: "Pre-migration" });
		db.exec(`
			DROP TRIGGER artifact_events_no_delete;
			DROP TRIGGER artifact_events_no_update;
			DROP TABLE artifact_events;
			PRAGMA user_version = 6;
		`);

		expect(migrateDb(db)).toEqual({ from: 6, to: 8, applied: ["artifact-event-log", "task-focus-session-scope"] });
		expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_events").get()).toEqual({ count: 0 });

		const artifacts = new SQLiteArtifactStore(db);
		const doc = artifacts.create({ kind: "doc", title: "Post-migration" });
		expect(artifacts.events({ artifactId: doc.id }).events.map((e) => e.type)).toEqual(["created"]);
	});
});
