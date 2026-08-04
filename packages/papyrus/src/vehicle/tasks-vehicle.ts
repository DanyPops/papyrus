/**
 * Tasks projected as a real VehicleRegistry: one VehicleOperation per real action.
 * Wraps modules/tasks.ts's operation definitions -- the largest domain (37 actions),
 * already fully extracted server-side.
 *
 * tasks.focus/pause/unpause/clear_focus keep two things the raw RPC tool used to
 * handle client-side, since neither is expressible inside a stateless Vehicle
 * operation's own input/output contract:
 *
 *  - session_secret authorizes which session's Task Focus row gets mutated
 *    (modules/tasks.ts's own guardFocusMutation). It must never be a model-visible
 *    input field -- it travels through VehicleInvocationOptions.principal.claims,
 *    the same mechanism playbooks.invoke uses (see vehicle-notes-client.ts).
 *  - papyrus.task-focus.v1 is a same-process Pi extension event bus broadcast (a
 *    token-cost router or similar can correlate its own telemetry with the
 *    currently focused task) with no Vehicle-transport equivalent -- fired from
 *    pi-papyrus's own onInvoked hook (see vehicle-client-pi's registerVehicleTools),
 *    not from this module, since a remote HTTP Vehicle consumer has no such bus.
 *
 * remove/remove_subtree/restore are not duplicated here -- see ./artifact-trash-vehicle.ts.
 */
import { bindVehicleOperation, defineVehicleOperation, type VehicleOperationContext } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { TaskViewMode } from "../domain/task-scope.ts";
import { tasksOperations } from "../modules/tasks.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { SessionIdentity } from "../session-identity-service.ts";
import type { TaskExecutionPlan } from "../task-execution.ts";
import type { TaskCompletion, Tasks } from "../task-service.ts";
import {
	classifySessionAuthorization,
	classifyTaskDependencyCycles,
	classifyTaskExecutionBounds,
	labelsById,
	looseObjectSchema,
	numberProp,
	passthroughOutput,
	resolveArtifactIdWidened,
	stringProp,
	validationError,
} from "./artifact-vehicle-shared.ts";

const OWNER = "tasks";
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

const objectProp = { type: "object" } as unknown as { type: string };
const arrayProp = { type: "array" } as unknown as { type: string };
const _boolProp = { type: "boolean" } as unknown as { type: string };

export interface TasksVehicleDeps {
	tasks: Tasks;
	artifacts: ArtifactStore;
	sessionIdentity: SessionIdentity;
}

/**
 * Resolves an id from either an explicit id or a title lookup scoped to the exact
 * same view (project_root/scope/root_task_id) a plain tasks.list call under those
 * same filters would use -- name resolution must never search a wider or narrower
 * scope than the caller's own view. tasks.list itself requires project_root (see
 * modules/tasks.ts's taskFilter), so resolving by name does too: there is no
 * ambient cwd server-side to default to, unlike the removed client-side tool.
 *
 * A two-task action (depend/contain) routinely names tasks that live in two
 * different projects. When the caller didn't already pin an explicit `scope`, a
 * miss under the narrow filter retries once against `scope: "all"` before giving
 * up -- the same widen-once behavior the removed tool's own resolveArtifactIdByName
 * carried, hard-won from real cross-project depend/contain friction.
 */
function resolveTaskId(
	tasks: Tasks,
	filter: { projectRoot?: string; scope?: TaskViewMode; rootTaskId?: string },
	id: unknown,
	name: unknown,
): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw validationError("id or name is required");
	if (!filter.projectRoot) throw validationError("project_root is required when resolving a task by name");
	return resolveArtifactIdWidened(
		name,
		() => tasks.list({ ...filter, text: name }),
		filter.scope === undefined ? () => tasks.list({ ...filter, scope: "all", text: name }) : undefined,
	);
}

/** Resolves root_task_name first and scoped to "project" only, matching the removed tool's own resolution order -- every other name lookup below must see the caller's FINAL scope/root selection, which root_task_id itself feeds into. */
function resolveRootTaskId(tasks: Tasks, projectRoot: string | undefined, rootTaskId: unknown, rootTaskName: unknown): string | undefined {
	if (typeof rootTaskId === "string" && rootTaskId.length > 0) return rootTaskId;
	if (typeof rootTaskName !== "string" || rootTaskName.length === 0) return undefined;
	return resolveTaskId(tasks, { projectRoot, scope: "project" }, undefined, rootTaskName);
}

function resolveArrayField(
	tasks: Tasks,
	filter: { projectRoot?: string; scope?: TaskViewMode; rootTaskId?: string },
	ids: unknown,
	names: unknown,
): string[] | undefined {
	if (Array.isArray(ids)) return ids as string[];
	if (!Array.isArray(names) || names.length === 0) return undefined;
	return names.map((entry) => resolveTaskId(tasks, filter, undefined, String(entry)));
}

const readSchemaProps = {
	status: stringProp,
	text: stringProp,
	limit: numberProp,
	project_root: stringProp,
	scope: { type: "string", enum: ["project", "graph", "all"] },
	root_task_id: stringProp,
	root_task_name: stringProp,
	session_id: stringProp,
	labels: arrayProp,
};

/** Same gate/checklist narrative lines the removed tool built client-side. */
function completionContentText(labels: Map<string, string>, result: TaskCompletion): string {
	const gates = result.gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n");
	const checklist = result.checklist
		.map((item) => `${item.accepted ? "✓" : "✗"} proof: ${item.item}${item.reason ? ` — ${item.reason}` : ""}`)
		.join("\n");
	const focused = result.focused ? `\nActive: ${result.focused.title} (${result.focused.id})` : "";
	const blocked =
		result.blocked.length > 0
			? `\nBlocked: ${result.blocked.map((entry) => `${entry.artifact.title} (${entry.artifact.id}) waits for ${entry.dependencyIds.map((id) => labels.get(id) ?? "unknown task").join(", ")}`).join("; ")}`
			: "";
	return `${result.completed ? "Completed" : "Rejected"}: ${result.artifact.title} (${result.artifact.id})${focused}${blocked}${checklist ? `\n${checklist}` : ""}${gates ? `\n${gates}` : ""}`;
}

function planContentText(plan: TaskExecutionPlan): string {
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
		...layer.map((id) => `  [${byId.get(id)?.state ?? "unknown"}] ${nodeLabel(id)}`),
	]);
	if (plan.cycleIds.length > 0) lines.push(`Invalid cycle: ${plan.cycleIds.map(nodeLabel).join(", ")}`);
	return lines.join("\n") || "No tasks in execution plan.";
}

export function registerTasksVehicleOperations(registry: VehicleRegistry, deps: TasksVehicleDeps): void {
	const { tasks, artifacts, sessionIdentity } = deps;
	const moduleOperations = new Map(tasksOperations(tasks, artifacts, sessionIdentity).map((op) => [op.name, op]));
	/**
	 * Every tasks.* action funnels through here, so classifying a handful of reviewed domain error
	 * classes (execution-graph bounds, dependency cycles, Task Focus authorization) at this one
	 * choke point covers every action that can throw them. Anything else propagates unchanged --
	 * vehicle-registry's own secure-by-default handler-failed opacity still applies to a genuine
	 * unexpected crash (see artifact-vehicle-shared.ts's classify* helpers).
	 */
	const call = (name: string, input: Record<string, unknown>): unknown =>
		classifySessionAuthorization(() =>
			classifyTaskExecutionBounds(() => classifyTaskDependencyCycles(() => moduleOperations.get(name)!.execute(input))),
		);

	const define = (
		action: string,
		description: string,
		effect: "read" | "local-write",
		properties: Record<string, { type: string; enum?: readonly string[] }>,
		required: readonly string[],
		resolve: (input: Record<string, unknown>) => Record<string, unknown>,
		execute?: (input: Record<string, unknown>, context: VehicleOperationContext<Record<string, unknown>>) => unknown,
	): void => {
		const operation = defineVehicleOperation({
			name: `tasks.${action}`,
			version: 1,
			description,
			input: looseObjectSchema(properties, required),
			output: passthroughOutput,
			permissions: ["tasks:read", "tasks:write"],
			effect,
			idempotency: { mode: effect === "read" ? "safe" : "unsafe" },
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(
				operation,
				() => async (context) =>
					(execute ?? ((input: Record<string, unknown>) => call(`tasks.${action}`, input)))(resolve(context.input), context),
			),
		);
	};

	/** Shared by every action taking a single id/name: resolves root_task_name first, then name -> id against the final scope. */
	const resolveIdAndScope = (input: Record<string, unknown>): Record<string, unknown> => {
		const projectRoot = input.project_root as string | undefined;
		const rootTaskId = resolveRootTaskId(tasks, projectRoot, input.root_task_id, input.root_task_name);
		const scope = input.scope as TaskViewMode | undefined;
		const filter = { projectRoot, scope, rootTaskId };
		return {
			...input,
			...(rootTaskId ? { root_task_id: rootTaskId } : {}),
			id: resolveTaskId(tasks, filter, input.id, input.name),
		};
	};

	define(
		"create",
		"Creates a Task -- work: desired outcomes, gates, checklists, and dependencies. project_root is required (no ambient cwd server-side). Prefer parent_name/depends_on_names over parent_id/depends_on -- resolved server-side.",
		"local-write",
		{
			title: stringProp,
			body: stringProp,
			status: stringProp,
			labels: arrayProp,
			extra: objectProp,
			gates: arrayProp,
			checklist: objectProp,
			template_id: stringProp,
			parent_id: stringProp,
			parent_name: stringProp,
			depends_on: arrayProp,
			depends_on_names: arrayProp,
			project_root: stringProp,
			session_id: stringProp,
		},
		["title", "project_root"],
		(input) => {
			const projectRoot = input.project_root as string;
			const filter = { projectRoot };
			const parentId =
				typeof input.parent_id === "string" && input.parent_id.length > 0
					? input.parent_id
					: typeof input.parent_name === "string" && input.parent_name.length > 0
						? resolveTaskId(tasks, filter, undefined, input.parent_name)
						: undefined;
			const dependsOn = resolveArrayField(tasks, filter, input.depends_on, input.depends_on_names);
			return { ...input, ...(parentId ? { parent_id: parentId } : {}), ...(dependsOn ? { depends_on: dependsOn } : {}) };
		},
	);

	define(
		"update",
		"Recovers an accidentally-terminal task via status=todo + reason, or changes title/body/labels, without rewriting real history. Never touches gates -- use set_gates.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			title: stringProp,
			body: stringProp,
			labels: arrayProp,
			status: stringProp,
			reason: stringProp,
			session_id: stringProp,
			project_root: stringProp,
		},
		[],
		resolveIdAndScope,
	);

	define(
		"list",
		"Lists Tasks matching an optional status/text/labels filter, scoped to project_root. project_root is required (no ambient cwd server-side).",
		"read",
		readSchemaProps,
		["project_root"],
		(input) => {
			const rootTaskId = resolveRootTaskId(tasks, input.project_root as string, input.root_task_id, input.root_task_name);
			return { ...input, ...(rootTaskId ? { root_task_id: rootTaskId } : {}) };
		},
	);

	define(
		"graph",
		"Returns the full task graph (nodes with parent/child/dependency ids) for the requested scope. project_root is required.",
		"read",
		readSchemaProps,
		["project_root"],
		(input) => {
			const rootTaskId = resolveRootTaskId(tasks, input.project_root as string, input.root_task_id, input.root_task_name);
			return { ...input, ...(rootTaskId ? { root_task_id: rootTaskId } : {}) };
		},
	);

	define(
		"plan",
		"Projects the task graph into layered execution order (ready/blocked/invalid states, cycle detection). project_root is required.",
		"read",
		readSchemaProps,
		["project_root"],
		(input) => {
			const rootTaskId = resolveRootTaskId(tasks, input.project_root as string, input.root_task_id, input.root_task_name);
			return { ...input, ...(rootTaskId ? { root_task_id: rootTaskId } : {}) };
		},
		(input) => {
			const plan = call("tasks.plan", input) as TaskExecutionPlan;
			return { ...plan, content: [{ type: "text" as const, text: planContentText(plan) }] };
		},
	);

	define(
		"show",
		"Shows one Task by id or title.",
		"read",
		{
			id: stringProp,
			name: stringProp,
			project_root: stringProp,
			scope: { type: "string", enum: ["project", "graph", "all"] },
			root_task_id: stringProp,
			root_task_name: stringProp,
		},
		[],
		resolveIdAndScope,
	);

	define(
		"history",
		"Task's append-only lifecycle event history, cursor-paginated.",
		"read",
		{
			id: stringProp,
			name: stringProp,
			limit: numberProp,
			cursor: numberProp,
			direction: { type: "string", enum: ["asc", "desc"] },
			project_root: stringProp,
			scope: { type: "string", enum: ["project", "graph", "all"] },
			root_task_id: stringProp,
			root_task_name: stringProp,
		},
		[],
		resolveIdAndScope,
	);

	define(
		"scope",
		"Describes the current task-view scope selection for project_root.",
		"read",
		{ project_root: stringProp },
		["project_root"],
		(input) => input,
	);

	define(
		"set_scope",
		"Sets the task-view scope (project/graph/all) for project_root, optionally pinned to root_task_id.",
		"local-write",
		{
			project_root: stringProp,
			scope: { type: "string", enum: ["project", "graph", "all"] },
			root_task_id: stringProp,
			root_task_name: stringProp,
		},
		["project_root", "scope"],
		(input) => {
			const rootTaskId = resolveRootTaskId(tasks, input.project_root as string, input.root_task_id, input.root_task_name);
			return { ...input, ...(rootTaskId ? { root_task_id: rootTaskId } : {}) };
		},
	);

	define(
		"assign_project",
		"Reassigns a Task's project_root.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, session_id: stringProp },
		["project_root"],
		(input) => ({ ...input, id: resolveTaskId(tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name) }),
	);

	define(
		"active",
		"The current active Task (the one being worked on) for this scope. project_root is required.",
		"read",
		readSchemaProps,
		["project_root"],
		(input) => input,
	);
	define(
		"focused",
		"The current focused Task and its focus status (focused/paused) for this session's scope. project_root is required.",
		"read",
		readSchemaProps,
		["project_root"],
		(input) => input,
	);

	const focusOperation = (
		action: "focus" | "pause" | "unpause" | "clear_focus",
		description: string,
		properties: Record<string, { type: string; enum?: readonly string[] }>,
		required: readonly string[],
		resolve: (input: Record<string, unknown>) => Record<string, unknown>,
	): void => {
		const operation = defineVehicleOperation({
			name: `tasks.${action}`,
			version: 1,
			description,
			input: looseObjectSchema(properties, required),
			output: passthroughOutput,
			permissions: ["tasks:read", "tasks:write"],
			effect: "local-write",
			idempotency: { mode: "unsafe" },
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(operation, () => async (context) => {
				const claims = context.principal?.claims as { sessionId?: string; sessionSecret?: string } | undefined;
				return call(`tasks.${action}`, { ...resolve(context.input), session_id: claims?.sessionId, session_secret: claims?.sessionSecret });
			}),
		);
	};

	focusOperation(
		"focus",
		"Sets the active Task Focus (singular per scope) to this Task. Multiple sessions can focus the same task while only one holds its lease.",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveTaskId(tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name) }),
	);
	focusOperation("pause", "Pauses the active Task Focus without clearing it.", { reason: stringProp }, [], (input) => input);
	focusOperation("unpause", "Resumes a paused Task Focus.", {}, [], (input) => input);
	focusOperation("clear_focus", "Clears the active Task Focus.", {}, [], (input) => input);

	define(
		"start",
		"Lifecycle transition: todo -> in-progress.",
		"local-write",
		{ id: stringProp, name: stringProp, reason: stringProp, session_id: stringProp, project_root: stringProp },
		[],
		resolveIdAndScope,
	);
	define(
		"submit",
		"Lifecycle transition: in-progress -> review.",
		"local-write",
		{ id: stringProp, name: stringProp, reason: stringProp, session_id: stringProp, project_root: stringProp },
		[],
		resolveIdAndScope,
	);
	define(
		"reject",
		"Lifecycle transition: review -> rejected.",
		"local-write",
		{ id: stringProp, name: stringProp, reason: stringProp, session_id: stringProp, project_root: stringProp },
		[],
		resolveIdAndScope,
	);
	define(
		"retry",
		"Lifecycle transition: rejected -> in-progress.",
		"local-write",
		{ id: stringProp, name: stringProp, reason: stringProp, session_id: stringProp, project_root: stringProp },
		[],
		resolveIdAndScope,
	);
	define(
		"cancel",
		"Lifecycle transition to canceled (terminal) from todo/in-progress/review/rejected.",
		"local-write",
		{ id: stringProp, name: stringProp, reason: stringProp, session_id: stringProp, project_root: stringProp },
		[],
		resolveIdAndScope,
	);

	define(
		"complete",
		"Runs gates + checklist-proof review, then focuses one deterministic ready successor without claiming effort. Rejects (not completes) on gate/checklist failure.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			reason: stringProp,
			session_id: stringProp,
			project_root: stringProp,
			scope: { type: "string", enum: ["project", "graph", "all"] },
			root_task_id: stringProp,
			root_task_name: stringProp,
		},
		[],
		resolveIdAndScope,
		async (input) => {
			const result = (await call("tasks.complete", input)) as TaskCompletion;
			const dependencyIds = result.blocked.flatMap((entry) => entry.dependencyIds);
			const labels = labelsById(artifacts, dependencyIds);
			return { ...result, content: [{ type: "text" as const, text: completionContentText(labels, result) }] };
		},
	);

	define(
		"run_gates",
		"Runs a Task's configured gates without transitioning its status -- for checking readiness before submit/complete.",
		"read",
		{
			id: stringProp,
			name: stringProp,
			session_id: stringProp,
			project_root: stringProp,
			scope: { type: "string", enum: ["project", "graph", "all"] },
			root_task_id: stringProp,
			root_task_name: stringProp,
		},
		[],
		resolveIdAndScope,
		async (input) => {
			const gates = (await call("tasks.run_gates", input)) as Array<{
				gate: { type: string; target: string };
				passed: boolean;
				output: string;
			}>;
			const text =
				gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n") ||
				"No gates configured.";
			return { gates, content: [{ type: "text" as const, text }] };
		},
	);

	define(
		"set_checklist",
		"Replaces a Task's evidence-bearing checklist (proof requirements) in full.",
		"local-write",
		{ id: stringProp, name: stringProp, checklist: objectProp, project_root: stringProp },
		["checklist"],
		resolveIdAndScope,
	);
	define(
		"set_gates",
		"Replaces a Task's gate commands in full.",
		"local-write",
		{ id: stringProp, name: stringProp, gates: arrayProp, project_root: stringProp },
		["gates"],
		resolveIdAndScope,
	);

	define(
		"context",
		"The full plan-reconciliation context (the system prompt itself only carries a one-line pointer) -- call explicitly after a compaction or before reconciling. project_root is required.",
		"read",
		readSchemaProps,
		["project_root"],
		(input) => ({ ...input, verbosity: "full" }),
		(input) => {
			const summary = call("tasks.context", input) as string | null;
			const text = summary ?? "No open tasks.";
			return { context: summary, content: [{ type: "text" as const, text }] };
		},
	);

	define(
		"cancel_subtree",
		"Cancels a Task and its whole containment subtree in one call, skipping tasks already done/canceled.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			reason: stringProp,
			session_id: stringProp,
			project_root: stringProp,
			scope: { type: "string", enum: ["project", "graph", "all"] },
			root_task_id: stringProp,
			root_task_name: stringProp,
		},
		[],
		resolveIdAndScope,
		(input) => {
			const outcome = call("tasks.cancel_subtree", input) as { canceled: string[]; skipped: string[] };
			const text = `Canceled ${outcome.canceled.length} task(s)${outcome.skipped.length > 0 ? `, skipped ${outcome.skipped.length} already-terminal` : ""}.`;
			return { ...outcome, content: [{ type: "text" as const, text }] };
		},
	);

	const scopeProp = { type: "string", enum: ["project", "graph", "all"] } as const;

	define(
		"depend",
		"Adds a dependency edge (this task waits for dependency_id/dependency_name). Dependency edges form an executable DAG -- self-dependencies and cycles are rejected. A name resolved outside project_root's own scope is retried once against every project before failing, unless scope is pinned explicitly.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			dependency_id: stringProp,
			dependency_name: stringProp,
			project_root: stringProp,
			scope: scopeProp,
			session_id: stringProp,
		},
		[],
		(input) => {
			const filter = { projectRoot: input.project_root as string | undefined, scope: input.scope as TaskViewMode | undefined };
			return {
				...input,
				id: resolveTaskId(tasks, filter, input.id, input.name),
				dependency_id: resolveTaskId(tasks, filter, input.dependency_id, input.dependency_name),
			};
		},
	);

	define(
		"undepend",
		"Removes a dependency edge. Idempotent -- a no-op if the edge is already absent.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			dependency_id: stringProp,
			dependency_name: stringProp,
			project_root: stringProp,
			scope: scopeProp,
			session_id: stringProp,
		},
		[],
		(input) => {
			const filter = { projectRoot: input.project_root as string | undefined, scope: input.scope as TaskViewMode | undefined };
			return {
				...input,
				id: resolveTaskId(tasks, filter, input.id, input.name),
				dependency_id: resolveTaskId(tasks, filter, input.dependency_id, input.dependency_name),
			};
		},
	);

	define(
		"contain",
		"Nests a child Task inside a parent (parent_id/parent_name contains child_id/child_name) -- explicit hierarchy, distinct from depends_on execution ordering. A name resolved outside project_root's own scope is retried once against every project before failing, unless scope is pinned explicitly.",
		"local-write",
		{
			parent_id: stringProp,
			parent_name: stringProp,
			child_id: stringProp,
			child_name: stringProp,
			project_root: stringProp,
			scope: scopeProp,
			session_id: stringProp,
		},
		[],
		(input) => {
			const filter = { projectRoot: input.project_root as string | undefined, scope: input.scope as TaskViewMode | undefined };
			return {
				...input,
				parent_id: resolveTaskId(tasks, filter, input.parent_id, input.parent_name),
				child_id: resolveTaskId(tasks, filter, input.child_id, input.child_name),
			};
		},
	);

	define(
		"uncontain",
		"Removes a parent/child nesting. Idempotent -- a no-op if the edge is already absent.",
		"local-write",
		{
			parent_id: stringProp,
			parent_name: stringProp,
			child_id: stringProp,
			child_name: stringProp,
			project_root: stringProp,
			scope: scopeProp,
			session_id: stringProp,
		},
		[],
		(input) => {
			const filter = { projectRoot: input.project_root as string | undefined, scope: input.scope as TaskViewMode | undefined };
			return {
				...input,
				parent_id: resolveTaskId(tasks, filter, input.parent_id, input.parent_name),
				child_id: resolveTaskId(tasks, filter, input.child_id, input.child_name),
			};
		},
	);

	define(
		"claim",
		"Claims this Task's lease under owner (defaults to session_id). Throws if a different owner already holds one.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			owner: stringProp,
			ttl_ms: numberProp,
			note: stringProp,
			project_root: stringProp,
			session_id: stringProp,
		},
		[],
		(input) => ({
			...input,
			id: resolveTaskId(tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name),
			owner: input.owner ?? input.session_id,
		}),
	);
	define(
		"heartbeat_lease",
		"Extends this Task's lease -- needs the exact owner/token claim() returned.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			owner: stringProp,
			token: stringProp,
			ttl_ms: numberProp,
			project_root: stringProp,
			session_id: stringProp,
		},
		["owner", "token"],
		(input) => ({ ...input, id: resolveTaskId(tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name) }),
	);
	define(
		"release_lease",
		"Releases this Task's lease -- needs the exact owner/token claim() returned.",
		"local-write",
		{ id: stringProp, name: stringProp, owner: stringProp, token: stringProp, project_root: stringProp, session_id: stringProp },
		["owner", "token"],
		(input) => ({ ...input, id: resolveTaskId(tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name) }),
	);
	define(
		"lease",
		"Shows this Task's current lease, if any.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveTaskId(tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name) }),
	);

	define(
		"event_feed",
		"Cursor-paginated feed of raw Task lifecycle events across every task, optionally filtered by event_types.",
		"read",
		{ cursor: numberProp, limit: numberProp, event_types: arrayProp },
		[],
		(input) => input,
	);
}

/** Kept out of the registry deliberately, matching the removed tool's own ACTIONS list -- system maintenance, not an agent-facing action. Exposed via reapStale* CLI/cron paths, not a Vehicle operation. */
export const TASKS_MAINTENANCE_OPERATIONS = ["tasks.reap_stale_focus", "tasks.reap_stale_leases"] as const;
