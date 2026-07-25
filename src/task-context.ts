import type { Artifact } from "./domain/artifact.ts";
import { DISCUSSION_SUBTYPE, readDiscussionExtra } from "./domain/discussion.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import {
	TASK_CONTEXT_CURRENT_LIMIT,
	TASK_CONTEXT_REJECTED_LIMIT,
	TASK_RECONCILIATION_INSTRUCTION,
} from "./constants.ts";

interface Gate {
	type?: unknown;
	target?: unknown;
	expect?: unknown;
}

function gatesFrom(task: Artifact): Gate[] {
	const gates = task.extra["gates"];
	return Array.isArray(gates) ? gates as Gate[] : [];
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

/** Same scoping rule taskContext already applies to ordinary tasks, plus the focused task even if scope excludes it. */
function inScope(taskId: string, activeTaskId: string | undefined, taskIds: Set<string> | undefined): boolean {
	return taskIds === undefined || taskIds.has(taskId) || taskId === activeTaskId;
}

function deferredBlockingDiscussions(artifacts: ArtifactStore, activeTaskId: string | undefined, taskIds: Set<string> | undefined): string[] {
	const discussions = artifacts.query({ kind: "task", subtype: DISCUSSION_SUBTYPE })
		.filter((discussion) => {
			try { return readDiscussionExtra(discussion.extra).state === "deferred"; } catch { return false; }
		});
	if (discussions.length === 0) return [];

	const blocks = artifacts.relationships({ artifactIds: discussions.map((discussion) => discussion.id) })
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

export function taskContext(artifacts: ArtifactStore, activeTaskId?: string, taskIds?: Set<string>): string | null {
	const tasks = artifacts.query({ kind: "task", excludeSubtype: DISCUSSION_SUBTYPE })
		.filter((task) => taskIds === undefined || taskIds.has(task.id))
		.sort((left, right) => left.updated_at.localeCompare(right.updated_at));
	const open = tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
	const deferredDiscussions = deferredBlockingDiscussions(artifacts, activeTaskId, taskIds);
	if (open.length === 0 && deferredDiscussions.length === 0) return null;

	const done = tasks.length - open.length;
	const active = activeTaskId ? open.find((task) => task.id === activeTaskId) : undefined;
	const current = active ? [active] : open.filter((task) => task.status === "in-progress" || task.status === "review").slice(0, TASK_CONTEXT_CURRENT_LIMIT);
	const next = open.find((task) => task.status === "todo");
	const rejected = open.filter((task) => task.status === "rejected").slice(0, TASK_CONTEXT_REJECTED_LIMIT);
	const lines = tasks.length > 0 ? [`Progress: ${done}/${tasks.length} done`] : [];
	for (const task of current) lines.push(...renderCurrent(task));
	if (next) lines.push(`Next: ${next.title}`);
	if (rejected.length > 0) lines.push(`Rejected: ${rejected.map((task) => task.title).join(", ")}`);
	if (deferredDiscussions.length > 0) {
		lines.push("", "Deferred discussions blocking this scope -- resume and re-surface these, do not leave them dormant:");
		for (const line of deferredDiscussions) lines.push(`• ${line}`);
	}
	lines.push("", TASK_RECONCILIATION_INSTRUCTION);
	return lines.join("\n");
}
