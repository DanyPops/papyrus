import type { Artifact } from "../artifact/artifact.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { TASK_CONTEXT_CURRENT_LIMIT, TASK_CONTEXT_REJECTED_LIMIT, TASK_RECONCILIATION_INSTRUCTION } from "../constants.ts";
import { DISCUSSION_SUBTYPE, readDiscussionExtra } from "../domain/discussion.ts";

interface Gate {
	type?: unknown;
	target?: unknown;
	expect?: unknown;
}

function gatesFrom(task: Artifact): Gate[] {
	const gates = task.extra.gates;
	return Array.isArray(gates) ? (gates as Gate[]) : [];
}

function renderGate(gate: Gate): string {
	const type = typeof gate.type === "string" ? gate.type : "gate";
	const target = typeof gate.target === "string" ? gate.target : "unspecified";
	const expect = typeof gate.expect === "string" && gate.expect.length > 0 ? ` = ${gate.expect}` : "";
	return `${type}: ${target}${expect}`;
}

function renderCurrent(task: Artifact): string[] {
	const desired = task.body.trim() || task.title;
	const gates = gatesFrom(task);
	return [
		`Current: ${task.title}`,
		`Desired: ${desired}`,
		`Verify: ${gates.length > 0 ? gates.map(renderGate).join("; ") : "inspect the desired outcome; no automated gates configured"}`,
	];
}

/** The unconditional-injection form: enough to know the current task and that fuller detail exists, without repeating its full Desired/Verify prose every turn. */
function renderCurrentSummary(task: Artifact): string[] {
	return [`Current: ${task.title} [${task.status}] -- call tasks(action="context") for the full current/desired/verify plan`];
}

/** Same scoping rule taskContext already applies to ordinary tasks, plus the focused task even if scope excludes it. */
function inScope(taskId: string, activeTaskId: string | undefined, taskIds: Set<string> | undefined): boolean {
	return taskIds === undefined || taskIds.has(taskId) || taskId === activeTaskId;
}

function deferredBlockingDiscussions(
	artifacts: ArtifactStore,
	activeTaskId: string | undefined,
	taskIds: Set<string> | undefined,
): string[] {
	const discussions = artifacts.query({ kind: "task", subtype: DISCUSSION_SUBTYPE }).filter((discussion) => {
		try {
			return readDiscussionExtra(discussion.extra).state === "deferred";
		} catch {
			return false;
		}
	});
	if (discussions.length === 0) return [];

	const blocks = artifacts
		.relationships({ artifactIds: discussions.map((discussion) => discussion.id) })
		.filter((edge) => edge.relation === "blocks");
	const lines: string[] = [];
	for (const discussion of discussions) {
		for (const edge of blocks) {
			if (edge.from !== discussion.id) continue;
			if (!inScope(edge.to, activeTaskId, taskIds)) continue;
			const blockedTask = artifacts.get(edge.to);
			if (!blockedTask || blockedTask.status === "done" || blockedTask.status === "canceled") continue;
			lines.push(`${discussion.title} -- blocks "${blockedTask.title}"`);
		}
	}
	return lines;
}

export type TaskContextVerbosity = "summary" | "full";

/**
 * verbosity="full" (the default, matching tasks(action="context") called on demand) renders the
 * current task's complete Desired/Verify plan. verbosity="summary" (used for the unconditional
 * system-prompt injection every turn) renders only enough for the agent to know a current task
 * exists and that the full plan is one explicit call away -- avoiding repeating the same
 * unchanged prose every single turn for a task that can persist across dozens of turns.
 */
export function taskContext(
	artifacts: ArtifactStore,
	activeTaskId?: string,
	taskIds?: Set<string>,
	verbosity: TaskContextVerbosity = "full",
): string | null {
	const tasks = artifacts
		.query({ kind: "task", excludeSubtype: DISCUSSION_SUBTYPE })
		.filter((task) => taskIds === undefined || taskIds.has(task.id))
		.sort((left, right) => left.updated_at.localeCompare(right.updated_at));
	const open = tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
	const deferredDiscussions = deferredBlockingDiscussions(artifacts, activeTaskId, taskIds);
	if (open.length === 0 && deferredDiscussions.length === 0) return null;

	const done = tasks.length - open.length;
	const active = activeTaskId ? open.find((task) => task.id === activeTaskId) : undefined;
	const current = active
		? [active]
		: open.filter((task) => task.status === "in-progress" || task.status === "review").slice(0, TASK_CONTEXT_CURRENT_LIMIT);
	const next = open.find((task) => task.status === "todo");
	const rejected = open.filter((task) => task.status === "rejected").slice(0, TASK_CONTEXT_REJECTED_LIMIT);
	const lines = tasks.length > 0 ? [`Progress: ${done}/${tasks.length} done`] : [];
	const renderTask = verbosity === "summary" ? renderCurrentSummary : renderCurrent;
	for (const task of current) lines.push(...renderTask(task));
	if (next) lines.push(`Next: ${next.title}`);
	if (rejected.length > 0) lines.push(`Rejected: ${rejected.map((task) => task.title).join(", ")}`);
	if (deferredDiscussions.length > 0) {
		lines.push("", "Deferred discussions blocking this scope -- resume and re-surface these, do not leave them dormant:");
		for (const line of deferredDiscussions) lines.push(`• ${line}`);
	}
	lines.push("", TASK_RECONCILIATION_INSTRUCTION);
	return lines.join("\n");
}
