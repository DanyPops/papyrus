import type { Artifact } from "./domain/artifact.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import {
	TASK_CONTEXT_ACTIVE_LIMIT,
	TASK_CONTEXT_FAILED_LIMIT,
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
		`Current: ${task.title} (${task.id})`,
		`Desired: ${desired}`,
		`Verify: ${gates.length > 0 ? gates.map(renderGate).join("; ") : "inspect the desired outcome; no automated gates configured"}`,
	];
}

export function taskContext(artifacts: ArtifactStore): string | null {
	const tasks = artifacts.query({ kind: "task" }).sort((left, right) => left.updated_at.localeCompare(right.updated_at));
	const open = tasks.filter((task) => task.status !== "done");
	if (open.length === 0) return null;

	const done = tasks.length - open.length;
	const active = open.filter((task) => task.status === "active").slice(0, TASK_CONTEXT_ACTIVE_LIMIT);
	const next = open.find((task) => task.status === "pending");
	const failed = open.filter((task) => task.status === "failed").slice(0, TASK_CONTEXT_FAILED_LIMIT);
	const lines = [`Progress: ${done}/${tasks.length} done`];
	for (const task of active) lines.push(...renderCurrent(task));
	if (next) lines.push(`Next: ${next.title} (${next.id})`);
	if (failed.length > 0) lines.push(`Blocked: ${failed.map((task) => `${task.title} (${task.id})`).join(", ")}`);
	lines.push("", TASK_RECONCILIATION_INSTRUCTION);
	return lines.join("\n");
}
