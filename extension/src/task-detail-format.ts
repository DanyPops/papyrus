import type { Artifact } from "../../src/domain/artifact.ts";
import type { TaskEvent } from "../../src/domain/task-event.ts";
import { checklistEntries, type ProofReference } from "../../src/domain/checklist.ts";
import { formatMetadata } from "./artifact-format.ts";

const TASK_STATUS_GLYPHS: Record<string, string> = {
	todo: "○",
	"in-progress": "●",
	review: "◆",
	rejected: "▲",
	done: "■",
	canceled: "×",
};

function proofLine(proof: ProofReference): string {
	return `${proof.type} · ${proof.target}${proof.expect ? ` · ${proof.expect}` : ""}`;
}

function checklistLines(value: unknown): string[] {
	const entries = checklistEntries(value);
	if (entries.length === 0) return [];
	const lines = ["Checklist:"];
	for (const entry of entries) {
		lines.push(`  • ${entry.item}`);
		if (entry.proof.length === 0) {
			lines.push(`    proof: missing${entry.legacy ? " (legacy item)" : ""}`);
			continue;
		}
		lines.push("    proof:");
		for (const proof of entry.proof) lines.push(`      - ${proofLine(proof)}`);
	}
	return lines;
}

function gateLines(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) return [];
	const lines = ["Validation gates:"];
	for (const gate of value) {
		if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
			lines.push("  ? invalid gate configuration");
			continue;
		}
		const record = gate as Record<string, unknown>;
		const type = typeof record["type"] === "string" ? record["type"] : "unknown";
		const target = typeof record["target"] === "string" ? record["target"] : "missing target";
		const expect = typeof record["expect"] === "string" ? ` · ${record["expect"]}` : "";
		lines.push(`  ○ ${type} · ${target}${expect}`);
	}
	return lines;
}

function historyLines(history: TaskEvent[]): string[] {
	if (history.length === 0) return ["History:", "  (no post-migration events recorded)"];
	const lines = ["History:"];
	for (const event of history) {
		const transition = event.fromStatus || event.toStatus ? ` · ${event.fromStatus ?? "∅"} → ${event.toStatus ?? "∅"}` : "";
		const reason = event.reason ? ` · ${event.reason}` : "";
		lines.push(`  ${event.occurredAt} · ${event.type}${transition} · ${event.actor}/${event.source}${reason}`);
		if (event.evidence?.result) lines.push(`    result: ${event.evidence.result}`);
		if (Array.isArray(event.evidence?.gates)) {
			for (const value of event.evidence.gates) {
				if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
				const result = value as Record<string, unknown>;
				const gate = typeof result["gate"] === "object" && result["gate"] !== null ? result["gate"] as Record<string, unknown> : {};
				const passed = result["passed"] === true;
				lines.push(`    ${passed ? "✓" : "✗"} ${String(gate["type"] ?? "gate")} · ${String(gate["target"] ?? "unknown")}`);
			}
		}
	}
	return lines;
}

export interface TaskDetailContent {
	headline: string;
	identity: string;
	labels: string[];
	body: string;
	sections: string[][];
}

export function taskDetailContent(task: Artifact, history: TaskEvent[] = []): TaskDetailContent {
	const sections: string[][] = [];
	const checklist = checklistLines(task.extra["checklist"]);
	if (checklist.length > 0) sections.push(checklist);
	const gates = gateLines(task.extra["gates"]);
	if (gates.length > 0) sections.push(gates);
	const metadata = Object.fromEntries(Object.entries(task.extra).filter(([key]) => key !== "checklist" && key !== "gates"));
	if (Object.keys(metadata).length > 0) sections.push(["Metadata:", ...formatMetadata(metadata).map((line) => `  ${line}`)]);
	sections.push(historyLines(history));
	return {
		headline: `${TASK_STATUS_GLYPHS[task.status] ?? "?"} ${task.title}`,
		identity: `${task.id} [task|${task.status}]`,
		labels: [...task.labels],
		body: task.body || "(no body)",
		sections,
	};
}

export function taskDetailsText(task: Artifact, relationshipGraphLines: string[] = [], history: TaskEvent[] = []): string {
	const content = taskDetailContent(task, history);
	let output = `${content.headline}\n${content.identity}`;
	if (content.labels.length > 0) output += `\nLabels: ${content.labels.join(", ")}`;
	output += `\n\n${content.body}`;
	for (const section of content.sections) output += `\n\n${section.join("\n")}`;
	if (task.edges?.length) {
		const graph = relationshipGraphLines.length > 0 ? relationshipGraphLines.join("\n") : "  (graph unavailable)";
		output += `\n\nRelationships:\n  Dependencies point prerequisite → dependent.\n${graph}`;
	}
	return output;
}
