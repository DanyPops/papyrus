import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Artifact } from "../../src/domain/artifact.ts";
import { PROOF_TYPES } from "../../src/domain/checklist.ts";
import type { GateResult } from "../../src/domain/gate.ts";
import type { TaskExecutionPlan } from "../../src/task-execution.ts";
import type { TaskHistoryPage } from "../../src/domain/task-event.ts";
import type { TaskCompletion, TaskGraph } from "../../src/task-service.ts";
import type { SkillWorkflowRunResult } from "../../src/skill-execution.ts";
import type { DiscussionAndRounds } from "../../src/discussion-service.ts";
import type { DiscussionRound } from "../../src/domain/discussion.ts";
import type { OperationName } from "../../src/service.ts";
import { emitTaskFocusEvent } from "./task-focus-events.ts";
import { sessionSecretField } from "./session-identity.ts";
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

/**
 * Every domain tool's primary interfacing point is an artifact's NAME, not its id -- id is a
 * backend implementation detail (a stable key other operations need, and titles aren't
 * guaranteed unique), so it stays out of what the model reads by default. It only resurfaces
 * when genuinely needed to tell two same-titled artifacts apart (artifactLines below), or in a
 * matchArtifactByName disambiguation error, never as a matter of course.
 */
export function artifactLine(artifact: Artifact): string {
	return `[${artifact.status}] ${artifact.title}`;
}

/** Appends " (id)" only for artifacts whose title collides with another in this same result set. */
export function artifactLines(artifacts: Artifact[]): string[] {
	const titleCounts = new Map<string, number>();
	for (const artifact of artifacts) titleCounts.set(artifact.title, (titleCounts.get(artifact.title) ?? 0) + 1);
	return artifacts.map((artifact) => (titleCounts.get(artifact.title)! > 1 ? `${artifactLine(artifact)} (${artifact.id})` : artifactLine(artifact)));
}

/**
 * Exact, case-insensitive, trimmed title match against an already-fetched candidate set. Throws
 * a clear "not found" or "ambiguous -- use id" error rather than guessing at a fuzzy match -- id
 * remains the one truly unambiguous key, so ambiguity is exactly where it's allowed to resurface.
 * Pure and synchronous so it's directly testable without a service round-trip.
 */
export function matchArtifactByName(candidates: Artifact[], name: string): string {
	const needle = name.trim().toLowerCase();
	const matches = candidates.filter((artifact) => artifact.title.trim().toLowerCase() === needle);
	if (matches.length === 0) throw new Error(`no artifact named "${name}" found in this scope`);
	if (matches.length > 1) {
		throw new Error(`${matches.length} artifacts are named "${name}": ${matches.map((artifact) => `${artifact.title} (${artifact.id})`).join(", ")} -- use id to disambiguate`);
	}
	return matches[0]!.id;
}

/**
 * Resolves a name to its id via `listOperation` (whichever kind's list call is the right search
 * scope -- tasks.list, docs.list, rules.list, skills.list, notes.list, discuss.list, or the
 * kind-agnostic artifact.query for a cross-kind reference like a link target). `baseRequest`
 * should mirror whatever scoping (project_root, etc.) that operation's own "list" action already
 * uses, so resolution never searches a wider or narrower scope than a plain list call would.
 */
async function resolveArtifactIdByName(listOperation: OperationName, baseRequest: Record<string, unknown>, name: string): Promise<string> {
	const candidates = await callService<Record<string, unknown>, Artifact[]>(listOperation, { ...baseRequest, text: name });
	return matchArtifactByName(candidates, name);
}

/** Resolves every {nameKey -> idKey} pair present and not already satisfied by an explicit id, in place. */
async function resolveNameFields(
	params: Record<string, unknown>,
	fields: ReadonlyArray<{ nameKey: string; idKey: string; listOperation: OperationName; baseRequest: Record<string, unknown> }>,
): Promise<void> {
	for (const { nameKey, idKey, listOperation, baseRequest } of fields) {
		const nameValue = params[nameKey];
		if (typeof nameValue === "string" && nameValue.length > 0 && !params[idKey]) {
			params[idKey] = await resolveArtifactIdByName(listOperation, baseRequest, nameValue);
		}
	}
}

/** Resolves a `namesKey` string array to an `idsKey` id array, only when idsKey isn't already explicitly given. */
async function resolveNameArrayField(
	params: Record<string, unknown>,
	namesKey: string,
	idsKey: string,
	listOperation: OperationName,
	baseRequest: Record<string, unknown>,
): Promise<void> {
	const names = params[namesKey];
	if (Array.isArray(names) && names.length > 0 && !params[idsKey]) {
		params[idsKey] = await Promise.all(names.map((entry) => resolveArtifactIdByName(listOperation, baseRequest, String(entry))));
	}
}

/**
 * Shared "remove"/"restore" dispatch for every domain tool (tasks/docs/rules/skills) --
 * artifact.remove/restore are kind-agnostic composition-root operations (see service.ts),
 * not owned by any one domain module, so every domain tool exposes the same two actions
 * over the same two operations rather than reinventing trash semantics four times.
 * Returns null when action is neither, so callers fall through to their own dispatch.
 */
async function handleArtifactRemoveRestore(action: unknown, params: Record<string, unknown>): Promise<ReturnType<typeof text> | null> {
	// Trashed/restored are still directly showable by id (see artifact-trash.ts), so the title is
	// available either side of the action -- fetched here purely for a name-primary message; falls
	// back to the raw id only if the artifact genuinely can't be shown (e.g. an unknown id).
	const titleOf = async (): Promise<string> => {
		try {
			const artifact = await callService<Record<string, unknown>, Artifact | null>("artifact.show", { id: params["id"] });
			return artifact ? `"${artifact.title}"` : String(params["id"]);
		} catch {
			return String(params["id"]);
		}
	};
	if (action === "remove") {
		const label = await titleOf();
		const record = await callService<Record<string, unknown>, { artifactId: string; trashedAt: string; purgeAfter: string; reason?: string }>("artifact.remove", params);
		const message = `Trashed ${label}, eligible for purge at ${record.purgeAfter}.`;
		return text(message, createPreviewDetails("artifact.remove", "Trashed", record.artifactId));
	}
	if (action === "restore") {
		const label = await titleOf();
		const outcome = await callService<Record<string, unknown>, { restored: boolean }>("artifact.restore", params);
		const output = outcome.restored ? `Restored ${label}.` : `${label} was not trashed.`;
		return text(output, createPreviewDetails("artifact.restore", "Restored", output));
	}
	return null;
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
		description: "Task domain tool. ACTIONS: create, update, list, show, history, scope, set_scope, assign_project, graph, plan, active, focused, focus, pause, unpause, clear_focus, start, submit, complete, reject, retry, cancel, run_gates, set_checklist, depend, undepend, contain, uncontain, remove, restore. Lifecycle is todo → in-progress → review → done, with review failure → rejected and retry → in-progress; canceled is terminal. update can recover a Task accidentally created terminal by setting status=todo with a reason, but cannot rewrite legitimate lifecycle history. Active focus is independent and identifies the one task auto-drive continues. Completion runs gates and checklist-proof review, then focuses one deterministic ready successor without claiming effort. Dependency cycles are rejected. undepend/uncontain are idempotent for an already-absent relationship and never start, complete, or focus work merely because an edge disappeared; uncontain removes both contains and part_of edges atomically. remove moves a Task to a time-gated trash (restorable via restore until the purge deadline; refuses if it is the live Task Focus). PREFER addressing a task by `name` (its exact title) over `id` for every action -- id is a backend implementation detail, resolved from name automatically, and only needs to appear explicitly when a name is genuinely ambiguous (two tasks share a title; the error will say so and list the real ids to disambiguate with). Task results likewise show name and status, not id, unless two shown tasks share a title. `dependency_name`/`parent_name`/`child_name`/`root_task_name`/`depends_on_names` are the name-based equivalents of `dependency_id`/`parent_id`/`child_id`/`root_task_id`/`depends_on`. Prefer this over low-level papyrus_* tools for task work.",
		parameters: Type.Object({
			action: Type.String(),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
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
			parent_name: Type.Optional(Type.String()),
			child_id: Type.Optional(Type.String()),
			child_name: Type.Optional(Type.String()),
			dependency_id: Type.Optional(Type.String()),
			dependency_name: Type.Optional(Type.String()),
			depends_on: Type.Optional(Type.Array(Type.String())),
			depends_on_names: Type.Optional(Type.Array(Type.String())),
			project_root: Type.Optional(Type.String()),
			scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("graph"), Type.Literal("all")])),
			root_task_id: Type.Optional(Type.String()),
			root_task_name: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Tasks", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				const action = params.action;
				// Defaults to this Pi session's own id so Focus reads/writes are isolated per agent
				// without depending on the model to know or supply its own session identity.
				// session_secret is looked up by the resolved session_id itself (not blindly the
				// current session's), so a model that explicitly overrides session_id to a DIFFERENT
				// session never gets this session's secret smuggled in on its behalf -- the cache only
				// ever holds this extension's own registered session anyway (see session-identity.ts).
				const resolvedSessionId = params.session_id ?? ctx.sessionManager.getSessionId();
				const baseRequest = { project_root: params.project_root ?? ctx.cwd, actor: "agent", source: "pi-tool", session_id: resolvedSessionId, ...sessionSecretField(resolvedSessionId as string) };
				// Resolves every *_name field to its *_id counterpart before dispatch, so every action
				// below can go on reading id/dependency_id/parent_id/child_id/root_task_id exactly as
				// before -- id-based calls are unaffected; name-based ones are transparently rewritten.
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "tasks.list", baseRequest },
					{ nameKey: "dependency_name", idKey: "dependency_id", listOperation: "tasks.list", baseRequest },
					{ nameKey: "parent_name", idKey: "parent_id", listOperation: "tasks.list", baseRequest },
					{ nameKey: "child_name", idKey: "child_id", listOperation: "tasks.list", baseRequest },
					{ nameKey: "root_task_name", idKey: "root_task_id", listOperation: "tasks.list", baseRequest },
				]);
				await resolveNameArrayField(params, "depends_on_names", "depends_on", "tasks.list", baseRequest);
				const request = { ...params, ...baseRequest };
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.create", request);
					return text(`Created task ${artifactLine(artifact)}`, createArtifactDetails("tasks.create", artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("tasks.list", request);
					return text(rows.length ? artifactLines(rows).join("\n") : "No tasks found.", createArtifactListDetails("tasks.list", rows));
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
					const titleCounts = new Map<string, number>();
					for (const node of plan.nodes) titleCounts.set(node.title, (titleCounts.get(node.title) ?? 0) + 1);
					const lines = plan.layers.flatMap((layer, index) => [
						`Layer ${index + 1}`,
						...layer.map((id) => {
							const node = byId.get(id);
							if (!node) return `  [unknown] ${id}`;
							return (titleCounts.get(node.title) ?? 0) > 1
								? `  [${node.state}] ${node.title} (${node.id})`
								: `  [${node.state}] ${node.title}`;
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
					const blockedLines = artifactLines(result.blocked.map((entry) => entry.artifact));
					const blocked = result.blocked.length > 0
						? `\nBlocked: ${result.blocked.map((entry, index) => `${blockedLines[index]} waits for ${entry.dependencyIds.join(", ")}`).join("; ")}`
						: "";
					const output = `${result.completed ? "Completed" : "Rejected"}: ${artifactLine(result.artifact)}${focused}${blocked}${checklist ? `\n${checklist}` : ""}${gates ? `\n${gates}` : ""}`;
					return text(output, createPreviewDetails("tasks.complete", "Task completion", output));
				}
				if (action === "run_gates") {
					const [gates, task] = await Promise.all([
						callService<Record<string, unknown>, GateResult[]>("tasks.run_gates", request),
						callService<Record<string, unknown>, Artifact>("tasks.show", { id: params.id }),
					]);
					return text(
						gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n") || "No gates configured.",
						createGateRunDetails("tasks.run_gates", (params.id as string | undefined) ?? "", task.title, gates.map((gate) => ({
							passed: gate.passed, type: gate.gate.type, target: gate.gate.target, output: gate.output,
						}))),
					);
				}
				const trashResult = await handleArtifactRemoveRestore(action, params);
				if (trashResult) return trashResult;
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
		description: "Deferred human-intent inbox. ACTIONS: capture, list, show, consume, promote, archive. Capture stores a request without creating work. Consume marks it considered. To promote, first create the resulting Task, Doc, Rule, or Skill through its domain tool, then link it with target_id. Archive requires an explicit disposition. PREFER `name` (the note's exact title) over `id` for show/consume/promote/archive -- id is a backend implementation detail, resolved from name automatically.",
		parameters: Type.Object({
			action: Type.String(),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
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
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				const action = params.action;
				const baseRequest = { project_root: params.project_root ?? ctx.cwd, actor: "agent", source: "notes-tool" };
				await resolveNameFields(params, [{ nameKey: "name", idKey: "id", listOperation: "notes.list", baseRequest }]);
				const request = { ...params, ...baseRequest };
				if (action === "capture") {
					const artifact = await callService<Record<string, unknown>, Artifact>("notes.capture", request);
					return text(`Captured note ${artifactLine(artifact)}`, createArtifactDetails("notes.capture", artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("notes.list", request);
					return text(rows.length ? artifactLines(rows).join("\n") : "No open notes.", createArtifactListDetails("notes.list", rows));
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
		description: "Document domain tool. ACTIONS: create, list, show, activate, archive, reopen, link, assign_project, remove, restore. project_root is optional at creation (omitted = unscoped); assign_project reassigns it later, or unscopes when project_root is omitted. remove moves a Doc to a time-gated trash, excluded from list/query but still directly showable, restorable via restore until the purge deadline. PREFER `name` (the doc's exact title) over `id`, and `target_name` over `target_id` for link -- both are backend implementation details, resolved from name automatically (target_name searches across every kind, since a link target can be a doc, task, rule, or skill). Prefer this over low-level papyrus_* tools for document work.",
		parameters: Type.Object({
			action: Type.String(),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
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
			target_name: Type.Optional(Type.String()),
			project_root: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Documents", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, rawParams) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				const action = params.action;
				const scopeRequest = { project_root: params.project_root };
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "docs.list", baseRequest: scopeRequest },
					// Kind-agnostic: a link target can be a doc, task, rule, or skill, so this searches every kind rather than only docs.
					{ nameKey: "target_name", idKey: "target_id", listOperation: "artifact.query", baseRequest: scopeRequest },
				]);
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("docs.create", params);
					return text(`Created document ${artifactLine(artifact)}`, createArtifactDetails("docs.create", artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("docs.list", params);
					return text(rows.length ? artifactLines(rows).join("\n") : "No documents found.", createArtifactListDetails("docs.list", rows));
				}
				if (action === "show") {
					const artifact = await callService<Record<string, unknown>, Artifact>("docs.show", params);
					return text(`${artifactLine(artifact)}\n\n${artifact.body}`, createArtifactDetails("docs.show", artifact));
				}
				const trashResult = await handleArtifactRemoveRestore(action, params);
				if (trashResult) return trashResult;
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
		description: "Rule domain tool. ACTIONS: create, list, show, preview, enable, disable, gate, assign_project, remove, restore. project_root is optional at creation (omitted = unscoped); assign_project reassigns it later, or unscopes when project_root is omitted. Active rules inject into the agent system prompt. remove moves a Rule to a time-gated trash, excluded from list/query but still directly showable, restorable via restore until the purge deadline. PREFER `name` (the rule's exact title) over `id`, and `task_name` over `task_id` for gate -- both are backend implementation details, resolved from name automatically.",
		parameters: Type.Object({
			action: Type.String(), id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()), condition: Type.Optional(Type.String()), rule_action: Type.Optional(Type.String()),
			severity: Type.Optional(Type.String()), labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())), status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()), task_id: Type.Optional(Type.String()),
			task_name: Type.Optional(Type.String()),
			project_root: Type.Optional(Type.String()), reason: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Rules", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				const action = params.action;
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "rules.list", baseRequest: { project_root: params.project_root } },
					{ nameKey: "task_name", idKey: "task_id", listOperation: "tasks.list", baseRequest: { project_root: params.project_root ?? ctx.cwd } },
				]);
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("rules.create", params);
					return text(`Created rule ${artifactLine(artifact)}`, createArtifactDetails("rules.create", artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("rules.list", params);
					return text(rows.length ? artifactLines(rows).join("\n") : "No rules found.", createArtifactListDetails("rules.list", rows));
				}
				if (action === "preview") {
					const preview = await callService<Record<string, unknown>, string>("rules.preview", params);
					return text(preview, createPreviewDetails("rules.preview", "Rule preview", preview));
				}
				const trashResult = await handleArtifactRemoveRestore(action, params);
				if (trashResult) return trashResult;
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
		description: "Papyrus Skill workflow and compatibility-template domain tool. Papyrus Skills are parameterized Task/Rule/Doc bundles, distinct from prompt-only skills. ACTIONS: create, create_template, list, show, invoke, run, enable, disable, instantiate, assign_project, remove, restore. run validates arguments and atomically creates one scoped workflow run. project_root is optional at creation (omitted = unscoped) for create/create_template; assign_project reassigns it later, or unscopes when project_root is omitted. remove moves a Skill to a time-gated trash, excluded from list/query but still directly showable, restorable via restore until the purge deadline. PREFER `name` (the skill's exact title) over `id`, and `template_name` over `template_id` for instantiate -- both are backend implementation details, resolved from name automatically.",
		parameters: Type.Object({
			action: Type.String(), id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()), trigger: Type.Optional(Type.String()), steps: Type.Optional(Type.Array(Type.String())),
			tools: Type.Optional(Type.Array(Type.String())), definition: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())), run_id: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())), status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()), template_id: Type.Optional(Type.String()),
			template_name: Type.Optional(Type.String()),
			target_kind: Type.Optional(Type.String()), defaults: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			required: Type.Optional(Type.Array(Type.String())), kind: Type.Optional(Type.String()), subtype: Type.Optional(Type.String()),
			project_root: Type.Optional(Type.String()), reason: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Skills", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				const action = params.action;
				const request = { ...params, project_root: params.project_root ?? ctx.cwd };
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "skills.list", baseRequest: { project_root: params.project_root } },
					{ nameKey: "template_name", idKey: "template_id", listOperation: "skills.list", baseRequest: { project_root: params.project_root } },
				]);
				if (action === "create" || action === "create_template") {
					const operation = action === "create" ? "skills.create" : "skills.create_template";
					const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
					return text(`Created skill ${artifactLine(artifact)}`, createArtifactDetails(operation, artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("skills.list", params);
					return text(rows.length ? artifactLines(rows).join("\n") : "No skills found.", createArtifactListDetails("skills.list", rows));
				}
				if (action === "invoke") {
					const invocation = await callService<Record<string, unknown>, string>("skills.invoke", params);
					return text(invocation, createPreviewDetails("skills.invoke", "Skill invocation", invocation));
				}
				if (action === "run") {
					const run = await callService<Record<string, unknown>, SkillWorkflowRunResult>("skills.run", request);
					const runTitleCounts = new Map<string, number>();
					for (const node of run.execution.nodes) runTitleCounts.set(node.title, (runTitleCounts.get(node.title) ?? 0) + 1);
					const execution = run.execution.nodes.map((node) => (runTitleCounts.get(node.title) ?? 0) > 1
						? `  [${node.state}] ${node.title} (${node.id})`
						: `  [${node.state}] ${node.title}`).join("\n");
					// Root task titles are free here (already present in execution.nodes); created docs/rules
					// are a different kind not covered by this run's own execution nodes, so those still list by
					// id below -- fetching their titles would mean an extra round-trip per artifact.
					const nodeById = new Map(run.execution.nodes.map((node) => [node.id, node]));
					const rootLabels = run.rootTaskIds.map((id) => nodeById.get(id)?.title ?? id);
					return text([
						`Created Skill run ${run.runId}: ${run.created.tasks.length} tasks, ${run.created.rules.length} rules, ${run.created.docs.length} docs.`,
						`Ready roots: ${rootLabels.join(", ") || "none"}.`,
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
				const trashResult = await handleArtifactRemoveRestore(action, params);
				if (trashResult) return trashResult;
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

	pi.registerTool({
		name: "discuss",
		label: "Discuss",
		description: "Native Papyrus deliberation with a real lifecycle -- distinct from a one-shot ask: a Discussion persists, takes multiple rounds, and can genuinely block a Task's completion until settled or deferred. ACTIONS: open, reply, defer, resume, settle, block, unblock, show, rounds, list. open starts round 1 and optionally blocks_task_ids immediately. reply is refused once deferred or settled -- resume first. defer is explicitly non-blocking (paused, resumable); settle is terminal and archives the discussion. block/unblock manage the blocking relationship to a task independently of open. A task's completion is refused while any active Discussion blocks it. open/reply can pose a structured choice via options (2-10 entries) + options_mode ('single' mutually exclusive, 'multi' allows several); reply answers a currently pending choice via selected, validated against it. PREFER `name` (the discussion's exact title) over `id`, `task_name`/`blocks_task_names` over `task_id`/`blocks_task_ids` -- all are backend implementation details, resolved from name automatically.",
		parameters: Type.Object({
			action: Type.String(),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
			content: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
			blocks_task_ids: Type.Optional(Type.Array(Type.String())),
			blocks_task_names: Type.Optional(Type.Array(Type.String())),
			task_id: Type.Optional(Type.String()),
			task_name: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
			settlement: Type.Optional(Type.String()),
			state: Type.Optional(Type.String()),
			after_round: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
			options: Type.Optional(Type.Array(Type.String())),
			options_mode: Type.Optional(Type.String()),
			selected: Type.Optional(Type.Array(Type.String())),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Discuss", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				const action = params.action;
				const taskScope = { project_root: ctx.cwd };
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "discuss.list", baseRequest: {} },
					{ nameKey: "task_name", idKey: "task_id", listOperation: "tasks.list", baseRequest: taskScope },
				]);
				await resolveNameArrayField(params, "blocks_task_names", "blocks_task_ids", "tasks.list", taskScope);
				if (action === "open") {
					const result = await callService<Record<string, unknown>, DiscussionAndRounds>("discuss.open", params);
					return text(`Opened discussion ${artifactLine(result.discussion)}`, createArtifactDetails("discuss.open", result.discussion));
				}
				if (action === "reply") {
					const result = await callService<Record<string, unknown>, DiscussionAndRounds>("discuss.reply", params);
					return text(`Round ${result.rounds[0]?.roundNumber} added to "${result.discussion.title}"`, createArtifactDetails("discuss.reply", result.discussion));
				}
				if (action === "block" || action === "unblock") {
					const operation = action === "block" ? "discuss.block" : "discuss.unblock";
					const [outcome, discussionAndRounds, task] = await Promise.all([
						callService<Record<string, unknown>, { blocked?: boolean; unblocked?: boolean }>(operation, params),
						callService<Record<string, unknown>, DiscussionAndRounds>("discuss.show", { id: params.id }),
						callService<Record<string, unknown>, Artifact>("tasks.show", { id: params.task_id }),
					]);
					const discussion = discussionAndRounds.discussion;
					const message = action === "unblock" && !outcome.unblocked
						? "No such blocking relationship."
						: `"${discussion.title}" ${action === "block" ? "now blocks" : "no longer blocks"} "${task.title}"`;
					return text(message, createPreviewDetails(operation, action === "block" ? "Blocked" : "Unblocked", message));
				}
				if (action === "show") {
					const result = await callService<Record<string, unknown>, DiscussionAndRounds>("discuss.show", params);
					const rounds = result.rounds.map((round) => `  [round ${round.roundNumber}] ${round.actor}: ${round.content}`).join("\n");
					return text(`${artifactLine(result.discussion)}\n\n${rounds}`, createArtifactDetails("discuss.show", result.discussion));
				}
				if (action === "rounds") {
					const rounds = await callService<Record<string, unknown>, DiscussionRound[]>("discuss.rounds", params);
					const output = rounds.map((round) => `[round ${round.roundNumber}] ${round.actor}: ${round.content}`).join("\n") || "No rounds.";
					return text(output, createPreviewDetails("discuss.rounds", "Discussion rounds", output));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("discuss.list", params);
					return text(rows.length ? artifactLines(rows).join("\n") : "No discussions found.", createArtifactListDetails("discuss.list", rows));
				}
				const operations = { defer: "discuss.defer", resume: "discuss.resume", settle: "discuss.settle" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown discuss action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(artifactLine(artifact), createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`discuss failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});
}
