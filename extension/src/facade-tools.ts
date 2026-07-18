import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Artifact, GateResult } from "../../src/ops.ts";
import { callService } from "./service-client.ts";

function text(message: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: message }], details };
}

function artifactLine(artifact: Artifact): string {
	return `${artifact.id} [${artifact.status}] ${artifact.title}`;
}

export function registerFacadeTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "tasks",
		label: "Tasks",
		description: "Task domain facade. ACTIONS: create, list, show, start, complete (runs gates and refuses done on failure), fail, retry, run_gates, depend, contain. Prefer this over low-level papyrus_* tools for task work.",
		parameters: Type.Object({
			action: Type.String(),
			id: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
			labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			gates: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
			checklist: Type.Optional(Type.Array(Type.Unknown())),
			template_id: Type.Optional(Type.String()),
			parent_id: Type.Optional(Type.String()),
			child_id: Type.Optional(Type.String()),
			dependency_id: Type.Optional(Type.String()),
			depends_on: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params) {
			try {
				const action = params.action;
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.create", params);
					return text(`Created task ${artifactLine(artifact)}`, { artifact });
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("tasks.list", params);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No tasks found.", { rows });
				}
				if (action === "show") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.show", params);
					return text(`${artifactLine(artifact)}\n\n${artifact.body}`, { artifact });
				}
				if (action === "complete") {
					const result = await callService<Record<string, unknown>, { artifact: Artifact; gates: GateResult[]; completed: boolean }>("tasks.complete", params);
					const gates = result.gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n");
					return text(`${result.completed ? "Completed" : "Not completed"}: ${artifactLine(result.artifact)}${gates ? `\n${gates}` : ""}`, { ...result });
				}
				if (action === "run_gates") {
					const gates = await callService<Record<string, unknown>, GateResult[]>("tasks.run_gates", params);
					return text(gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n") || "No gates configured.", { gates });
				}
				const operations = { start: "tasks.start", fail: "tasks.fail", retry: "tasks.retry", depend: "tasks.depend", contain: "tasks.contain" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) return text(`Unknown tasks action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(artifactLine(artifact), { artifact });
			} catch (error) {
				return text(`tasks failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "docs",
		label: "Documents",
		description: "Document domain facade. ACTIONS: create, list, show, activate, archive, reopen, link. Prefer this over low-level papyrus_* tools for document work.",
		parameters: Type.Object({
			action: Type.String(),
			id: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			subtype: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
			labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			template_id: Type.Optional(Type.String()),
			relation: Type.Optional(Type.String()),
			target_id: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			try {
				const action = params.action;
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("docs.create", params);
					return text(`Created document ${artifactLine(artifact)}`, { artifact });
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("docs.list", params);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No documents found.", { rows });
				}
				if (action === "show") {
					const artifact = await callService<Record<string, unknown>, Artifact>("docs.show", params);
					return text(`${artifactLine(artifact)}\n\n${artifact.body}`, { artifact });
				}
				const operations = { activate: "docs.activate", archive: "docs.archive", reopen: "docs.reopen", link: "docs.link" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) return text(`Unknown docs action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(artifactLine(artifact), { artifact });
			} catch (error) {
				return text(`docs failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});
}
