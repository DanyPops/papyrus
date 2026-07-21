import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Artifact } from "../../src/domain/artifact.ts";
import { PROOF_TYPES } from "../../src/domain/checklist.ts";
import type { GateResult } from "../../src/domain/gate.ts";
import type { TaskExecutionPlan } from "../../src/task-execution.ts";
import type { TaskHistoryPage } from "../../src/domain/task-event.ts";
import type { TaskCompletion, TaskGraph } from "../../src/task-service.ts";
import type { SkillWorkflowRunResult } from "../../src/skill-execution.ts";
import { emitTaskFocusEvent } from "./task-focus-events.ts";
import { NOTE_DISPOSITIONS } from "../../src/note-service.ts";
import { callService } from "./service-client.ts";
import { renderPapyrusToolCall, renderPapyrusToolResult } from "./tool-rendering/index.ts";
import {
	createArtifactDetails,
	createArtifactListDetails,
	createGateRunDetails,
	createGraphDetails,
	createInvocationDetails,
	createModelContent,
	createPreviewDetails,
} from "./tool-rendering/render-model.ts";

function text(message: string, details: unknown = {}) {
	const modelContent = createModelContent(message);
	return { content: [{ type: "text" as const, text: modelContent.text }], details };
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
		description: "Task domain tool. ACTIONS: create, update, list, show, history, scope, set_scope, assign_project, graph, plan, active, focused, focus, pause, unpause, clear_focus, start, submit, complete, reject, retry, cancel, run_gates, set_checklist, depend, undepend, contain, uncontain. Lifecycle is todo → in-progress → review → done, with review failure → rejected and retry → in-progress; canceled is terminal. update can recover a Task accidentally created terminal by setting status=todo with a reason, but cannot rewrite legitimate lifecycle history. Active focus is independent and identifies the one task auto-drive continues. Completion runs gates and checklist-proof review, then focuses one deterministic ready successor without claiming effort. Dependency cycles are rejected. undepend/uncontain are idempotent for an already-absent relationship and never start, complete, or focus work merely because an edge disappeared; uncontain removes both contains and part_of edges atomically. Prefer this over low-level papyrus_* tools for task work.",
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
		renderCall(args, theme) { return renderPapyrusToolCall("Tasks", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const action = params.action;
				// Defaults to this Pi session's own id so Focus reads/writes are isolated per agent
				// without depending on the model to know or supply its own session identity.
				const request = { ...params, project_root: params.project_root ?? ctx.cwd, actor: "agent", source: "pi-tool", session_id: params.session_id ?? ctx.sessionManager.getSessionId() };
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.create", request);
					return text(`Created task ${artifactLine(artifact)}`, createArtifactDetails("tasks.create", artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("tasks.list", request);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No tasks found.", createArtifactListDetails("tasks.list", rows));
				}
				if (action === "show") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.show", params);
					return text(`${artifactLine(artifact)}\n\n${artifact.body}`, createArtifactDetails("tasks.show", artifact));
				}
				if (action === "history") {
					const page = await callService<Record<string, unknown>, TaskHistoryPage>("tasks.history", request);
					const lines = page.events.map((event) => `${event.occurredAt} ${event.type} ${event.fromStatus ?? "∅"} → ${event.toStatus ?? "∅"} · ${event.actor}/${event.source}${event.reason ? ` · ${event.reason}` : ""}`);
					const output = lines.join("\n") || "No recorded history for this task.";
					return text(output, createPreviewDetails("tasks.history", "Task history", output));
				}
				if (action === "scope") {
					const selection = await callService<Record<string, unknown>, import("../../src/domain/task-scope.ts").TaskViewSelection>("tasks.scope", request);
					return text(`Task scope: ${selection.label}`, createPreviewDetails("tasks.scope", "Task scope", selection.label));
				}
				if (action === "active") {
					const artifact = await callService<Record<string, unknown>, Artifact | null>("tasks.active", request);
					return artifact
						? text(`Active: ${artifactLine(artifact)}`, createArtifactDetails("tasks.active", artifact))
						: text("No active task.", createPreviewDetails("tasks.active", "Active task", "No active task."));
				}
				if (action === "focused") {
					const focus = await callService<Record<string, unknown>, { artifact: Artifact; status: string } | null>("tasks.focused", request);
					return focus
						? text(`Focused (${focus.status}): ${artifactLine(focus.artifact)}`, createArtifactDetails("tasks.focused", focus.artifact))
						: text("No focused task.", createPreviewDetails("tasks.focused", "Focused task", "No focused task."));
				}
				if (action === "pause" || action === "unpause") {
					const operation = action === "pause" ? "tasks.pause" : "tasks.unpause";
					const focus = await callService<Record<string, unknown>, { artifact: Artifact; status: string }>(operation, request);
					emitTaskFocusEvent({ taskId: focus.artifact.id, sessionId: request.session_id as string, status: action === "pause" ? "paused" : "unpaused" });
					return text(`Focused (${focus.status}): ${artifactLine(focus.artifact)}`, createArtifactDetails(operation, focus.artifact));
				}
				if (action === "clear_focus") {
					const result = await callService<Record<string, unknown>, { cleared: boolean }>("tasks.clear_focus", request);
					if (result.cleared) emitTaskFocusEvent({ taskId: null, sessionId: request.session_id as string, status: "cleared" });
					const output = result.cleared ? "Task focus cleared." : "No focused task.";
					return text(output, createPreviewDetails("tasks.clear_focus", "Task focus", output));
				}
				if (action === "graph") {
					const graph = await callService<Record<string, unknown>, TaskGraph>("tasks.graph", request);
					const dependencies = graph.nodes.reduce((count, node) => count + node.dependencyIds.length, 0);
					const containment = graph.nodes.reduce((count, node) => count + node.childIds.length, 0);
					const edges = graph.nodes.flatMap((node) => [
						...node.dependencyIds.map((dependencyId) => ({ from: node.task.id, relation: "depends_on", to: dependencyId })),
						...node.childIds.map((childId) => ({ from: node.task.id, relation: "contains", to: childId })),
					]);
					return text(
						`Task graph: ${graph.nodes.length} nodes, ${graph.rootIds.length} roots, ${dependencies} dependencies, ${containment} containment edges.`,
						createGraphDetails("tasks.graph", graph.nodes.map((node) => node.task), edges),
					);
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
					const output = lines.join("\n") || "No tasks in execution plan.";
					return text(output, createPreviewDetails("tasks.plan", "Task execution plan", output));
				}
				if (action === "set_checklist") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.set_checklist", params);
					return text(`Updated checklist: ${artifactLine(artifact)}`, createArtifactDetails("tasks.set_checklist", artifact));
				}
				if (action === "complete") {
					const result = await callService<Record<string, unknown>, TaskCompletion>("tasks.complete", request);
					const gates = result.gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n");
					const checklist = result.checklist.map((item) => `${item.accepted ? "✓" : "✗"} proof: ${item.item}${item.reason ? ` — ${item.reason}` : ""}`).join("\n");
					const focused = result.focused ? `\nActive: ${artifactLine(result.focused)}` : "";
					const blocked = result.blocked.length > 0
						? `\nBlocked: ${result.blocked.map((entry) => `${artifactLine(entry.artifact)} waits for ${entry.dependencyIds.join(", ")}`).join("; ")}`
						: "";
					const output = `${result.completed ? "Completed" : "Rejected"}: ${artifactLine(result.artifact)}${focused}${blocked}${checklist ? `\n${checklist}` : ""}${gates ? `\n${gates}` : ""}`;
					return text(output, createPreviewDetails("tasks.complete", "Task completion", output));
				}
				if (action === "run_gates") {
					const gates = await callService<Record<string, unknown>, GateResult[]>("tasks.run_gates", request);
					return text(
						gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n") || "No gates configured.",
						createGateRunDetails("tasks.run_gates", params.id ?? "", gates.map((gate) => ({
							passed: gate.passed, type: gate.gate.type, target: gate.gate.target, output: gate.output,
						}))),
					);
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
					undepend: "tasks.undepend",
					contain: "tasks.contain",
					uncontain: "tasks.uncontain",
				} as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown tasks action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, request);
				if (operation === "tasks.focus") emitTaskFocusEvent({ taskId: artifact.id, sessionId: request.session_id as string, status: "focused" });
				return text(artifactLine(artifact), createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`tasks failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "notes",
		label: "Notes",
		description: "Deferred human-intent inbox. ACTIONS: capture, list, show, consume, promote, archive. Capture stores a request without creating work. Consume marks it considered. To promote, first create the resulting Task, Doc, Rule, or Skill through its domain tool, then link it with target_id. Archive requires an explicit disposition.",
		parameters: Type.Object({
			action: Type.String(),
			id: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("archived")])),
			text: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
			target_id: Type.Optional(Type.String()),
			disposition: Type.Optional(Type.Union(NOTE_DISPOSITIONS.map((value) => Type.Literal(value)))),
			reason: Type.Optional(Type.String()),
			session_id: Type.Optional(Type.String()),
			project_root: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Notes", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const action = params.action;
				const request = { ...params, project_root: params.project_root ?? ctx.cwd, actor: "agent", source: "notes-tool" };
				if (action === "capture") {
					const artifact = await callService<Record<string, unknown>, Artifact>("notes.capture", request);
					return text(`Captured note ${artifactLine(artifact)}`, createArtifactDetails("notes.capture", artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("notes.list", request);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No open notes.", createArtifactListDetails("notes.list", rows));
				}
				if (action === "show") {
					const artifact = await callService<Record<string, unknown>, Artifact>("notes.show", request);
					return text(`${artifactLine(artifact)}\n\n${artifact.body}`, createArtifactDetails("notes.show", artifact));
				}
				const operations = { consume: "notes.consume", promote: "notes.promote", archive: "notes.archive" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown notes action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, request);
				return text(`${action}: ${artifactLine(artifact)}`, createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`notes failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "docs",
		label: "Documents",
		description: "Document domain tool. ACTIONS: create, list, show, activate, archive, reopen, link, assign_project. project_root is optional at creation (omitted = unscoped); assign_project reassigns it later, or unscopes when project_root is omitted. Prefer this over low-level papyrus_* tools for document work.",
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
			project_root: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Documents", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, params) {
			try {
				const action = params.action;
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("docs.create", params);
					return text(`Created document ${artifactLine(artifact)}`, createArtifactDetails("docs.create", artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("docs.list", params);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No documents found.", createArtifactListDetails("docs.list", rows));
				}
				if (action === "show") {
					const artifact = await callService<Record<string, unknown>, Artifact>("docs.show", params);
					return text(`${artifactLine(artifact)}\n\n${artifact.body}`, createArtifactDetails("docs.show", artifact));
				}
				const operations = { activate: "docs.activate", archive: "docs.archive", reopen: "docs.reopen", link: "docs.link", assign_project: "docs.assign_project" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown docs action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(artifactLine(artifact), createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`docs failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "rules",
		label: "Rules",
		description: "Rule domain tool. ACTIONS: create, list, show, preview, enable, disable, gate, assign_project. project_root is optional at creation (omitted = unscoped); assign_project reassigns it later, or unscopes when project_root is omitted. Active rules inject into the agent system prompt.",
		parameters: Type.Object({
			action: Type.String(), id: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()), condition: Type.Optional(Type.String()), rule_action: Type.Optional(Type.String()),
			severity: Type.Optional(Type.String()), labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())), status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()), task_id: Type.Optional(Type.String()),
			project_root: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Rules", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, params) {
			try {
				const action = params.action;
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("rules.create", params);
					return text(`Created rule ${artifactLine(artifact)}`, createArtifactDetails("rules.create", artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("rules.list", params);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No rules found.", createArtifactListDetails("rules.list", rows));
				}
				if (action === "preview") {
					const preview = await callService<Record<string, unknown>, string>("rules.preview", params);
					return text(preview, createPreviewDetails("rules.preview", "Rule preview", preview));
				}
				const operations = { show: "rules.show", enable: "rules.enable", disable: "rules.disable", gate: "rules.gate", assign_project: "rules.assign_project" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown rules action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(`${artifactLine(artifact)}${action === "show" ? `\n\n${artifact.body}` : ""}`, createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`rules failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "skills",
		label: "Skills",
		description: "Papyrus Skill workflow and compatibility-template domain tool. Papyrus Skills are parameterized Task/Rule/Doc bundles, distinct from prompt-only skills. ACTIONS: create, create_template, list, show, invoke, run, enable, disable, instantiate, assign_project. run validates arguments and atomically creates one scoped workflow run. project_root is optional at creation (omitted = unscoped) for create/create_template; assign_project reassigns it later, or unscopes when project_root is omitted.",
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
		renderCall(args, theme) { return renderPapyrusToolCall("Skills", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const action = params.action;
				const request = { ...params, project_root: params.project_root ?? ctx.cwd };
				if (action === "create" || action === "create_template") {
					const operation = action === "create" ? "skills.create" : "skills.create_template";
					const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
					return text(`Created skill ${artifactLine(artifact)}`, createArtifactDetails(operation, artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("skills.list", params);
					return text(rows.length ? rows.map(artifactLine).join("\n") : "No skills found.", createArtifactListDetails("skills.list", rows));
				}
				if (action === "invoke") {
					const invocation = await callService<Record<string, unknown>, string>("skills.invoke", params);
					return text(invocation, createPreviewDetails("skills.invoke", "Skill invocation", invocation));
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
					].join("\n"), createInvocationDetails("skills.run", run.runId, {
						tasks: run.created.tasks,
						docs: run.created.docs,
						rules: run.created.rules,
						roots: run.rootTaskIds,
					}));
				}
				const operations = { show: "skills.show", enable: "skills.enable", disable: "skills.disable", instantiate: "skills.instantiate", assign_project: "skills.assign_project" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown skills action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, action === "instantiate" ? request : params);
				return text(`${artifactLine(artifact)}${action === "show" ? `\n\n${artifact.body}` : ""}`, createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`skills failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});
}
