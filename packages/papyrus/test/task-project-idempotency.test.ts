import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { TASK_CREATE_IDEMPOTENCY_RETENTION_MS } from "../src/constants.ts";
import { openDb } from "../src/db.ts";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PERMS = { permissions: ["tasks:read", "tasks:write"], principal: { id: "test-caller" } };

describe("Task project registry", () => {
	it("discovers, resolves, renames, and moves registered projects while preserving aliases and task scope", async () => {
		const service = createPapyrusService(join(tempDir("papyrus-task-projects-"), "papyrus.db"));
		const oldRoot = "/tmp/workspaces/papyrus";
		const newRoot = "/tmp/projects/papyrus-next";
		await service.vehicle.invoke("tasks.create", 1, { title: "Scoped task", project_root: oldRoot }, PERMS);

		const discovered = (await service.vehicle.invoke("tasks.projects", 1, { query: "PAPYRUS" }, PERMS)) as Array<{
			id: string;
			name: string;
			projectRoot: string;
		}>;
		expect(discovered).toHaveLength(1);
		expect(discovered[0]).toMatchObject({ name: "papyrus", projectRoot: oldRoot });

		const moved = (await service.vehicle.invoke(
			"tasks.register_project",
			1,
			{ project: "Papyrus", project_root: newRoot, name: "Papyrus Next", aliases: ["PAP"] },
			PERMS,
		)) as { id: string; aliases: string[]; projectRoot: string };
		expect(moved.id).toBe(discovered[0]!.id);
		expect(moved.aliases).toEqual(expect.arrayContaining(["papyrus", "PAP"]));
		expect(moved.projectRoot).toBe(newRoot);

		for (const reference of ["papyrus next", "PAP", "papyrus", moved.id]) {
			const resolved = (await service.vehicle.invoke("tasks.resolve_project", 1, { name: reference }, PERMS)) as {
				id: string;
				projectRoot: string;
			};
			expect(resolved).toMatchObject({ id: moved.id, projectRoot: newRoot });
		}
		const tasks = (await service.vehicle.invoke("tasks.list", 1, { project_root: newRoot }, PERMS)) as Array<{ title: string }>;
		expect(tasks.map((task) => task.title)).toContain("Scoped task");
		service.close();
	});

	it("fails closed with bounded candidates for unknown and ambiguous aliases", async () => {
		const service = createPapyrusService(join(tempDir("papyrus-task-project-errors-"), "papyrus.db"));
		await service.vehicle.invoke("tasks.register_project", 1, { project_root: "/tmp/a", name: "Alpha", aliases: ["shared"] }, PERMS);
		await service.vehicle.invoke("tasks.register_project", 1, { project_root: "/tmp/b", name: "Beta", aliases: ["SHARED"] }, PERMS);
		for (let index = 0; index < 11; index += 1) {
			await service.vehicle.invoke(
				"tasks.register_project",
				1,
				{ project_root: `/tmp/candidate-${index}`, name: `Candidate ${String(index).padStart(2, "0")}` },
				PERMS,
			);
		}

		const unknown = await service.vehicle.invoke("tasks.resolve_project", 1, { name: "missing" }, PERMS).catch((error) => error);
		expect(unknown).toMatchObject({ code: "task-project-not-found", category: "not_found" });
		expect((unknown as Error).message).toContain("Alpha (/tmp/a)");
		expect((unknown as Error).message).not.toContain("Candidate 10");
		const ambiguous = await service.vehicle.invoke("tasks.resolve_project", 1, { name: "shared" }, PERMS).catch((error) => error);
		expect(ambiguous).toMatchObject({ code: "task-project-ambiguous", category: "conflict" });
		expect((ambiguous as Error).message).toContain("Alpha (/tmp/a)");
		expect((ambiguous as Error).message).toContain("Beta (/tmp/b)");
		service.close();
	});
});

describe("tasks.create idempotency", () => {
	it("replays the original response, rejects payload conflicts, and isolates keys by project", async () => {
		const path = join(tempDir("papyrus-task-create-idempotency-"), "papyrus.db");
		const service = createPapyrusService(path);
		const input = { title: "Retry-safe", project_root: "/tmp/project-a", idempotency_key: "request-1" };
		const original = (await service.vehicle.invoke("tasks.create", 1, input, PERMS)) as { id: string };
		const replay = (await service.vehicle.invoke("tasks.create", 1, input, PERMS)) as { id: string };
		expect(replay).toEqual(original);
		const rows = (await service.vehicle.invoke("tasks.list", 1, { project_root: "/tmp/project-a" }, PERMS)) as unknown[];
		expect(rows).toHaveLength(1);

		const conflict = await service.vehicle.invoke("tasks.create", 1, { ...input, title: "Different" }, PERMS).catch((error) => error);
		expect(conflict).toMatchObject({ code: "idempotency-key-conflict", category: "conflict" });
		await expect(
			service.vehicle.invoke(
				"tasks.create",
				1,
				{ title: "Not silently unkeyed", project_root: "/tmp/project-a", idempotency_key: " " },
				PERMS,
			),
		).rejects.toThrow("idempotency key must be between 1 and 200 characters");

		const isolated = (await service.vehicle.invoke(
			"tasks.create",
			1,
			{ title: "Retry-safe", project_root: "/tmp/project-b", idempotency_key: "request-1" },
			PERMS,
		)) as { id: string };
		expect(isolated.id).not.toBe(original.id);
		const otherCaller = (await service.vehicle.invoke("tasks.create", 1, input, {
			...PERMS,
			principal: { id: "other-caller" },
		})) as { id: string };
		expect(otherCaller.id).not.toBe(original.id);
		service.close();
	});

	it("coalesces concurrent duplicate requests and survives response-loss replay across restarts", async () => {
		const path = join(tempDir("papyrus-task-create-restart-"), "papyrus.db");
		const input = { title: "One mutation", project_root: "/tmp/project", idempotency_key: "request-2" };
		const first = createPapyrusService(path);
		const concurrent = await Promise.all([
			first.vehicle.invoke("tasks.create", 1, input, PERMS),
			first.vehicle.invoke("tasks.create", 1, input, PERMS),
		]);
		expect((concurrent[0] as { id: string }).id).toBe((concurrent[1] as { id: string }).id);
		const lostResponse = concurrent[0];
		first.close();

		const replacement = createPapyrusService(path);
		const replay = await replacement.vehicle.invoke("tasks.create", 1, input, PERMS);
		expect(replay).toEqual(lostResponse);
		replacement.close();
	});

	it("expires retained keys after the advertised bounded retention window", async () => {
		const path = join(tempDir("papyrus-task-create-expiry-"), "papyrus.db");
		const input = { title: "Expiring request", project_root: "/tmp/project", idempotency_key: "request-3" };
		const first = createPapyrusService(path);
		const original = (await first.vehicle.invoke("tasks.create", 1, input, PERMS)) as { id: string };
		first.close();

		const db = openDb(path);
		db.prepare("UPDATE task_create_requests SET expires_at = ?").run(new Date(Date.now() - 1).toISOString());
		db.close();

		const replacement = createPapyrusService(path);
		const afterExpiry = (await replacement.vehicle.invoke("tasks.create", 1, input, PERMS)) as { id: string };
		expect(afterExpiry.id).not.toBe(original.id);
		const createDescriptor = replacement.vehicle
			.manifest()
			.operations.find((operation: VehicleManifestOperation) => operation.name === "tasks.create")!;
		expect(createDescriptor.inputSchema.properties).toHaveProperty("idempotency_key");
		expect(TASK_CREATE_IDEMPOTENCY_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1_000);
		replacement.close();
	});
});

describe("Task evidence schemas", () => {
	it("publishes nested checklist and gate schemas from the same enums and bounds runtime validation uses", () => {
		const service = createPapyrusService(join(tempDir("papyrus-task-schema-"), "papyrus.db"));
		const operation = service.vehicle
			.manifest()
			.operations.find((candidate: VehicleManifestOperation) => candidate.name === "tasks.create")!;
		const properties = operation.inputSchema.properties as Record<string, Record<string, unknown>>;
		expect(properties.gates?.items).toMatchObject({
			type: "object",
			properties: {
				type: { enum: ["file-exists", "command", "contains", "test"] },
				timeoutMs: { type: "integer", minimum: 1_000 },
			},
			required: ["type", "target"],
		});
		expect(properties.gates?.examples).toHaveLength(4);
		// patternProperties, not additionalProperties-as-schema: TypeBox's own client-side validator
		// reports the latter only as a generic top-level "must not have additional properties", with
		// no descent into the real nested violation -- see handlers/tasks.ts's checklistProp.
		const checklistPattern = properties.checklist?.patternProperties as Record<string, unknown> | undefined;
		expect(checklistPattern?.["^.*$"]).toMatchObject({
			type: "object",
			properties: { proof: { type: "array", minItems: 1 } },
			required: ["proof"],
		});
		expect(properties.checklist?.additionalProperties).toBe(false);
		service.close();
	});
});
