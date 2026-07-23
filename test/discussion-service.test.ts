/**
 * Real end-to-end coverage of Discuss (see domain/discussion.ts and discussion-service.ts):
 * open/reply/defer/resume/settle, blocking a Task, and the Task-side enforcement in
 * task-service.ts's complete(). Runs against a real (in-memory) SQLite Db throughout.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteDiscussionRoundStore } from "../src/adapters/sqlite-discussion-round-store.ts";
import { SQLiteGateRunner } from "../src/adapters/sqlite-gate-runner.ts";
import { openDb } from "../src/db.ts";
import { Discussions, DiscussionError } from "../src/discussion-service.ts";
import { Tasks } from "../src/task-service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";
afterAll(cleanupTempDirs);

function fixture() {
	const dir = tempDir("papyrus-discuss-");
	const db = openDb(`${dir}/papyrus.db`);
	const artifacts = new SQLiteArtifactStore(db);
	const discussions = new Discussions(artifacts, new SQLiteDiscussionRoundStore(db));
	const tasks = new Tasks(artifacts, new SQLiteGateRunner(db));
	return { db, artifacts, discussions, tasks };
}

describe("Discussions.open", () => {
	it("creates an active discussion Doc with round 1 recorded", () => {
		const { discussions } = fixture();
		const { discussion, rounds } = discussions.open({ title: "Naming", actor: "alice", content: "Should we rename this?" });
		expect(discussion.kind).toBe("doc");
		expect(discussion.subtype).toBe("discussion");
		expect(discussion.status).toBe("active");
		expect(discussion.extra["discussion"]).toEqual({ state: "active", roundCount: 1 });
		expect(rounds).toHaveLength(1);
		expect(rounds[0]).toMatchObject({ roundNumber: 1, actor: "alice", content: "Should we rename this?" });
	});

	it("links blocksTaskIds to the discussion at open time", () => {
		const { discussions, tasks } = fixture();
		const task = tasks.create({ title: "Ship it", projectRoot: "/workspace" });
		const { discussion } = discussions.open({ title: "Blocker", actor: "alice", content: "Wait", blocksTaskIds: [task.id] });
		const shown = discussions.show(discussion.id);
		expect(shown.discussion.id).toBe(discussion.id);
		// blocking is proven properly via the Task-side test below (relationships isn't re-tested here)
	});

	it("rejects blocking a non-task artifact", () => {
		const { discussions, artifacts } = fixture();
		const doc = artifacts.create({ kind: "doc", title: "Not a task" });
		expect(() => discussions.open({ title: "x", actor: "a", content: "c", blocksTaskIds: [doc.id] })).toThrow(DiscussionError);
	});
});

describe("Discussions.reply", () => {
	it("appends successive rounds and increments roundCount", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		const first = discussions.reply(discussion.id, { actor: "bob", content: "response 1" });
		expect(first.discussion.extra["discussion"]).toMatchObject({ roundCount: 2 });
		const second = discussions.reply(discussion.id, { actor: "alice", content: "response 2" });
		expect(second.discussion.extra["discussion"]).toMatchObject({ roundCount: 3 });
		expect(second.rounds[0]).toMatchObject({ roundNumber: 3, actor: "alice", content: "response 2" });
	});

	it("refuses to reply to a deferred discussion", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		discussions.defer(discussion.id, "waiting on design review");
		expect(() => discussions.reply(discussion.id, { actor: "bob", content: "still here?" })).toThrow(/resume it/);
	});

	it("refuses to reply to a settled discussion", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		discussions.settle(discussion.id, "agreed on approach");
		expect(() => discussions.reply(discussion.id, { actor: "bob", content: "one more thing" })).toThrow(/resume it/);
	});
});

describe("Discussions.defer / resume", () => {
	it("defers an active discussion and resumes it back to active", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		const deferred = discussions.defer(discussion.id, "circle back next sprint");
		expect(deferred.extra["discussion"]).toMatchObject({ state: "deferred", deferredReason: "circle back next sprint" });
		const resumed = discussions.resume(discussion.id);
		expect(resumed.extra["discussion"]).toMatchObject({ state: "active" });
	});

	it("refuses to defer an already-deferred or settled discussion", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		discussions.defer(discussion.id);
		expect(() => discussions.defer(discussion.id)).toThrow(DiscussionError);
	});

	it("refuses to resume an active or settled discussion", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		expect(() => discussions.resume(discussion.id)).toThrow(/deferred Discussion can be resumed/);
		discussions.settle(discussion.id, "done");
		expect(() => discussions.resume(discussion.id)).toThrow(DiscussionError);
	});
});

describe("Discussions.settle", () => {
	it("settles from active, records the settlement, and archives the doc", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		const settled = discussions.settle(discussion.id, "we agreed on plan A");
		expect(settled.status).toBe("archived");
		expect(settled.extra["discussion"]).toMatchObject({ state: "settled", settlement: "we agreed on plan A" });
		expect((settled.extra["discussion"] as { settledAt: string }).settledAt).toBeTruthy();
	});

	it("settles from deferred too", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		discussions.defer(discussion.id);
		const settled = discussions.settle(discussion.id, "resolved offline");
		expect(settled.extra["discussion"]).toMatchObject({ state: "settled" });
	});

	it("refuses to settle an already-settled discussion", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		discussions.settle(discussion.id, "done");
		expect(() => discussions.settle(discussion.id, "done again")).toThrow(/already settled/);
	});
});

describe("Discussions.block / unblock", () => {
	it("blocks and unblocks idempotently", () => {
		const { discussions, tasks } = fixture();
		const task = tasks.create({ title: "Ship it", projectRoot: "/workspace" });
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		discussions.block(discussion.id, task.id);
		expect(discussions.unblock(discussion.id, task.id)).toBe(true);
		expect(discussions.unblock(discussion.id, task.id)).toBe(false); // idempotent
	});

	it("refuses to block once settled", () => {
		const { discussions, tasks } = fixture();
		const task = tasks.create({ title: "Ship it", projectRoot: "/workspace" });
		const { discussion } = discussions.open({ title: "T", actor: "alice", content: "opening" });
		discussions.settle(discussion.id, "done");
		expect(() => discussions.block(discussion.id, task.id)).toThrow(/no longer block/);
	});
});

describe("Discuss blocking a real Task's completion (task-service.ts integration)", () => {
	function readyTaskForCompletion(tasks: Tasks, title: string) {
		const task = tasks.create({ title, projectRoot: "/workspace" });
		tasks.transition(task.id, "start");
		tasks.transition(task.id, "submit");
		return task;
	}

	it("refuses tasks.complete while an active Discussion blocks the task", () => {
		const { discussions, tasks } = fixture();
		const task = readyTaskForCompletion(tasks, "Ship it");
		const { discussion } = discussions.open({ title: "Needs sign-off", actor: "alice", content: "hold on", blocksTaskIds: [task.id] });
		expect(() => tasks.complete(task.id)).toThrow(new RegExp(discussion.id));
	});

	it("allows tasks.complete once the blocking Discussion is settled", () => {
		const { discussions, tasks } = fixture();
		const task = readyTaskForCompletion(tasks, "Ship it");
		const { discussion } = discussions.open({ title: "Needs sign-off", actor: "alice", content: "hold on", blocksTaskIds: [task.id] });
		discussions.settle(discussion.id, "approved");
		expect(() => tasks.complete(task.id)).not.toThrow();
	});

	it("allows tasks.complete once the blocking Discussion is merely deferred (non-blocking by design)", () => {
		const { discussions, tasks } = fixture();
		const task = readyTaskForCompletion(tasks, "Ship it");
		const { discussion } = discussions.open({ title: "Needs sign-off", actor: "alice", content: "hold on", blocksTaskIds: [task.id] });
		discussions.defer(discussion.id, "not urgent");
		expect(() => tasks.complete(task.id)).not.toThrow();
	});

	it("does not block on a discussion that targets a different task", () => {
		const { discussions, tasks } = fixture();
		const task = readyTaskForCompletion(tasks, "Ship it");
		const otherTask = tasks.create({ title: "Unrelated", projectRoot: "/workspace" });
		discussions.open({ title: "Needs sign-off", actor: "alice", content: "hold on", blocksTaskIds: [otherTask.id] });
		expect(() => tasks.complete(task.id)).not.toThrow();
	});

	it("unblocking removes the restriction without settling the discussion", () => {
		const { discussions, tasks } = fixture();
		const task = readyTaskForCompletion(tasks, "Ship it");
		const { discussion } = discussions.open({ title: "Needs sign-off", actor: "alice", content: "hold on", blocksTaskIds: [task.id] });
		discussions.unblock(discussion.id, task.id);
		expect(() => tasks.complete(task.id)).not.toThrow();
	});
});

describe("Discuss: structured options (single/multi-select questions)", () => {
	it("open() poses a single-select choice on round 1 and records it as pending", () => {
		const { discussions } = fixture();
		const { discussion, rounds } = discussions.open({
			title: "Pick one", actor: "alice", content: "A or B?", options: ["A", "B"], optionsMode: "single",
		});
		expect(discussion.extra["discussion"]).toMatchObject({ pendingOptions: ["A", "B"], pendingOptionsMode: "single" });
		expect(rounds[0]).toMatchObject({ options: ["A", "B"], optionsMode: "single" });
	});

	it("reply() answers a pending single-select choice, clearing it, and records the selection on the round", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "Pick one", actor: "alice", content: "A or B?", options: ["A", "B"], optionsMode: "single" });
		const result = discussions.reply(discussion.id, { actor: "bob", content: "Going with B", selected: ["B"] });
		expect(result.discussion.extra["discussion"]).not.toHaveProperty("pendingOptions");
		expect(result.discussion.extra["discussion"]).not.toHaveProperty("pendingOptionsMode");
		expect(result.rounds[0]).toMatchObject({ selected: ["B"] });
	});

	it("refuses more than one selection when the pending choice is single-select", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "Pick one", actor: "alice", content: "A or B?", options: ["A", "B"], optionsMode: "single" });
		expect(() => discussions.reply(discussion.id, { actor: "bob", content: "Both!", selected: ["A", "B"] })).toThrow(/pick exactly one/);
	});

	it("allows several selections when the pending choice is multi-select", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "Pick some", actor: "alice", content: "Which apply?", options: ["A", "B", "C"], optionsMode: "multi" });
		const result = discussions.reply(discussion.id, { actor: "bob", content: "A and C", selected: ["A", "C"] });
		expect(result.rounds[0]).toMatchObject({ selected: ["A", "C"] });
	});

	it("refuses a selection that was never offered", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "Pick one", actor: "alice", content: "A or B?", options: ["A", "B"], optionsMode: "single" });
		expect(() => discussions.reply(discussion.id, { actor: "bob", content: "C!", selected: ["C"] })).toThrow(/not offered/);
	});

	it("refuses a selection when there is nothing pending to answer", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "Free-form", actor: "alice", content: "Thoughts?" });
		expect(() => discussions.reply(discussion.id, { actor: "bob", content: "B", selected: ["B"] })).toThrow(/no pending options/);
	});

	it("a reply can pose a new choice for the next round, replacing whatever was previously pending", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "Pick one", actor: "alice", content: "A or B?", options: ["A", "B"], optionsMode: "single" });
		const answered = discussions.reply(discussion.id, {
			actor: "bob", content: "B -- and now, should we also rename it?", selected: ["B"], options: ["Yes", "No"], optionsMode: "single",
		});
		expect(answered.discussion.extra["discussion"]).toMatchObject({ pendingOptions: ["Yes", "No"], pendingOptionsMode: "single" });
		expect(answered.rounds[0]).toMatchObject({ selected: ["B"], options: ["Yes", "No"], optionsMode: "single" });
		// The next reply answers the NEW pending question, not the original A/B one.
		const final = discussions.reply(discussion.id, { actor: "alice", content: "Yes", selected: ["Yes"] });
		expect(final.discussion.extra["discussion"]).not.toHaveProperty("pendingOptions");
	});

	it("rejects malformed options at open time: too few, duplicates, wrong mode", () => {
		const { discussions } = fixture();
		expect(() => discussions.open({ title: "T", actor: "a", content: "c", options: ["only-one"], optionsMode: "single" })).toThrow(/between 2 and/);
		expect(() => discussions.open({ title: "T", actor: "a", content: "c", options: ["A", "A"], optionsMode: "single" })).toThrow(/not repeat/);
		expect(() => discussions.open({ title: "T", actor: "a", content: "c", options: ["A", "B"], optionsMode: "quorum" as never })).toThrow(/options_mode must be/);
	});
});

describe("Discussions.list / listRounds", () => {
	it("lists discussions filtered by state", () => {
		const { discussions } = fixture();
		const active = discussions.open({ title: "Active one", actor: "a", content: "c" }).discussion;
		const toSettle = discussions.open({ title: "Settled one", actor: "a", content: "c" }).discussion;
		discussions.settle(toSettle.id, "done");
		expect(discussions.list({ state: "active" }).map((d) => d.id)).toEqual([active.id]);
		expect(discussions.list({ state: "settled" }).map((d) => d.id)).toEqual([toSettle.id]);
	});

	it("applies a bounded default limit when none is given (never falls through to an unbounded query)", () => {
		const { discussions } = fixture();
		for (let index = 0; index < 3; index++) discussions.open({ title: `T${index}`, actor: "a", content: "c" });
		expect(discussions.list().length).toBe(3);
		expect(discussions.list({ limit: 2 }).length).toBe(2);
		expect(discussions.list({ limit: 10_000 }).length).toBeLessThanOrEqual(200); // DISCUSSION_LIST_MAX_LIMIT
	});

	it("paginates rounds with afterRound", () => {
		const { discussions } = fixture();
		const { discussion } = discussions.open({ title: "T", actor: "a", content: "round 1" });
		discussions.reply(discussion.id, { actor: "b", content: "round 2" });
		discussions.reply(discussion.id, { actor: "a", content: "round 3" });
		expect(discussions.listRounds(discussion.id).map((r) => r.roundNumber)).toEqual([1, 2, 3]);
		expect(discussions.listRounds(discussion.id, 1).map((r) => r.roundNumber)).toEqual([2, 3]);
	});
});
