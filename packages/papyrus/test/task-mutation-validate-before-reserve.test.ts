import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { TASK_EVENT_REASON_MAX_LENGTH } from "../src/constants.ts";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/mutation-validate-before-reserve";
const PERMS = { permissions: ["tasks:read", "tasks:write"] };
const OVER_LENGTH_REASON = "x".repeat(TASK_EVENT_REASON_MAX_LENGTH + 1);

/**
 * Real incident (2026-08-11, papyrus task d0eb81b7's own completion): calling tasks.submit with
 * an over-length reason failed with a clean-looking validation error ("reason cannot exceed 2000
 * characters"), but a mutation receipt had ALREADY been durably reserved as "pending" before that
 * validation ever ran -- prepareMutation() reserves first, appendEvent()/validateTaskEvent() (a
 * completely different concern) only validates deep inside events.atomic(), several steps later.
 * Since nothing ever calls completeMutation() on that receipt when the atomic block throws, it
 * stays "pending" forever, and the task-level pending-mutation lock (keyed on (taskId, operation),
 * not the idempotency key) then blocks EVERY subsequent submit attempt on that task, under ANY
 * key, until the row expires (7 days) -- confirmed live: this required a direct DB row deletion
 * to recover, no self-service recovery path existed. Filed as its own task (a54f0649).
 */
describe("a task mutation's own context (reason/sessionId) is validated before any receipt is reserved", () => {
	it("an over-length reason on tasks.submit never leaves a stuck pending receipt -- a fresh, valid submit with a new key still succeeds", async () => {
		const path = join(tempDir("papyrus-mutation-validate-"), "papyrus.db");
		const service = createPapyrusService(path);
		const task = (await service.vehicle.invoke("tasks.create", 1, { title: "Validate before reserve", project_root: PROJECT }, PERMS)) as {
			id: string;
		};
		await service.vehicle.invoke("tasks.start", 1, { id: task.id, idempotency_key: "start-1" }, PERMS);

		const rejected = await service.vehicle
			.invoke("tasks.submit", 1, { id: task.id, reason: OVER_LENGTH_REASON, idempotency_key: "submit-bad-reason" }, PERMS)
			.catch((error: unknown) => error);
		expect(rejected).toBeInstanceOf(Error);

		// The real regression: this used to throw mutation-pending forever, for ANY key, because
		// the first (invalid) attempt's receipt was already reserved before validation ran.
		const retried = (await service.vehicle.invoke(
			"tasks.submit",
			1,
			{ id: task.id, reason: "a perfectly fine reason", idempotency_key: "submit-good-reason" },
			PERMS,
		)) as { status: string };
		expect(retried).toMatchObject({ status: "review" });

		const status = await service.vehicle
			.invoke("tasks.mutation_status", 1, { idempotency_key: "submit-bad-reason" }, PERMS)
			.catch((error: unknown) => error);
		// The invalid attempt's own key never reserved a receipt at all -- validation ran before
		// prepareMutation's reserving call, so there is nothing to inspect for it.
		expect(status).toBeInstanceOf(Error);

		service.close();
	});

	it("an over-length reason on tasks.complete never leaves a stuck pending receipt either", async () => {
		const path = join(tempDir("papyrus-mutation-validate-complete-"), "papyrus.db");
		const service = createPapyrusService(path);
		const task = (await service.vehicle.invoke(
			"tasks.create",
			1,
			{ title: "Validate before reserve (complete)", status: "review", project_root: PROJECT },
			PERMS,
		)) as { id: string };

		const rejected = await service.vehicle
			.invoke("tasks.complete", 1, { id: task.id, reason: OVER_LENGTH_REASON, idempotency_key: "complete-bad-reason" }, PERMS)
			.catch((error: unknown) => error);
		expect(rejected).toBeInstanceOf(Error);

		const retried = (await service.vehicle.invoke("tasks.complete", 1, { id: task.id, idempotency_key: "complete-good" }, PERMS)) as {
			completed: boolean;
		};
		expect(retried.completed).toBe(true);

		service.close();
	});
});
