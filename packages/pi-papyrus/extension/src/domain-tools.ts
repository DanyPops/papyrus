import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	NOTE_DISPOSITIONS,
	PROOF_TYPES,
	readDiscussionExtra,
	type Artifact,
	type DiscussionAndRounds,
	type DiscussionRound,
	type GateResult,
	type NoteHistoryPage,
	type OperationName,
	type WorkflowRunResult,
	type TaskCompletion,
	type TaskExecutionPlan,
	type TaskGraph,
	type TaskHistoryPage,
	type TaskLease,
	type TaskViewSelection,
} from "@danypops/papyrus";
import { askQuestion } from "./discuss-ask-view.ts";
import { emitTaskFocusEvent } from "./task-focus-events.ts";
import { sessionSecretField } from "./session-identity.ts";
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
 * live:true's synchronous half: reuses the same Discuss-owned ask UI (discuss-ask-view.ts) the
 * /discuss TUI's own "Reply" action uses when the just-created round posed a structured choice,
 * or a plain freeform prompt otherwise -- so "ask" covers both a completely open question and a
 * choice tied to this specific Discussion. Returns undefined on cancel or when no interactive UI
 * is available, never throws -- an unanswered live prompt still leaves the round it already
 * recorded intact.
 */
/**
 * The discuss tool accepts each option as either a bare string (self-evident choices) or
 * {title, description} (a real tradeoff worth spelling out) -- normalizes to the two parallel
 * arrays discuss.open/discuss.reply actually expect (options: string[], option_descriptions:
 * string[], index-aligned, empty string meaning "none for this one"). Mutates params in place.
 */
function normalizeDiscussOptions(params: Record<string, unknown>): void {
	const raw = params.options;
	if (!Array.isArray(raw)) return;
	let anyDescription = false;
	const titles: string[] = [];
	const descriptions: string[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") { titles.push(entry); descriptions.push(""); continue; }
		if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).title === "string") {
			const record = entry as Record<string, unknown>;
			titles.push(record.title as string);
			const description = typeof record.description === "string" ? record.description : "";
			if (description) anyDescription = true;
			descriptions.push(description);
			continue;
		}
		titles.push(String(entry));
		descriptions.push("");
	}
	params.options = titles;
	if (anyDescription) params.option_descriptions = descriptions;
}

async function liveAnswer(ctx: ExtensionContext, discussion: Artifact, latestContent: string | undefined, onUpdate: AgentToolUpdateCallback | undefined, signal: AbortSignal | undefined): Promise<{ content: string; selected?: string[] } | undefined> {
	if (!ctx.hasUI) return undefined;
	const pending = (() => { try { return readDiscussionExtra(discussion.extra); } catch { return undefined; } })();
	// The just-recorded round's own content IS the real question -- a generic "Reply to <title>:"
	// wrapper as the primary question, with the real content demoted to "Context:", left a human
	// staring at a labeled-backwards prompt (live-observed). The wrapper is now only a fallback for
	// the degenerate case of empty content; the title becomes a plain orientation subtitle instead.
	const question = latestContent?.trim() || `Reply to "${discussion.title}":`;
	const subtitle = discussion.title;
	if (pending?.pendingOptions && pending.pendingOptions.length > 0 && pending.pendingOptionsMode) {
		return askQuestion(ctx, {
			question,
			subtitle,
			options: pending.pendingOptions.map((title, index) => ({ title, description: pending.pendingOptionDescriptions?.[index] || undefined })),
			allowMultiple: pending.pendingOptionsMode === "multi",
			onUpdate,
			signal,
		});
	}
	return askQuestion(ctx, { question, subtitle, onUpdate, signal });
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

/** Resolves internal ids for model text; ids resurface only when equal titles need disambiguation. */
async function artifactLabelsById(ids: readonly string[]): Promise<Map<string, string>> {
	const uniqueIds = [...new Set(ids)];
	const artifacts = (await Promise.all(uniqueIds.map((id) => callService<Record<string, unknown>, Artifact | null>("artifact.show", { id })))).filter((artifact): artifact is Artifact => artifact !== null);
	const titleCounts = new Map<string, number>();
	for (const artifact of artifacts) titleCounts.set(artifact.title, (titleCounts.get(artifact.title) ?? 0) + 1);
	return new Map(artifacts.map((artifact) => [artifact.id, titleCounts.get(artifact.title)! > 1 ? `${artifact.title} (${artifact.id})` : artifact.title]));
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

/**
 * Playbook `arguments` is intentionally untyped in this tool's schema (an array on create, a
 * {name: value} map on invoke) -- unlike every other JSON-shaped field here, which has a concrete
 * array/record schema the calling layer can serialize correctly. A genuinely schema-less field can
 * arrive pre-serialized as JSON text instead of a parsed value; parse it back in place before it
 * reaches the service, the same tolerance the CLI's own --arguments-json/--*-json flags already give.
 */
export function normalizeJsonEncodedField(params: Record<string, unknown>, key: string): void {
	const value = params[key];
	if (typeof value !== "string") return;
	try {
		params[key] = JSON.parse(value);
	} catch {
		throw new Error(`${key} must be valid JSON`);
	}
}

/** Resolves every {nameKey -> idKey} pair present and not already satisfied by an explicit id, in place. */
export async function resolveNameFields(
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
	// Trashed/restored artifacts stay directly showable, so known identities render by title on
	// either side of the action. An unresolved explicit id stays in structured/error channels;
	// normal model text does not turn that backend key into the artifact's public name.
	const titleOf = async (): Promise<string> => {
		try {
			const artifact = await callService<Record<string, unknown>, Artifact | null>("artifact.show", { id: params["id"] });
			return artifact ? `"${artifact.title}"` : "unknown artifact";
		} catch {
			return "unknown artifact";
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

export function registerTasksTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "tasks",
		label: "Tasks",
		description: "Task domain tool. ACTIONS: create, update, list, show, history, context, scope, set_scope, assign_project, graph, plan, active, focused, focus, pause, unpause, clear_focus, start, submit, complete, reject, retry, cancel, run_gates, set_checklist, depend, undepend, contain, uncontain, remove, restore, claim, heartbeat_lease, release_lease, lease, event_feed. context returns the full current/desired/verify reconciliation plan for the active task(s) -- the system prompt is injected with only a one-line pointer to save tokens on turns that don't need it; call this explicitly when you actually need the full plan (e.g. after a compaction, or before reconciling). Lifecycle is todo → in-progress → review → done, with review failure → rejected and retry → in-progress; canceled is terminal. update can recover a Task accidentally created terminal by setting status=todo with a reason, but cannot rewrite legitimate lifecycle history. Active focus is independent and identifies the one task auto-drive continues. Completion runs gates and checklist-proof review, then focuses one deterministic ready successor without claiming effort. Dependency cycles are rejected. undepend/uncontain are idempotent for an already-absent relationship and never start, complete, or focus work merely because an edge disappeared; uncontain removes both contains and part_of edges atomically. remove moves a Task to a time-gated trash (restorable via restore until the purge deadline; refuses if it is the live Task Focus). claim/heartbeat_lease/release_lease/lease manage a bounded work-reservation lease -- independent of both lifecycle status and Focus, so multiple sessions can Focus the same task while only one owner holds its lease at a time; claim throws if a DIFFERENT owner already holds a live lease, release/heartbeat require the exact token claim returned. `owner` defaults to this session's own id when omitted. PREFER addressing a task by `name` (its exact title) over `id` for every action -- id is a backend implementation detail, resolved from name automatically, and only needs to appear explicitly when a name is genuinely ambiguous (two tasks share a title; the error will say so and list the real ids to disambiguate with). Task results likewise show name and status, not id, unless two shown tasks share a title. `dependency_name`/`parent_name`/`child_name`/`root_task_name`/`depends_on_names` are the name-based equivalents of `dependency_id`/`parent_id`/`child_id`/`root_task_id`/`depends_on`. Prefer this over low-level papyrus_* tools for task work.",
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
			owner: Type.Optional(Type.String()),
			token: Type.Optional(Type.String()),
			ttl_ms: Type.Optional(Type.Number()),
			note: Type.Optional(Type.String()),
			event_types: Type.Optional(Type.Array(Type.String())),
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
				// Resolve the graph root first: every other name lookup must use the caller's final
				// project/scope/root selection, otherwise `scope: all|graph` silently collapses back
				// to the current project and forces callers to reach for an id.
				await resolveNameFields(params, [
					{ nameKey: "root_task_name", idKey: "root_task_id", listOperation: "tasks.list", baseRequest: { ...baseRequest, scope: "project" } },
				]);
				const resolutionRequest = {
					...baseRequest,
					...(params.scope === undefined ? {} : { scope: params.scope }),
					...(params.root_task_id === undefined ? {} : { root_task_id: params.root_task_id }),
				};
				// The daemon remains keyed by stable ids; the agent facade resolves names against the
				// exact requested view before dispatching those internal ids.
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "tasks.list", baseRequest: resolutionRequest },
					{ nameKey: "dependency_name", idKey: "dependency_id", listOperation: "tasks.list", baseRequest: resolutionRequest },
					{ nameKey: "parent_name", idKey: "parent_id", listOperation: "tasks.list", baseRequest: resolutionRequest },
					{ nameKey: "child_name", idKey: "child_id", listOperation: "tasks.list", baseRequest: resolutionRequest },
				]);
				await resolveNameArrayField(params, "depends_on_names", "depends_on", "tasks.list", resolutionRequest);
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
					const selection = await callService<Record<string, unknown>, TaskViewSelection>("tasks.scope", request);
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
					const nodeLabel = (id: string): string => {
						const node = byId.get(id);
						if (!node) return "unknown task";
						return (titleCounts.get(node.title) ?? 0) > 1 ? `${node.title} (${node.id})` : node.title;
					};
					const lines = plan.layers.flatMap((layer, index) => [
						`Layer ${index + 1}`,
						...layer.map((id) => {
							const node = byId.get(id);
							return `  [${node?.state ?? "unknown"}] ${nodeLabel(id)}`;
						}),
					]);
					if (plan.cycleIds.length > 0) lines.push(`Invalid cycle: ${plan.cycleIds.map(nodeLabel).join(", ")}`);
					const output = lines.join("\n") || "No tasks in execution plan.";
					return text(output, createPreviewDetails("tasks.plan", "Task execution plan", output));
				}
				if (action === "context") {
					const summary = await callService<Record<string, unknown>, string | null>("tasks.context", { ...request, verbosity: "full" });
					const output = summary ?? "No open tasks.";
					return text(output, createPreviewDetails("tasks.context", "Task reconciliation context", output));
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
					const dependencyLabels = await artifactLabelsById(result.blocked.flatMap((entry) => entry.dependencyIds));
					const blocked = result.blocked.length > 0
						? `\nBlocked: ${result.blocked.map((entry, index) => `${blockedLines[index]} waits for ${entry.dependencyIds.map((id) => dependencyLabels.get(id) ?? "unknown task").join(", ")}`).join("; ")}`
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
				if (action === "event_feed") {
					const page = await callService<Record<string, unknown>, { events: Array<{ id: number; occurredAt: string; taskId: string; type: string }>; nextCursor?: number }>("tasks.event_feed", { cursor: params.cursor, limit: params.limit, event_types: params.event_types });
					const output = page.events.length === 0 ? "No events." : page.events.map((event) => `${event.id} ${event.occurredAt} ${event.taskId} ${event.type}`).join("\n");
					return text(page.nextCursor !== undefined ? `${output}\n\n(more available -- resume with cursor: ${page.nextCursor})` : output, createPreviewDetails("tasks.event_feed", "Task event feed", output));
				}
				if (action === "claim" || action === "heartbeat_lease" || action === "release_lease" || action === "lease") {
					const leaseRequest = { ...request, owner: (params.owner as string | undefined) ?? resolvedSessionId };
					if (action === "release_lease") {
						const released = await callService<Record<string, unknown>, { released: boolean }>("tasks.release_lease", leaseRequest);
						const output = released.released ? "Lease released." : "No live lease to release.";
						return text(output, createPreviewDetails("tasks.release_lease", "Task lease", output));
					}
					const operation = action === "claim" ? "tasks.claim" : action === "heartbeat_lease" ? "tasks.heartbeat_lease" : "tasks.lease";
					const lease = await callService<Record<string, unknown>, TaskLease | null>(operation, leaseRequest);
					const output = lease ? `Leased by "${lease.owner}" until ${lease.leaseExpiresAt} (token ${lease.token}).` : "No live lease.";
					return text(output, createPreviewDetails(operation, "Task lease", output));
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
}

export function registerNotesTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "notes",
		label: "Notes",
		description: "Deferred human-intent inbox. ACTIONS: capture, list, show, history, consume, promote, archive. Capture stores a request without creating work. Consume marks it considered. To promote, first create the resulting Task, Doc, Rule, or Skill through its domain tool, then link it with target_id (or target_name). Archive requires an explicit disposition. history returns this note's own real append-only event log (captured/consumed/promoted/archived), not the generic cross-kind graph.history. PREFER `name` (the note's exact title) over `id` for show/history/consume/promote/archive, and `target_name` over `target_id` for promote -- all are backend implementation details, resolved from name automatically (target_name searches across every kind, since a promotion target can be a task, doc, rule, or skill).",
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
			target_name: Type.Optional(Type.String()),
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
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "notes.list", baseRequest },
					// Kind-agnostic: a promotion target can be a task, doc, rule, or skill, so this searches every kind rather than only notes.
					{ nameKey: "target_name", idKey: "target_id", listOperation: "artifact.query", baseRequest },
				]);
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
				if (action === "history") {
					const page = await callService<Record<string, unknown>, NoteHistoryPage>("notes.history", request);
					const lines = page.events.map((event) => `${event.occurredAt} ${event.type} · ${event.actor}/${event.source}${event.relatedId ? ` · ${event.relatedId}` : ""}${event.disposition ? ` · ${event.disposition}` : ""}${event.reason ? ` · ${event.reason}` : ""}`);
					const output = lines.join("\n") || "No recorded history for this note.";
					return text(output, createPreviewDetails("notes.history", "Note history", output));
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
}

export function registerDocsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "docs",
		label: "Documents",
		description: "Document domain tool. ACTIONS: create, list, show, activate, archive, reopen, link, assign_project, update, remove, restore. project_root is optional at creation (omitted = unscoped); assign_project reassigns it later, or unscopes when project_root is omitted. update changes title/body/labels (at least one required) and is refused for a read-only external projection (e.g. web-spider-ingested Docs) -- capture a correction as a new linked Doc instead. remove moves a Doc to a time-gated trash, excluded from list/query but still directly showable, restorable via restore until the purge deadline. PREFER `name` (the doc's exact title) over `id`, and `target_name` over `target_id` for link -- both are backend implementation details, resolved from name automatically (target_name searches across every kind, since a link target can be a doc, task, rule, or skill). Prefer this over low-level papyrus_* tools for document work.",
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
				const operations = { activate: "docs.activate", archive: "docs.archive", reopen: "docs.reopen", link: "docs.link", assign_project: "docs.assign_project", update: "docs.update" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown docs action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(artifactLine(artifact), createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`docs failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});
}

export function registerRulesTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "rules",
		label: "Rules",
		description: "Rule domain tool. ACTIONS: create, list, show, preview, enable, disable, gate, assign_project, update, remove, restore. project_root is optional at creation (omitted = unscoped); assign_project reassigns it later, or unscopes when project_root is omitted. Active rules inject into the agent system prompt. update changes title/body/labels (at least one required); body updates still enforce the same combined condition+action+body context-tax bound as creation, and are refused for a read-only external projection. remove moves a Rule to a time-gated trash, excluded from list/query but still directly showable, restorable via restore until the purge deadline. PREFER `name` (the rule's exact title) over `id`, and `task_name` over `task_id` for gate -- both are backend implementation details, resolved from name automatically.",
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
				const operations = { show: "rules.show", enable: "rules.enable", disable: "rules.disable", gate: "rules.gate", assign_project: "rules.assign_project", update: "rules.update" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown rules action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(`${artifactLine(artifact)}${action === "show" ? `\n\n${artifact.body}` : ""}`, createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`rules failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});
}

export function registerPlaybooksTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "playbooks",
		label: "Playbooks",
		description: "Playbook domain tool -- a completely different beast from the skills tool at the AUTHORING level (a Playbook is prose: a trigger and an ordered list of steps), but invoke recycles the exact same materialization engine workflow Skills use: it compiles the Playbook's steps and its contains/depends_on composition tree into real Tasks (one per step, plus one container task per playbook in the tree), wires them with dependsOn so completing one auto-focuses the next, and focuses the first one -- no text dump, one step (page) surfaces at a time as it becomes the focused task, exactly like any other Task. contain/uncontain nest a child Playbook inside a parent (its steps run AFTER the parent's own, as part of it); depend/undepend chain a prerequisite Playbook before another (it must fully complete FIRST). Both are bounded; a composition cycle is a hard invoke-time error (real Tasks would otherwise be created in a loop), unlike preview's degrade-to-a-marker. ACTIONS: create, list, show, invoke, preview, enable, disable, assign_project, update, contain, uncontain, depend, undepend, remove, restore. project_root is optional everywhere (omitted = unscoped). On create, `arguments` declares named inputs the Playbook needs: [{name, description?, required?}] (required defaults true) -- referenced in step text as `{{name}}`, substituted at invoke time. On invoke, `arguments` supplies known values as {name: value}; if any declared REQUIRED argument is still missing, invoke creates nothing and returns `missingArguments` -- ask the human for these (discuss tool, live:true) and invoke again, never guess or invent a value. A successful invoke returns `entryTaskId` (now focused) and `created.tasks` -- drive it forward with the tasks tool (start/submit/complete) like any other Task; contains/depends_on wiring auto-focuses each next step on completion. preview renders the whole tree as text with no side effects, for a human who just wants to read it first. update changes title/body/labels (at least one required) and is refused for a read-only external projection. remove moves a Playbook to a time-gated trash, excluded from list/query but still directly showable, restorable via restore until the purge deadline. PREFER `name` (the playbook's exact title) over `id`, and `parent_name`/`child_name`/`dependency_name` over `parent_id`/`child_id`/`dependency_id` for contain/uncontain/depend/undepend -- all are backend implementation details, resolved from name automatically.",
		parameters: Type.Object({
			action: Type.String(), id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()), trigger: Type.Optional(Type.String()), steps: Type.Optional(Type.Array(Type.String())),
			tools: Type.Optional(Type.Array(Type.String())), labels: Type.Optional(Type.Array(Type.String())),
			arguments: Type.Optional(Type.Unknown()),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())), status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()),
			parent_id: Type.Optional(Type.String()), parent_name: Type.Optional(Type.String()),
			child_id: Type.Optional(Type.String()), child_name: Type.Optional(Type.String()),
			dependency_id: Type.Optional(Type.String()), dependency_name: Type.Optional(Type.String()),
			project_root: Type.Optional(Type.String()), reason: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Playbooks", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				const action = params.action;
				// invoke ends by calling tasks.focus server-side -- that focus write must land in the
				// SAME session scope the tasks tool reads from (ctx.sessionManager.getSessionId()),
				// the same resolution the tasks tool itself always applies, or the entry task's focus
				// is invisible to tasks(action=focused/active) despite invoke reporting it as focused.
				// project_root defaults to ctx.cwd for the same reason: the tasks tool always scopes
				// its OWN reads to ctx.cwd unless told otherwise, so an unscoped playbook-materialized
				// task is invisible to tasks(action=focused) even with the right session -- confirmed
				// live (the focus_set event existed with the correct sessionId, but Tasks.focused's own
				// project-scope filter silently excluded the unscoped task from a cwd-scoped read).
				if (action === "invoke") {
					const resolvedSessionId = params.session_id ?? ctx.sessionManager.getSessionId();
					Object.assign(params, {
						project_root: params.project_root ?? ctx.cwd,
						session_id: resolvedSessionId,
						...sessionSecretField(resolvedSessionId as string),
					});
				}
				const resolutionRequest = { project_root: params.project_root };
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "playbooks.list", baseRequest: resolutionRequest },
					{ nameKey: "parent_name", idKey: "parent_id", listOperation: "playbooks.list", baseRequest: resolutionRequest },
					{ nameKey: "child_name", idKey: "child_id", listOperation: "playbooks.list", baseRequest: resolutionRequest },
					{ nameKey: "dependency_name", idKey: "dependency_id", listOperation: "playbooks.list", baseRequest: resolutionRequest },
				]);
				if (action === "create" || action === "invoke" || action === "preview") normalizeJsonEncodedField(params, "arguments");
				if (action === "create") {
					const artifact = await callService<Record<string, unknown>, Artifact>("playbooks.create", params);
					return text(`Created playbook ${artifactLine(artifact)}`, createArtifactDetails("playbooks.create", artifact));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("playbooks.list", params);
					return text(rows.length ? artifactLines(rows).join("\n") : "No playbooks found.", createArtifactListDetails("playbooks.list", rows));
				}
				if (action === "preview") {
					const rendered = await callService<Record<string, unknown>, string>("playbooks.preview", params);
					return text(rendered, createPreviewDetails("playbooks.preview", "Playbook preview", rendered));
				}
				if (action === "invoke") {
					const invocation = await callService<Record<string, unknown>, { entryTaskId?: string; rootTaskIds?: string[]; created?: { tasks: string[] }; missingArguments?: string[] }>("playbooks.invoke", params);
					if (invocation.missingArguments) {
						const message = `Missing required argument(s): ${invocation.missingArguments.join(", ")}. Nothing was created -- ask the human for these (discuss tool, live:true), then invoke again.`;
						return text(message, createPreviewDetails("playbooks.invoke", "Playbook invocation", message));
					}
					const message = `Invoked: ${invocation.created?.tasks.length ?? 0} task(s) created, entry task ${invocation.entryTaskId} now focused. Drive it forward with the tasks tool (start/submit/complete) -- contains/depends_on wiring auto-focuses each next step.`;
					return text(message, createPreviewDetails("playbooks.invoke", "Playbook invocation", JSON.stringify(invocation, null, 2)));
				}
				const trashResult = await handleArtifactRemoveRestore(action, params);
				if (trashResult) return trashResult;
				const operations = {
					show: "playbooks.show", enable: "playbooks.enable", disable: "playbooks.disable", assign_project: "playbooks.assign_project", update: "playbooks.update",
					contain: "playbooks.contain", uncontain: "playbooks.uncontain", depend: "playbooks.depend", undepend: "playbooks.undepend",
				} as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown playbooks action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(`${artifactLine(artifact)}${action === "show" ? `\n\n${artifact.body}` : ""}`, createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`playbooks failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});
}

export function registerSkillsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "skills",
		label: "Skills",
		description: "Papyrus Skill workflow and compatibility-template domain tool. Papyrus Skills are parameterized Task/Rule/Doc bundles, distinct from prompt-only skills. ACTIONS: create, create_template, list, show, invoke, run, enable, disable, instantiate, assign_project, update, remove, restore. run validates arguments and atomically creates one scoped workflow run. project_root is optional at creation (omitted = unscoped) for create/create_template; assign_project reassigns it later, or unscopes when project_root is omitted. update changes title/body/labels (at least one required) and is refused for a read-only external projection. remove moves a Skill to a time-gated trash, excluded from list/query but still directly showable, restorable via restore until the purge deadline. PREFER `name` (the skill's exact title) over `id`, and `template_name` over `template_id` for instantiate -- both are backend implementation details, resolved from name automatically.",
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
					const run = await callService<Record<string, unknown>, WorkflowRunResult>("skills.run", request);
					const runTitleCounts = new Map<string, number>();
					for (const node of run.execution.nodes) runTitleCounts.set(node.title, (runTitleCounts.get(node.title) ?? 0) + 1);
					const execution = run.execution.nodes.map((node) => (runTitleCounts.get(node.title) ?? 0) > 1
						? `  [${node.state}] ${node.title} (${node.id})`
						: `  [${node.state}] ${node.title}`).join("\n");
					const nodeById = new Map(run.execution.nodes.map((node) => [node.id, node]));
					const rootLabels = run.rootTaskIds.map((id) => nodeById.get(id)?.title ?? "unknown task");
					const createdLabels = await artifactLabelsById([...run.created.docs, ...run.created.rules]);
					return text([
						`Created Skill run ${run.runId}: ${run.created.tasks.length} tasks, ${run.created.rules.length} rules, ${run.created.docs.length} docs.`,
						`Ready roots: ${rootLabels.join(", ") || "none"}.`,
						`Context docs: ${run.created.docs.map((id) => createdLabels.get(id) ?? "unknown document").join(", ") || "none"}.`,
						`Scoped rules: ${run.created.rules.map((id) => createdLabels.get(id) ?? "unknown rule").join(", ") || "none"}.`,
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
				const operations = { show: "skills.show", enable: "skills.enable", disable: "skills.disable", instantiate: "skills.instantiate", assign_project: "skills.assign_project", update: "skills.update" } as const;
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

export function registerDiscussTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "discuss",
		label: "Discuss",
		description: "Native Papyrus deliberation with a real lifecycle -- distinct from a one-shot ask: a Discussion persists, takes multiple rounds, and can genuinely block a Task's completion until settled or deferred. ACTIONS: open, reply, defer, resume, settle, block, unblock, show, rounds, list. open starts round 1 and optionally blocks_task_ids immediately. reply is refused once deferred or settled -- resume first. defer is explicitly non-blocking (paused, resumable); settle is terminal and archives the discussion. block/unblock manage the blocking relationship to a task independently of open. A task's completion is refused while any active Discussion blocks it. open/reply can pose a structured choice via options (2-10 entries) + options_mode ('single' mutually exclusive, 'multi' allows several); reply answers a currently pending choice via selected, validated against it. Each option is either a bare string or {title, description}; description is optional for exactly 2 options (a self-evident yes/no) but REQUIRED and non-empty for every option once there are 3 or more -- rejected otherwise. One line: the real pro/con/risk/consequence, never padding that just restates the title. Pass live:true on open or reply to get the human's answer synchronously in this same call, via an interactive prompt (the pending choice's picker if one was posed, otherwise a freeform question) -- covers a completely open question with no artifact (open with no prior discussion) and a question tied to a specific existing artifact (reply, addressed by name) alike. Only takes effect with an interactive UI available; otherwise degrades silently to the normal async round. The live picker docks in the input area itself (falls back to a plain text prompt if unsupported in the current UI mode). PREFER `name` (the discussion's exact title) over `id`, `task_name`/`blocks_task_names` over `task_id`/`blocks_task_ids` -- all are backend implementation details, resolved from name automatically.",
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
			options: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Object({ title: Type.String(), description: Type.Optional(Type.String()) })]))),
			options_mode: Type.Optional(Type.String()),
			selected: Type.Optional(Type.Array(Type.String())),
			live: Type.Optional(Type.Boolean()),
		}),
		// Blocks other tool calls in the same assistant turn until live:true's human answer comes
		// back, same reasoning as pi-ask-user's own tool: the model must not batch a live ask with
		// bash/edit/write and let those run before the human sees the prompt.
		executionMode: "sequential",
		renderCall(args, theme) { return renderPapyrusToolCall("Discuss", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, rawParams, signal, onUpdate, ctx) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				const action = params.action;
				const taskScope = { project_root: ctx.cwd };
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "discuss.list", baseRequest: {} },
					{ nameKey: "task_name", idKey: "task_id", listOperation: "tasks.list", baseRequest: taskScope },
				]);
				await resolveNameArrayField(params, "blocks_task_names", "blocks_task_ids", "tasks.list", taskScope);
				if (action === "open" || action === "reply") {
					normalizeDiscussOptions(params);
					// Matches the tasks/notes tools' own convention: an agent-driven mutation with no
					// explicit human actor still needs a real, non-generic label for the audit trail,
					// not a bare daemon rejection.
					if (typeof params.actor !== "string" || params.actor.length === 0) params.actor = "agent";
					const operation = action === "open" ? "discuss.open" : "discuss.reply";
					const result = await callService<Record<string, unknown>, DiscussionAndRounds>(operation, params);
					const fallback = action === "open"
						? text(`Opened discussion ${artifactLine(result.discussion)}`, createArtifactDetails("discuss.open", result.discussion))
						: text(`Round ${result.rounds[0]?.roundNumber} added to "${result.discussion.title}"`, createArtifactDetails("discuss.reply", result.discussion));
					if (params.live !== true) return fallback;
					const answer = await liveAnswer(ctx, result.discussion, result.rounds[0]?.content, onUpdate, signal);
					if (!answer) return fallback;
					const answered = await callService<Record<string, unknown>, DiscussionAndRounds>("discuss.reply", {
						id: result.discussion.id, actor: "human", content: answer.content, ...(answer.selected ? { selected: answer.selected } : {}), source: "discuss-live",
					});
					return text(`"${answered.discussion.title}": ${answer.content}`, createArtifactDetails("discuss.reply", answered.discussion));
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

/** Thin orchestrator: each domain's tool is independently navigable/testable via its own registerXTool function. */
export function registerDomainTools(pi: ExtensionAPI): void {
	registerTasksTool(pi);
	registerNotesTool(pi);
	registerDocsTool(pi);
	registerRulesTool(pi);
	registerPlaybooksTool(pi);
	registerSkillsTool(pi);
	registerDiscussTool(pi);
}
