import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { isVehicleError, type VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/example-project";
const TASK_PERMS = { permissions: ["tasks:read", "tasks:write"] };

function harness() {
	const directory = tempDir("papyrus-batch-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

/** VehicleRegistry's own schema-validation rejection carries the real per-field issue in
 * error.details (see vehicle-core's boundedValidationDetails), not error.message -- this reads
 * the first issue's own message out of a rejecting invoke() call. */
async function validationIssueMessage(pending: Promise<unknown>): Promise<string> {
	const error = await pending.then(
		() => {
			throw new Error("expected invoke() to reject");
		},
		(caught: unknown) => caught,
	);
	if (!isVehicleError(error)) throw error;
	const details = error.details as { issues?: Array<{ message?: string }> } | undefined;
	const message = details?.issues?.[0]?.message;
	if (!message) throw new Error(`expected a validation issue in error.details, got ${JSON.stringify(error.details)}`);
	return message;
}

describe("batch.execute (registerBatchVehicleOperation, wired through createPapyrusService)", () => {
	it("is registered as a real VehicleOperation, reachable via registry.invoke() the same way a Pi tool call reaches it", () => {
		const { registry } = harness();
		const names = registry.manifest().operations.map((op: VehicleManifestOperation) => op.name);
		expect(names).toContain("batch.execute");
	});

	it("fans out several independent items in one call, each reporting {ok:true, result} in request order", async () => {
		const { registry } = harness();
		const first = (await registry.invoke("tasks.create", 1, { title: "First", project_root: PROJECT }, TASK_PERMS)) as { id: string };
		const second = (await registry.invoke("tasks.create", 1, { title: "Second", project_root: PROJECT }, TASK_PERMS)) as { id: string };

		const response = (await registry.invoke(
			"batch.execute",
			1,
			{
				items: [
					{ op: "tasks.update", input: { id: first.id, title: "First renamed" } },
					{ op: "tasks.update", input: { id: second.id, title: "Second renamed" } },
				],
			},
			TASK_PERMS,
		)) as { results: Array<{ ok: boolean; result?: unknown; error?: string }> };

		expect(response.results).toEqual([
			{ ok: true, result: expect.objectContaining({ id: first.id, title: "First renamed" }) },
			{ ok: true, result: expect.objectContaining({ id: second.id, title: "Second renamed" }) },
		]);
	});

	it("propagates the outer call's own granted permissions to each item -- a permission that item genuinely lacks fails that item alone, never the whole batch, and never silently escalates", async () => {
		const { registry } = harness();
		const task = (await registry.invoke("tasks.create", 1, { title: "Needs permission", project_root: PROJECT }, TASK_PERMS)) as {
			id: string;
		};

		// batch.execute itself declares zero required permissions -- callable with an empty grant --
		// but the fanned-out tasks.update item still needs tasks:write, which this caller never granted.
		const response = (await registry.invoke(
			"batch.execute",
			1,
			{ items: [{ op: "tasks.update", input: { id: task.id, title: "Should not apply" } }] },
			{ permissions: [] },
		)) as { results: Array<{ ok: boolean; error?: string }> };

		expect(response.results).toHaveLength(1);
		expect(response.results[0]?.ok).toBe(false);
		expect(response.results[0]?.error).toContain("requires permissions");

		const stillOriginal = (await registry.invoke("tasks.show", 1, { id: task.id }, TASK_PERMS)) as { title: string };
		expect(stillOriginal.title).toBe("Needs permission");
	});

	it("partial failure: one item's own not-found error never rolls back or skips a sibling item", async () => {
		const { registry } = harness();
		const task = (await registry.invoke("tasks.create", 1, { title: "Sibling survives", project_root: PROJECT }, TASK_PERMS)) as {
			id: string;
		};

		const response = (await registry.invoke(
			"batch.execute",
			1,
			{
				items: [
					{ op: "tasks.update", input: { id: "not-a-real-id", title: "Ghost" } },
					{ op: "tasks.update", input: { id: task.id, title: "Really renamed" } },
				],
			},
			TASK_PERMS,
		)) as { results: Array<{ ok: boolean; result?: unknown; error?: string }> };

		expect(response.results[0]?.ok).toBe(false);
		expect(response.results[1]).toEqual({ ok: true, result: expect.objectContaining({ title: "Really renamed" }) });
	});

	it("rejects an empty items array or one over the bounded batch size before attempting any item, via the operation's own JSON schema", async () => {
		const { registry } = harness();
		const emptyIssue = await validationIssueMessage(registry.invoke("batch.execute", 1, { items: [] }, TASK_PERMS));
		expect(emptyIssue).toMatch(/at least 1 item/);
		const tooMany = Array.from({ length: 101 }, () => ({ op: "tasks.list", input: { project_root: PROJECT } }));
		const tooManyIssue = await validationIssueMessage(registry.invoke("batch.execute", 1, { items: tooMany }, TASK_PERMS));
		expect(tooManyIssue).toMatch(/more than 100 item/);
	});

	it("rejects an item with no op field via the operation's own JSON schema", async () => {
		const { registry } = harness();
		const issue = await validationIssueMessage(registry.invoke("batch.execute", 1, { items: [{ input: {} }] }, TASK_PERMS));
		expect(issue).toMatch(/op is required/);
	});
});
