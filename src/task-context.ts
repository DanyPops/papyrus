import type { Db } from "./db.ts";
import {
	TASK_CONTEXT_ACTIVE_LIMIT,
	TASK_CONTEXT_FAILED_LIMIT,
	TASK_RECONCILIATION_INSTRUCTION,
} from "./constants.ts";

interface TaskRow {
	id: string;
	title: string;
	status: string;
	body: string;
	extra: string;
}

interface Gate {
	type?: unknown;
	target?: unknown;
	expect?: unknown;
}

function gatesFrom(row: TaskRow): Gate[] {
	try {
		const extra = JSON.parse(row.extra) as { gates?: unknown };
		return Array.isArray(extra.gates) ? extra.gates as Gate[] : [];
	} catch {
		return [];
	}
}

function renderGate(gate: Gate): string {
	const type = typeof gate.type === "string" ? gate.type : "gate";
	const target = typeof gate.target === "string" ? gate.target : "unspecified";
	const expect = typeof gate.expect === "string" && gate.expect.length > 0 ? ` = ${gate.expect}` : "";
	return `${type}: ${target}${expect}`;
}

function renderCurrent(task: TaskRow): string[] {
	const desired = task.body.trim() || task.title;
	const gates = gatesFrom(task);
	return [
		`Current: ${task.title} (${task.id})`,
		`Desired: ${desired}`,
		`Verify: ${gates.length > 0 ? gates.map(renderGate).join("; ") : "inspect the desired outcome; no automated gates configured"}`,
	];
}

/** Project open task state into a compact Alef-style reconciliation context. */
export function taskContextFromDb(db: Db): string | null {
	const tasks = db.prepare(
		"SELECT id, title, status, body, extra FROM artifacts WHERE kind = 'task' ORDER BY updated_at ASC",
	).all() as TaskRow[];
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
