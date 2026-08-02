import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PERMS = { permissions: ["discuss:read", "discuss:write", "tasks:read", "tasks:write", "artifact:read", "artifact:write"] };

function harness() {
	const directory = tempDir("papyrus-discuss-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("registerDiscussVehicleOperations (wired through createPapyrusService)", () => {
	it("registers exactly one honest VehicleOperation per real discuss.* action, never an action-dispatch schema", () => {
		const { registry, service } = harness();
		const names = registry
			.manifest()
			.operations.map((op: VehicleManifestOperation) => op.name)
			.filter((name: string) => name.startsWith("discuss."))
			.sort();
		expect(names).toEqual([
			"discuss.block",
			"discuss.defer",
			"discuss.list",
			"discuss.open",
			"discuss.reply",
			"discuss.resume",
			"discuss.rounds",
			"discuss.settle",
			"discuss.show",
			"discuss.unblock",
		]);
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("discuss.list", 1, {})).rejects.toThrow(/requires permissions/);
		service.close();
	});

	it("open records round 1, carries a model-facing content block, and defaults a missing actor to 'agent'", async () => {
		const { registry, service } = harness();
		const result = (await registry.invoke(
			"discuss.open",
			1,
			{ title: "Which Result library?", content: "neverthrow or better-result?" },
			PERMS,
		)) as { discussion: { title: string }; rounds: { roundNumber: number; actor: string }[]; content: { type: string; text: string }[] };
		expect(result.discussion.title).toBe("Which Result library?");
		expect(result.rounds[0]?.roundNumber).toBe(1);
		expect(result.rounds[0]?.actor).toBe("agent");
		expect(result.content[0]?.text).toContain("Which Result library?");
		service.close();
	});

	it("open honors an explicit actor instead of defaulting it", async () => {
		const { registry, service } = harness();
		const result = (await registry.invoke("discuss.open", 1, { title: "Explicit actor", content: "hello", actor: "human" }, PERMS)) as {
			rounds: { actor: string }[];
		};
		expect(result.rounds[0]?.actor).toBe("human");
		service.close();
	});

	it("open normalizes bare-string and {title,description} options into parallel arrays", async () => {
		const { registry, service } = harness();
		const result = (await registry.invoke(
			"discuss.open",
			1,
			{
				title: "Pick one",
				content: "which?",
				options: ["A", { title: "B", description: "the risky one" }],
				options_mode: "single",
			},
			PERMS,
		)) as { discussion: { extra: { discussion: { pendingOptions: string[]; pendingOptionDescriptions?: string[] } } } };
		expect(result.discussion.extra.discussion.pendingOptions).toEqual(["A", "B"]);
		expect(result.discussion.extra.discussion.pendingOptionDescriptions).toEqual(["", "the risky one"]);
		service.close();
	});

	it("open/reply accept a live:true field without the schema's additionalProperties:false rejecting it -- purely a client-side hint, never read server-side", async () => {
		const { registry, service } = harness();
		const opened = (await registry.invoke("discuss.open", 1, { title: "Live flag", content: "start", live: true }, PERMS)) as {
			discussion: { id: string };
		};
		const replied = (await registry.invoke("discuss.reply", 1, { id: opened.discussion.id, content: "round 2", live: true }, PERMS)) as {
			rounds: { roundNumber: number }[];
		};
		expect(replied.rounds[0]?.roundNumber).toBe(2);
		service.close();
	});

	it("reply resolves the discussion by name and appends round 2", async () => {
		const { registry, service } = harness();
		await registry.invoke("discuss.open", 1, { title: "Named discussion", content: "round 1" }, PERMS);

		const replied = (await registry.invoke(
			"discuss.reply",
			1,
			{ name: "Named discussion", content: "round 2", actor: "human" },
			PERMS,
		)) as { rounds: { roundNumber: number }[]; content: { text: string }[] };
		expect(replied.rounds[0]?.roundNumber).toBe(2);
		expect(replied.content[0]?.text).toContain("Named discussion");
		service.close();
	});

	it("defer then resume round-trips a discussion's state, each carrying a content block", async () => {
		const { registry, service } = harness();
		const opened = (await registry.invoke("discuss.open", 1, { title: "Pause me", content: "start" }, PERMS)) as {
			discussion: { id: string };
		};

		const deferred = (await registry.invoke("discuss.defer", 1, { id: opened.discussion.id, reason: "waiting on input" }, PERMS)) as {
			extra: { discussion: { state: string; deferredReason?: string } };
			content: { text: string }[];
		};
		expect(deferred.extra.discussion.state).toBe("deferred");
		expect(deferred.extra.discussion.deferredReason).toBe("waiting on input");
		expect(deferred.content[0]?.text).toContain("Pause me");

		const resumed = (await registry.invoke("discuss.resume", 1, { name: "Pause me" }, PERMS)) as {
			extra: { discussion: { state: string } };
		};
		expect(resumed.extra.discussion.state).toBe("active");
		service.close();
	});

	it("settle is terminal", async () => {
		const { registry, service } = harness();
		const opened = (await registry.invoke("discuss.open", 1, { title: "Wrap it up", content: "start" }, PERMS)) as {
			discussion: { id: string };
		};

		const settled = (await registry.invoke(
			"discuss.settle",
			1,
			{ id: opened.discussion.id, settlement: "went with neverthrow" },
			PERMS,
		)) as { status: string; extra: { discussion: { state: string; settlement: string } } };
		expect(settled.status).toBe("done");
		expect(settled.extra.discussion.state).toBe("settled");
		expect(settled.extra.discussion.settlement).toBe("went with neverthrow");

		await expect(registry.invoke("discuss.reply", 1, { id: opened.discussion.id, content: "too late" }, PERMS)).rejects.toThrow();
		service.close();
	});

	it("block resolves both the discussion and the task by name, and unblock is idempotent", async () => {
		const { registry, service } = harness();
		const opened = (await registry.invoke("discuss.open", 1, { title: "Blocking discussion", content: "start" }, PERMS)) as {
			discussion: { id: string };
		};
		const task = (await service.execute("tasks.create", { title: "Blocked task", project_root: "/tmp/discuss-vehicle" })) as {
			id: string;
		};

		const blocked = (await registry.invoke("discuss.block", 1, { name: "Blocking discussion", task_name: "Blocked task" }, PERMS)) as {
			blocked: boolean;
			content: { text: string }[];
		};
		expect(blocked.blocked).toBe(true);
		expect(blocked.content[0]?.text).toBe('"Blocking discussion" now blocks "Blocked task"');

		const unblocked = (await registry.invoke("discuss.unblock", 1, { id: opened.discussion.id, task_id: task.id }, PERMS)) as {
			unblocked: boolean;
		};
		expect(unblocked.unblocked).toBe(true);

		const secondUnblock = (await registry.invoke("discuss.unblock", 1, { id: opened.discussion.id, task_id: task.id }, PERMS)) as {
			unblocked: boolean;
			content: { text: string }[];
		};
		expect(secondUnblock.unblocked).toBe(false);
		expect(secondUnblock.content[0]?.text).toBe("No such blocking relationship.");
		service.close();
	});

	it("block never confuses a real Task with a same-titled Discussion", async () => {
		const { registry, service } = harness();
		await registry.invoke("discuss.open", 1, { title: "Same Title", content: "the discussion" }, PERMS);
		const task = (await service.execute("tasks.create", { title: "Same Title", project_root: "/tmp/discuss-vehicle-2" })) as {
			id: string;
		};
		const opened = (await registry.invoke("discuss.open", 1, { title: "Blocker", content: "start" }, PERMS)) as {
			discussion: { id: string };
		};

		const blocked = (await registry.invoke("discuss.block", 1, { id: opened.discussion.id, task_name: "Same Title" }, PERMS)) as {
			blocked: boolean;
		};
		expect(blocked.blocked).toBe(true);

		const tree = (await service.execute("graph.tree", { id: opened.discussion.id, depth: 1 })) as {
			edges: { relation: string; from: string; to: string }[];
		};
		const blocksEdge = tree.edges.find((edge) => edge.relation === "blocks" && edge.from === opened.discussion.id);
		expect(blocksEdge?.to).toBe(task.id);
		service.close();
	});

	it("show returns the full transcript with a content block, resolved by name", async () => {
		const { registry, service } = harness();
		await registry.invoke("discuss.open", 1, { title: "Transcript test", content: "round 1" }, PERMS);
		const opened2 = (await registry.invoke("discuss.reply", 1, { name: "Transcript test", content: "round 2" }, PERMS)) as {
			discussion: { id: string };
		};

		const shown = (await registry.invoke("discuss.show", 1, { id: opened2.discussion.id }, PERMS)) as {
			rounds: { roundNumber: number }[];
			content: { text: string }[];
		};
		expect(shown.rounds).toHaveLength(2);
		expect(shown.content[0]?.text).toContain("round 1");
		expect(shown.content[0]?.text).toContain("round 2");
		service.close();
	});

	it("rounds wraps the raw array with a content block instead of a bare array", async () => {
		const { registry, service } = harness();
		const opened = (await registry.invoke("discuss.open", 1, { title: "Rounds test", content: "round 1" }, PERMS)) as {
			discussion: { id: string };
		};

		const result = (await registry.invoke("discuss.rounds", 1, { id: opened.discussion.id }, PERMS)) as {
			rounds: unknown[];
			content: { text: string }[];
		};
		expect(result.rounds).toHaveLength(1);
		expect(result.content[0]?.text).toContain("round 1");
		service.close();
	});

	it("list wraps the raw array with a content block and supports a state filter", async () => {
		const { registry, service } = harness();
		await registry.invoke("discuss.open", 1, { title: "Active one", content: "start" }, PERMS);
		const other = (await registry.invoke("discuss.open", 1, { title: "Deferred one", content: "start" }, PERMS)) as {
			discussion: { id: string };
		};
		await registry.invoke("discuss.defer", 1, { id: other.discussion.id }, PERMS);

		const activeOnly = (await registry.invoke("discuss.list", 1, { state: "active" }, PERMS)) as {
			discussions: { title: string }[];
			content: { text: string }[];
		};
		expect(activeOnly.discussions.map((d) => d.title)).toEqual(["Active one"]);
		expect(activeOnly.content[0]?.text).toContain("Active one");
		service.close();
	});

	it("list with no discussions renders a friendly empty message, not a bare empty array", async () => {
		const { registry, service } = harness();
		const empty = (await registry.invoke("discuss.list", 1, { state: "settled" }, PERMS)) as {
			discussions: unknown[];
			content: { text: string }[];
		};
		expect(empty.discussions).toEqual([]);
		expect(empty.content[0]?.text).toBe("No discussions found.");
		service.close();
	});
});
