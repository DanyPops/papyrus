import type { Artifact } from "../../src/domain/artifact.ts";
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

export function taskDetailsText(task: Artifact, relationshipGraphLines: string[] = []): string {
	let output = `${TASK_STATUS_GLYPHS[task.status] ?? "?"} ${task.title}\n${task.id} [task|${task.status}]`;
	if (task.labels.length > 0) output += `\nLabels: ${task.labels.join(", ")}`;
	output += `\n\n${task.body || "(no body)"}`;
	const checklist = checklistLines(task.extra["checklist"]);
	if (checklist.length > 0) output += `\n\n${checklist.join("\n")}`;
	const gates = gateLines(task.extra["gates"]);
	if (gates.length > 0) output += `\n\n${gates.join("\n")}`;
	const metadata = Object.fromEntries(Object.entries(task.extra).filter(([key]) => key !== "checklist" && key !== "gates"));
	if (Object.keys(metadata).length > 0) {
		output += `\n\nMetadata:\n${formatMetadata(metadata).map((line) => `  ${line}`).join("\n")}`;
	}
	if (task.edges?.length) {
		const graph = relationshipGraphLines.length > 0 ? relationshipGraphLines.join("\n") : "  (graph unavailable)";
		output += `\n\nRelationships:\n  Dependencies point prerequisite → dependent.\n${graph}`;
	}
	return output;
}
