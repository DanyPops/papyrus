import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Artifact } from "../../src/domain/artifact.ts";
import { PROOF_TYPES } from "../../src/domain/checklist.ts";
import type { GateResult } from "../../src/domain/gate.ts";
import type { TaskExecutionPlan } from "../../src/task-execution.ts";
import type { TaskHistoryPage } from "../../src/domain/task-event.ts";
import type { TaskCompletion, TaskGraph } from "../../src/task-service.ts";
import type { SkillWorkflowRunResult } from "../../src/skill-execution.ts";
import { callService } from "./service-client.ts";

function text(message: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: message }], details };
}

function artifactLine(artifact: Artifact): string {
	return `${artifact.id} [${artifact.status}] ${artifact.title}`;
}

const proofReferenceSchema = Type.Object({
	type: Type.Union(PROOF_TYPES.map((type) => Type.Literal(type))),
	target: Type.String(),
	expect: Type.Optional(Type.String()),
});

const checklistCriterionSchema = Type.Object({
	proof: Type.Array(proofReferenceSchema, { minItems: 1 }),
});

export function registerDomainTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "tasks",
		label: "Tasks",
		description: "Task domain tool. ACTIONS: create, update, list, show, history, scope, set_scope, assign_project, graph, plan, active, focused, focus, pause, unpause, clear_focus, start, submit, complete, reject, retry, cancel, run_gates, set_checklist, depend, contain. Lifecycle is todo → in-progress → review → done, with review failure → rejected and retry → in-progress; canceled is terminal. Active focus is independent and identifies the one task auto-drive continues. Completion runs gates and checklist-proof review, then focuses one deterministic ready successor without claiming effort. Dependency cycles are rejected. Prefer this over low-level papyrus_* tools for task work.",
		parameters: Type.Object({
			action: Type.String(),
			id: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
			cursor: Type.Optional(Type.Number()),
			direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
			reason: Type.Optional(Type.String()),
			session_id: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			gates: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
			checklist: Type.Optional(Type.Record(Type.String(), checklistCriterionSchema)),
			template_id: Type.Optional(Type.String()),
			parent_id: Type.Optional(Type.String()),
			child_id: Type.Optional(Type.String()),
			dependency_id: Type.Optional(Type.String()),
			depends_on: Type.Optional(Type.Array(Type.String())),
			project_root: Type.Optional(Type.String()),
			scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("graph"), Type.Literal("all")])),
			root_task_id: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const action = params.action;
				const request = { ...params, project_root: params.project_root ?? ctx.cwd, actor: "agent", source: "pi-tool" };
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.create", request);
					return text(`Created task ${artifactLine(artifact)}`, { artifact });
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("tasks.list", request);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No tasks found.", { rows });
				}
				if (action === "show") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.show", params);
					return text(`${artifactLine(artifact)}\n\n${artifact.body}`, { artifact });
				}
				if (action === "history") {
					const page = await callService<Record<string, unknown>, TaskHistoryPage>("tasks.history", request);
					const lines = page.events.map((event) => `${event.occurredAt} ${event.type} ${event.fromStatus ?? "∅"} → ${event.toStatus ?? "∅"} · ${event.actor}/${event.source}${event.reason ? ` · ${event.reason}` : ""}`);
					return text(lines.join("\n") || "No recorded history for this task.", { page });
				}
				if (action === "scope") {
					const selection = await callService<Record<string, unknown>, import("../../src/domain/task-scope.ts").TaskViewSelection>("tasks.scope", request);
					return text(`Task scope: ${selection.label}`, { selection });
				}
				if (action === "active") {
					const artifact = await callService<Record<string, unknown>, Artifact | null>("tasks.active", request);
					return text(artifact ? `Active: ${artifactLine(artifact)}` : "No active task.", { artifact });
				}
				if (action === "focused") {
					const focus = await callService<Record<string, unknown>, { artifact: Artifact; status: string } | null>("tasks.focused", request);
					return text(focus ? `Focused (${focus.status}): ${artifactLine(focus.artifact)}` : "No focused task.", { focus });
				}
				if (action === "pause" || action === "unpause") {
					const operation = action === "pause" ? "tasks.pause" : "tasks.unpause";
					const focus = await callService<Record<string, unknown>, { artifact: Artifact; status: string }>(operation, request);
					return text(`Focused (${focus.status}): ${artifactLine(focus.artifact)}`, { focus });
				}
				if (action === "clear_focus") {
					const result = await callService<Record<string, unknown>, { cleared: boolean }>("tasks.clear_focus", request);
					return text(result.cleared ? "Task focus cleared." : "No focused task.", result);
				}
				if (action === "graph") {
					const graph = await callService<Record<string, unknown>, TaskGraph>("tasks.graph", request);
					const dependencies = graph.nodes.reduce((count, node) => count + node.dependencyIds.length, 0);
					const containment = graph.nodes.reduce((count, node) => count + node.childIds.length, 0);
					return text(`Task graph: ${graph.nodes.length} nodes, ${graph.rootIds.length} roots, ${dependencies} dependencies, ${containment} containment edges.`, { graph });
				}
				if (action === "plan") {
					const plan = await callService<Record<string, unknown>, TaskExecutionPlan>("tasks.plan", request);
					const byId = new Map(plan.nodes.map((node) => [node.id, node]));
					const lines = plan.layers.flatMap((layer, index) => [
						`Layer ${index + 1}`,
						...layer.map((id) => {
							const node = byId.get(id);
							return node ? `  [${node.state}] ${node.id} ${node.title}` : `  [unknown] ${id}`;
						}),
					]);
					if (plan.cycleIds.length > 0) lines.push(`Invalid cycle: ${plan.cycleIds.join(", ")}`);
					return text(lines.join("\n") || "No tasks in execution plan.", { plan });
				}
				if (action === "set_checklist") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.set_checklist", params);
					return text(`Updated checklist: ${artifactLine(artifact)}`, { artifact });
				}
				if (action === "complete") {
					const result = await callService<Record<string, unknown>, TaskCompletion>("tasks.complete", request);
					const gates = result.gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n");
					const checklist = result.checklist.map((item) => `${item.accepted ? "✓" : "✗"} proof: ${item.item}${item.reason ? ` — ${item.reason}` : ""}`).join("\n");
					const focused = result.focused ? `\nActive: ${artifactLine(result.focused)}` : "";
					const blocked = result.blocked.length > 0
						? `\nBlocked: ${result.blocked.map((entry) => `${artifactLine(entry.artifact)} waits for ${entry.dependencyIds.join(", ")}`).join("; ")}`
						: "";
					return text(`${result.completed ? "Completed" : "Rejected"}: ${artifactLine(result.artifact)}${focused}${blocked}${checklist ? `\n${checklist}` : ""}${gates ? `\n${gates}` : ""}`, { ...result });
				}
				if (action === "run_gates") {
					const gates = await callService<Record<string, unknown>, GateResult[]>("tasks.run_gates", request);
					return text(gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n") || "No gates configured.", { gates });
				}
				const operations = {
					focus: "tasks.focus",
					start: "tasks.start",
					submit: "tasks.submit",
					reject: "tasks.reject",
					retry: "tasks.retry",
					cancel: "tasks.cancel",
					update: "tasks.update",
					set_scope: "tasks.set_scope",
					assign_project: "tasks.assign_project",
					depend: "tasks.depend",
					contain: "tasks.contain",
				} as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) return text(`Unknown tasks action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, request);
				return text(artifactLine(artifact), { artifact });
			} catch (error) {
				return text(`tasks failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "docs",
		label: "Documents",
		description: "Document domain tool. ACTIONS: create, list, show, activate, archive, reopen, link. Prefer this over low-level papyrus_* tools for document work.",
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

	pi.registerTool({
		name: "rules",
		label: "Rules",
		description: "Rule domain tool. ACTIONS: create, list, show, preview, enable, disable, gate. Active rules inject into the agent system prompt.",
		parameters: Type.Object({
			action: Type.String(), id: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()), condition: Type.Optional(Type.String()), rule_action: Type.Optional(Type.String()),
			severity: Type.Optional(Type.String()), labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())), status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()), task_id: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			try {
				const action = params.action;
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("rules.create", params);
					return text(`Created rule ${artifactLine(artifact)}`, { artifact });
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("rules.list", params);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No rules found.", { rows });
				}
				if (action === "preview") {
					const preview = await callService<Record<string, unknown>, string>("rules.preview", params);
					return text(preview, { preview });
				}
				const operations = { show: "rules.show", enable: "rules.enable", disable: "rules.disable", gate: "rules.gate" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) return text(`Unknown rules action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(`${artifactLine(artifact)}${action === "show" ? `\n\n${artifact.body}` : ""}`, { artifact });
			} catch (error) {
				return text(`rules failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "skills",
		label: "Skills",
		description: "Papyrus Skill workflow and compatibility-template domain tool. Papyrus Skills are parameterized Task/Rule/Doc bundles, distinct from prompt-only skills. ACTIONS: create, create_template, list, show, invoke, run, enable, disable, instantiate. run validates arguments and atomically creates one scoped workflow run.",
		parameters: Type.Object({
			action: Type.String(), id: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()), trigger: Type.Optional(Type.String()), steps: Type.Optional(Type.Array(Type.String())),
			tools: Type.Optional(Type.Array(Type.String())), definition: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())), run_id: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())), status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()), template_id: Type.Optional(Type.String()),
			target_kind: Type.Optional(Type.String()), defaults: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			required: Type.Optional(Type.Array(Type.String())), kind: Type.Optional(Type.String()), subtype: Type.Optional(Type.String()),
			project_root: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const action = params.action;
				const request = { ...params, project_root: params.project_root ?? ctx.cwd };
				if (action === "create" || action === "create_template") {
					const operation = action === "create" ? "skills.create" : "skills.create_template";
					const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
					return text(`Created skill ${artifactLine(artifact)}`, { artifact });
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("skills.list", params);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No skills found.", { rows });
				}
				if (action === "invoke") {
					const invocation = await callService<Record<string, unknown>, string>("skills.invoke", params);
					return text(invocation, { invocation });
				}
				if (action === "run") {
					const run = await callService<Record<string, unknown>, SkillWorkflowRunResult>("skills.run", request);
					const execution = run.execution.nodes.map((node) => `  [${node.state}] ${node.id} ${node.title}`).join("\n");
					return text([
						`Created Skill run ${run.runId}: ${run.created.tasks.length} tasks, ${run.created.rules.length} rules, ${run.created.docs.length} docs.`,
						`Ready roots: ${run.rootTaskIds.join(", ") || "none"}.`,
						`Context docs: ${run.created.docs.join(", ") || "none"}.`,
						`Scoped rules: ${run.created.rules.join(", ") || "none"}.`,
						...(execution ? ["Execution:", execution] : []),
					].join("\n"), { run });
				}
				const operations = { show: "skills.show", enable: "skills.enable", disable: "skills.disable", instantiate: "skills.instantiate" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) return text(`Unknown skills action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, action === "instantiate" ? request : params);
				return text(`${artifactLine(artifact)}${action === "show" ? `\n\n${artifact.body}` : ""}`, { artifact });
			} catch (error) {
				return text(`skills failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});
}
