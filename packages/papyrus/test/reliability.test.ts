import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "../src/adapters/sqlite-gate-runner.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "../src/constants.ts";
import { openDb } from "../src/db.ts";
import { createApp, createPapyrusService } from "../src/service.ts";
import { Tasks } from "../src/task/task-service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

function dbFile(): string {
	return join(tempDir("papyrus-reliability-"), "papyrus.db");
}

describe("SQLite daemon reliability", () => {
	it("configures every connection for WAL, foreign keys, timeout, migrations, and indexes", () => {
		const db = openDb(dbFile());
		expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
		expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
		expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
		expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThan(0);
		const indexes = db.prepare("PRAGMA index_list('edges')").all() as Array<{ name: string }>;
		expect(indexes.some((index) => index.name === "edges_to_id_idx")).toBe(true);
		db.close();
	});

	it("runs subprocess gates without blocking the server event loop", async () => {
		const db = openDb(dbFile());
		const tasks = new Tasks(new SQLiteArtifactStore(db), new SQLiteGateRunner(db));
		const task = tasks.create({
			title: "Async gate",
			gates: [{ type: "command", target: "sleep 0.1" }],
		});
		tasks.transition(task.id, "start");
		tasks.transition(task.id, "submit");
		let timerFired = false;
		setTimeout(() => {
			timerFired = true;
		}, 10);
		const completion = await tasks.completeAsync(task.id);
		expect(timerFired).toBe(true);
		expect(completion.completed).toBe(true);
		db.close();
	});

	it("caps subprocess gate execution at a caller deadline", async () => {
		const db = openDb(dbFile());
		const tasks = new Tasks(new SQLiteArtifactStore(db), new SQLiteGateRunner(db));
		const task = tasks.create({ title: "Deadline", gates: [{ type: "command", target: "sleep 2" }] });
		tasks.transition(task.id, "start");
		tasks.transition(task.id, "submit");
		const startedAt = Date.now();
		const completion = await tasks.completeAsync(task.id, {}, { gateDeadlineMs: startedAt + 25 });
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(completion.completed).toBe(false);
		db.close();
	});

	it("rejects oversized service requests before parsing JSON", async () => {
		const service = createPapyrusService(dbFile());
		const app = createApp({ service, token: "token" });
		const response = await app.fetch(
			new Request("http://papyrus.test/api/v1/ops", {
				method: "POST",
				headers: {
					authorization: "Bearer token",
					"content-type": "application/json",
					"content-length": "2000000",
				},
				body: "{}",
			}),
		);
		expect(response.status).toBe(413);
		service.close();
	});
});
