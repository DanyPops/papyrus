import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { NOTE_BODY_MAX_CHARACTERS, NOTE_LIST_MAX_LIMIT } from "../src/constants.ts";
import { openDb } from "../src/db.ts";
import { Notes } from "../src/note-service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";
afterAll(cleanupTempDirs);

const PROJECT = "/workspace/papyrus";
const OTHER_PROJECT = "/workspace/other";

function fixture() {
	const directory = tempDir("papyrus-notes-");
	const database = openDb(join(directory, "papyrus.db"));
	const artifacts = new SQLiteArtifactStore(database);
	return { database, artifacts, notes: new Notes(artifacts) };
}

describe("Notes application service", () => {
	it("captures bounded human intent and lists only the requested project", () => {
		const { database, notes } = fixture();
		const captured = notes.capture({
			body: "Review the release provenance later",
			projectRoot: PROJECT,
			actor: "human",
			source: "command",
			sessionId: "session-1",
		});
		notes.capture({ body: "Unrelated", projectRoot: OTHER_PROJECT, actor: "human", source: "command" });

		expect(captured).toMatchObject({
			kind: "doc",
			subtype: "note",
			status: "draft",
			title: "Review the release provenance later",
			body: "Review the release provenance later",
		});
		expect(captured.extra).toMatchObject({
			projectRoot: PROJECT,
			noteHistory: [expect.objectContaining({ action: "captured", actor: "human", source: "command", sessionId: "session-1" })],
		});
		expect(notes.list({ projectRoot: PROJECT })).toEqual([expect.objectContaining({ id: captured.id })]);
		expect(notes.list({ projectRoot: OTHER_PROJECT })).toHaveLength(1);
		expect(() => notes.capture({ body: "x".repeat(NOTE_BODY_MAX_CHARACTERS + 1), projectRoot: PROJECT })).toThrow("note body exceeds");
		expect(() => notes.list({ projectRoot: PROJECT, limit: NOTE_LIST_MAX_LIMIT + 1 })).toThrow("note limit");
		database.close();
	});

	it("consumes, promotes, and archives notes with disposition history and graph links", () => {
		const { database, artifacts, notes } = fixture();
		const captured = notes.capture({ body: "Create a follow-up document", projectRoot: PROJECT });
		const consumed = notes.consume(captured.id, { projectRoot: PROJECT, actor: "agent", source: "notes-tool", sessionId: "session-2" });
		expect(consumed.status).toBe("active");
		expect(consumed.extra.noteHistory).toEqual([
			expect.objectContaining({ action: "captured" }),
			expect.objectContaining({ action: "consumed", actor: "agent", sessionId: "session-2" }),
		]);

		const target = artifacts.create({ kind: "doc", title: "Follow-up", subtype: "research" });
		const promoted = notes.promote(captured.id, target.id, { projectRoot: PROJECT, actor: "agent", source: "notes-tool", reason: "Converted to durable research" });
		expect(promoted.status).toBe("archived");
		expect(promoted.extra).toMatchObject({ disposition: { kind: "promoted", targetId: target.id, reason: "Converted to durable research" } });
		expect(promoted.edges).toContainEqual({ from: captured.id, relation: "relates_to", to: target.id });
		expect(notes.list({ projectRoot: PROJECT })).toEqual([]);
		expect(notes.list({ projectRoot: PROJECT, status: "archived" })).toHaveLength(1);
		database.close();
	});

	it("rejects cross-project access and requires an explicit archival disposition", () => {
		const { database, notes } = fixture();
		const captured = notes.capture({ body: "Maybe later", projectRoot: PROJECT });
		expect(() => notes.show(captured.id, OTHER_PROJECT)).toThrow("outside project scope");
		expect(() => notes.archive(captured.id, { projectRoot: PROJECT, disposition: "" as "declined" })).toThrow("note disposition");
		const archived = notes.archive(captured.id, { projectRoot: PROJECT, disposition: "declined", reason: "No longer needed", actor: "human", source: "command" });
		expect(archived.status).toBe("archived");
		expect(archived.extra).toMatchObject({ disposition: { kind: "declined", reason: "No longer needed" } });
		database.close();
	});
});
