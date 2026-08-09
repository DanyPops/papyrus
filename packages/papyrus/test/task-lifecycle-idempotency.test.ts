import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/lifecycle-idempotency";
const PERMS = { permissions: ["tasks:read", "tasks:write"] };

describe("durable Task lifecycle mutation receipts", () => {
	it("survives daemon replacement and resolves a lost response without another transition", async () => {
		const path = join(tempDir("papyrus-lifecycle-restart-"), "papyrus.db");
		const first = createPapyrusService(path);
		const task = (await first.vehicle.invoke("tasks.create", 1, { title: "Restart-safe", project_root: PROJECT }, PERMS)) as { id: string };
		await first.vehicle.invoke("tasks.start", 1, { id: task.id, idempotency_key: "start-restart-1" }, PERMS);
		first.close();

		const replacement = createPapyrusService(path);
		const receipt = (await replacement.vehicle.invoke("tasks.mutation_status", 1, { idempotency_key: "start-restart-1" }, PERMS)) as {
			state: string;
			result: unknown;
		};
		const replay = await replacement.vehicle.invoke("tasks.start", 1, { id: task.id, idempotency_key: "start-restart-1" }, PERMS);
		expect(receipt).toMatchObject({
			state: "completed",
			result: { id: task.id, status: "in-progress", changed: true },
			taskStatus: "in-progress",
		});
		expect(replay).toMatchObject({ id: task.id, status: "in-progress", changed: false, replayed: true });
		const history = (await replacement.vehicle.invoke("tasks.history", 1, { id: task.id, direction: "asc" }, PERMS)) as {
			events: Array<{ type: string }>;
		};
		expect(history.events.filter((event) => event.type === "started")).toHaveLength(1);
		replacement.close();
	});

	it("self-corrects a pending atomic lifecycle transition with the original key", async () => {
		const path = join(tempDir("papyrus-lifecycle-pending-start-"), "papyrus.db");
		const service = createPapyrusService(path);
		const task = (await service.vehicle.invoke("tasks.create", 1, { title: "Pending start", project_root: PROJECT }, PERMS)) as {
			id: string;
		};
		const now = new Date().toISOString();
		const expires = new Date(Date.now() + 60_000).toISOString();
		const requestHash = createHash("sha256")
			.update(`{"operation":"start","payload":{},"taskId":${JSON.stringify(task.id)}}`)
			.digest("hex");
		const db = openDb(path);
		db.prepare(`
				INSERT INTO task_mutation_requests (
					request_scope, idempotency_key, receipt_id, task_id, operation, request_hash,
					state, response_json, created_at, updated_at, expires_at
				) VALUES ('anonymous', 'pending-start-1', 'receipt-pending-start-1', ?, 'start', ?, 'pending', NULL, ?, ?, ?)
			`).run(task.id, requestHash, now, now, expires);
		db.close();
		const recovered = (await service.vehicle.invoke("tasks.start", 1, { id: task.id, idempotency_key: "pending-start-1" }, PERMS)) as {
			status: string;
			receiptId: string;
		};
		expect(recovered).toMatchObject({ status: "in-progress", receiptId: "receipt-pending-start-1" });
		expect(await service.vehicle.invoke("tasks.mutation_status", 1, { idempotency_key: "pending-start-1" }, PERMS)).toMatchObject({
			state: "completed",
			taskStatus: "in-progress",
		});
		service.close();
	});

	it("keeps an interrupted pending completion receipt inspectable and refuses to rerun its gates blindly", async () => {
		const path = join(tempDir("papyrus-lifecycle-pending-"), "papyrus.db");
		const service = createPapyrusService(path);
		const task = (await service.vehicle.invoke(
			"tasks.create",
			1,
			{ title: "Interrupted completion", status: "review", project_root: PROJECT },
			PERMS,
		)) as { id: string };
		const now = new Date().toISOString();
		const expires = new Date(Date.now() + 60_000).toISOString();
		const requestHash = createHash("sha256")
			.update(`{"operation":"complete","payload":{"context":{},"options":{}},"taskId":${JSON.stringify(task.id)}}`)
			.digest("hex");
		const db = openDb(path);
		db.prepare(`
				INSERT INTO task_mutation_requests (
					request_scope, idempotency_key, receipt_id, task_id, operation, request_hash,
					state, response_json, created_at, updated_at, expires_at
				) VALUES ('anonymous', 'pending-1', 'receipt-pending-1', ?, 'complete', ?, 'pending', NULL, ?, ?, ?)
			`).run(task.id, requestHash, now, now, expires);
		db.close();
		const receipt = (await service.vehicle.invoke("tasks.mutation_status", 1, { idempotency_key: "pending-1" }, PERMS)) as {
			state: string;
			operation: string;
		};
		expect(receipt).toMatchObject({ state: "pending", operation: "complete" });
		const rejection = await service.vehicle
			.invoke("tasks.complete", 1, { id: task.id, idempotency_key: "pending-1" }, PERMS)
			.catch((error: unknown) => error);
		expect(rejection).toMatchObject({ code: "mutation-pending", category: "conflict" });
		const newKeyRejection = await service.vehicle
			.invoke("tasks.complete", 1, { id: task.id, idempotency_key: "do-not-bypass-pending" }, PERMS)
			.catch((error: unknown) => error);
		expect(newKeyRejection).toMatchObject({
			code: "mutation-pending",
			details: { receiptId: "receipt-pending-1", operation: "complete" },
		});
		service.close();
	});
});
