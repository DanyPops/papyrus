import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	PROOF_TYPES,
	readDiscussionExtra,
	type Artifact,
	type DiscussionAndRounds,
	type DiscussionRound,
	type GateResult,
	type OperationName,
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
 * tasks.list is the one list operation that requires `project_root` and separately supports a
 * `scope` ("project" | "graph" | "all") to widen or narrow the search. Every other list operation
 * (docs.list, rules.list, skills.list, playbooks.list, artifact.query, ...) instead treats an
 * omitted `project_root` as an unscoped/global search (domain-services.ts's listScoped) and has
 * no `scope` concept at all -- so "search everywhere" means something different for each.
 */
const SCOPE_AWARE_LIST_OPERATIONS = new Set<OperationName>(["tasks.list"]);

/** The widened-scope request tried once when a name isn't found under the caller's current scope. */
function widenedRequest(listOperation: OperationName, baseRequest: Record<string, unknown>): Record<string, unknown> {
	return SCOPE_AWARE_LIST_OPERATIONS.has(listOperation)
		? { ...baseRequest, scope: "all" }
		: { ...baseRequest, project_root: undefined };
}

/**
 * Resolves a name to its id via `listOperation` (whichever kind's list call is the right search
 * scope -- tasks.list, docs.list, rules.list, skills.list, notes.list, discuss.list, or the
 * kind-agnostic artifact.query for a cross-kind reference like a link target). `baseRequest`
 * should mirror whatever scoping (project_root, etc.) that operation's own "list" action already
 * uses, so resolution never searches a wider or narrower scope than a plain list call would.
 *
 * A two-artifact action (depend/contain/gate/link) routinely names artifacts that live in two
 * different projects, and one call has no way to give two different name fields two different
 * scopes. When the first lookup finds nothing under the caller's current scope, retry exactly
 * once against a global search before giving up -- but never when the caller already pinned an
 * explicit `scope`, so a genuine "not found in the scope I asked for" stays a real error instead
 * of being silently papered over. `notes`, when given, records that a name only resolved after
 * widening, so the caller can surface that a search went wider than the caller's default scope
 * rather than resolving silently.
 */
async function resolveArtifactIdByName(listOperation: OperationName, baseRequest: Record<string, unknown>, name: string, notes?: string[]): Promise<string> {
	const candidates = await callService<Record<string, unknown>, Artifact[]>(listOperation, { ...baseRequest, text: name });
	try {
		return matchArtifactByName(candidates, name);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("no artifact named") || baseRequest["scope"] !== undefined) throw error;
		const widenedCandidates = await callService<Record<string, unknown>, Artifact[]>(listOperation, { ...widenedRequest(listOperation, baseRequest), text: name });
		const id = matchArtifactByName(widenedCandidates, name);
		notes?.push(`"${name}" was not found in the current project scope; resolved across all projects instead.`);
		return id;
	}
}

/**
 * Resolves every {nameKey -> idKey} pair present and not already satisfied by an explicit id, in
 * place. `notes`, when given, collects a message for each name that only resolved by widening
 * past the caller's own scope (see resolveArtifactIdByName) -- callers that want that surfaced
 * to the model/human pass an array here and append it to their own response text.
 */
export async function resolveNameFields(
	params: Record<string, unknown>,
	fields: ReadonlyArray<{ nameKey: string; idKey: string; listOperation: OperationName; baseRequest: Record<string, unknown> }>,
	notes?: string[],
): Promise<void> {
	for (const { nameKey, idKey, listOperation, baseRequest } of fields) {
		const nameValue = params[nameKey];
		if (typeof nameValue === "string" && nameValue.length > 0 && !params[idKey]) {
			params[idKey] = await resolveArtifactIdByName(listOperation, baseRequest, nameValue, notes);
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
	notes?: string[],
): Promise<void> {
	const names = params[namesKey];
	if (Array.isArray(names) && names.length > 0 && !params[idsKey]) {
		params[idsKey] = await Promise.all(names.map((entry) => resolveArtifactIdByName(listOperation, baseRequest, String(entry), notes)));
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
	if (action === "remove_subtree") {
		const label = await titleOf();
		const outcome = await callService<Record<string, unknown>, { removed: string[]; skipped: string[] }>("artifact.remove_subtree", params);
		const message = `Trashed ${label} and ${outcome.removed.length - 1} contained artifact(s)${outcome.skipped.length > 0 ? `, skipped ${outcome.skipped.length} already-trashed` : ""}.`;
		return text(message, createPreviewDetails("artifact.remove_subtree", "Trashed subtree", JSON.stringify(outcome, null, 2)));
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
		description: "Task domain tool. ACTIONS: create, update, list, show, history, context, scope, set_scope, assign_project, graph, plan, active, focused, focus, pause, unpause, clear_focus, start, submit, complete, reject, retry, cancel, cancel_subtree, run_gates, set_checklist, set_gates, depend, undepend, contain, uncontain, remove, remove_subtree, restore, claim, heartbeat_lease, release_lease, lease, event_feed. Lifecycle: todo → in-progress → review → done; review failure → rejected → retry → in-progress; canceled is terminal. Focus and lease are independent of lifecycle and of each other -- multiple sessions can focus the same task while only one holds its lease (claim throws if a different owner already holds one; release/heartbeat need the exact token claim returned; owner defaults to this session's id). context returns the full plan (the system prompt itself only carries a one-line pointer) -- call it explicitly after a compaction or before reconciling. complete runs gates + checklist-proof review, then focuses one ready successor. cancel_subtree cancels a task and its whole containment subtree in one call, skipping tasks already done/canceled. remove/restore use a time-gated trash (refuses the live Focus); remove_subtree trashes a whole `contains` subtree in one call; undepend/uncontain are idempotent no-ops when the edge is already absent. update recovers an accidentally-terminal task via status=todo + reason, without rewriting real history; update never touches gates (title/body/labels/status only) -- use set_gates to replace a task's gate commands after creation. Prefer `name` (exact title) over `id` -- id is a backend detail, resolved automatically, needed only to disambiguate a shared title; `parent_name`/`child_name`/`root_task_name` are the same pattern for their `_id` counterparts. For a prerequisite, use `dependency_name` (singular, resolved to `dependency_id`) with the `depend`/`undepend` actions; `depends_on_names` (plural array, resolved to `depends_on`) is only for `create`'s initial dependency set -- passing the wrong one of the two to `depend` leaves `dependency_id` unset and fails with a `dependency_id is required` error. A name resolved outside this call's own project scope (e.g. depending on a task in a different project) is retried once against every project before failing, and the response notes when that happened.",
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
				// Collects a note whenever a name field below only resolved by widening past this call's
				// own project scope (see resolveArtifactIdByName) -- surfaced at the end of this action's
				// own response text rather than resolved silently, since a cross-project depend/contain
				// is exactly the case a shared per-call scope can't otherwise express.
				const notes: string[] = [];
				// Resolve the graph root first: every other name lookup must use the caller's final
				// project/scope/root selection, otherwise `scope: all|graph` silently collapses back
				// to the current project and forces callers to reach for an id.
				await resolveNameFields(params, [
					{ nameKey: "root_task_name", idKey: "root_task_id", listOperation: "tasks.list", baseRequest: { ...baseRequest, scope: "project" } },
				], notes);
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
				], notes);
				await resolveNameArrayField(params, "depends_on_names", "depends_on", "tasks.list", resolutionRequest, notes);
				const request = { ...params, ...baseRequest };
				const result = await (async (): Promise<ReturnType<typeof text>> => {
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
				if (action === "set_gates") {
					const artifact = await callService<Record<string, unknown>, Artifact>("tasks.set_gates", params);
					return text(`Updated gates: ${artifactLine(artifact)}`, createArtifactDetails("tasks.set_gates", artifact));
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
				if (action === "cancel_subtree") {
					const outcome = await callService<Record<string, unknown>, { canceled: string[]; skipped: string[] }>("tasks.cancel_subtree", request);
					const output = `Canceled ${outcome.canceled.length} task(s)${outcome.skipped.length > 0 ? `, skipped ${outcome.skipped.length} already-terminal` : ""}.`;
					return text(output, createPreviewDetails("tasks.cancel_subtree", "Cancel task subtree", JSON.stringify(outcome, null, 2)));
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
				})();
				if (notes.length > 0 && result.content[0]?.type === "text") result.content[0].text += `\n\n${notes.join("\n")}`;
				return result;
			} catch (error) {
				throw new Error(`tasks failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});
}

// notes.*, rules.*, docs.*, skills.*, playbooks.*, and the shared artifact.* are
// registered as Vehicles (see ../vehicle-notes-client.ts and @danypops/papyrus's
// src/vehicle/papyrus-vehicle.ts), not pi.registerTool()s in this file.

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
// notes, rules, docs, skills, and playbooks are no longer registered here -- all migrated onto
// Vehicle (registerNotesVehicle in vehicle-notes-client.ts, wired at session_start in index.ts),
// replacing their own pi.registerTool() mega-tools. See @danypops/papyrus's
// src/vehicle/papyrus-vehicle.ts for the server side.
export function registerDomainTools(pi: ExtensionAPI): void {
	registerTasksTool(pi);
	registerDiscussTool(pi);
}
