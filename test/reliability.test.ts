import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "../src/adapters/sqlite-gate-runner.ts";
import { Tasks } from "../src/task-service.ts";
import { createApp, createPapyrusService } from "../src/service.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "../src/constants.ts";
import { callService, resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

function dbFile(): string {
	return join(mkdtempSync(join(tmpdir(), "papyrus-reliability-")), "papyrus.db");
}

describe("daemon client reliability", () => {
	it("does not retry daemon application errors", async () => {
		let calls = 0;
		setPapyrusClientConnectorForTests(async () => ({
			async call() { calls += 1; throw new Error("title is required"); },
		}) as any);
		try {
			await expect(callService("artifact.create", {})).rejects.toThrow("title is required");
			expect(calls).toBe(1);
		} finally {
			resetPapyrusClientForTests();
		}
	});

	it("reconnects and retries exactly once after a stale daemon client fails", async () => {
		let connections = 0;
		let calls = 0;
		setPapyrusClientConnectorForTests(async () => {
			connections += 1;
			return {
				async call() {
					calls += 1;
					if (calls === 1) throw new Error("fetch failed");
					return { ok: true };
				},
			} as any;
		});
		try {
			const result = await callService<Record<string, never>, { ok: true }>("artifact.query", {});
			expect(result).toEqual({ ok: true });
			expect(connections).toBe(2);
			expect(calls).toBe(2);
		} finally {
			resetPapyrusClientForTests();
		}
	});
});

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
		let timerFired = false;
		setTimeout(() => { timerFired = true; }, 10);
		const completion = await tasks.completeAsync(task.id);
		expect(timerFired).toBe(true);
		expect(completion.completed).toBe(true);
		db.close();
	});

	it("rejects oversized service requests before parsing JSON", async () => {
		const service = createPapyrusService(dbFile());
		const app = createApp({ service, token: "token" });
		const response = await app.fetch(new Request("http://papyrus.test/api/v1/ops", {
			method: "POST",
			headers: {
				authorization: "Bearer token",
				"content-type": "application/json",
				"content-length": "2000000",
			},
			body: "{}",
		}));
		expect(response.status).toBe(413);
		service.close();
	});
});
