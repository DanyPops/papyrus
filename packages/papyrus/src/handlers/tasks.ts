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
 *    the same mechanism playbooks.invoke uses (see pi-papyrus's tools/vehicle-notes-client.ts).
 *  - papyrus.task-focus.v1 is a same-process Pi extension event bus broadcast (a
 *    token-cost router or similar can correlate its own telemetry with the
 *    currently focused task) with no Vehicle-transport equivalent -- fired from
 *    pi-papyrus's own onInvoked hook (see vehicle-client-pi's registerVehicleTools),
 *    not from this module, since a remote HTTP Vehicle consumer has no such bus.
 *
 * remove/remove_subtree/restore are not duplicated here -- see ./artifact-trash-vehicle.ts.
 */
import { VehicleError, type VehicleLimits, type VehicleOperationContext } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { GATE_TIMEOUT_MAX_MS, TASK_CREATE_IDEMPOTENCY_KEY_MAX_LENGTH, TASK_MUTATION_IDEMPOTENCY_KEY_MAX_LENGTH } from "../constants.ts";
import { PROOF_TYPES } from "../domain/checklist.ts";
import { GATE_TYPES } from "../domain/gate.ts";
import type { TaskViewMode } from "../domain/task-scope.ts";
import { tasksOperations } from "../modules/tasks.ts";
import type { SessionIdentity } from "../session-identity/session-identity-service.ts";
import { TaskMutationIdempotencyConflictError, TaskMutationPendingError } from "../stores/task-mutation-request-store.ts";
import type { TaskExecutionPlan } from "../task/task-execution.ts";
import {
	type TaskCompletion,
	TaskInvalidTransitionError,
	TaskMutationReceiptNotFoundError,
	TaskProjectAmbiguousError,
	TaskProjectNotFoundError,
	type Tasks,
} from "../task/task-service.ts";
import {
	booleanProp,
	classifySessionAuthorization,
	classifyTaskCreateIdempotency,
	classifyTaskDependencyCycles,
	classifyTaskExecutionBounds,
	createOperationDefiner,
	definePairedMutation,
	labelsById,
	numberProp,
	resolveArtifactIdWidened,
	stringProp,
	validationError,
} from "./shared.ts";

const OWNER = "tasks";

/**
 * tasks.run_gates/tasks.complete's own Vehicle transport limits, distinct from every other
 * tasks.* CRUD action's shared STANDARD_OPERATION_LIMITS (createOperationDefiner's own default,
 * 5s). Those two operations shell out to and wait on a real, caller-configured external command
 * (domain/gate.ts's Gate.timeoutMs) -- the shared 5s CRUD default was an accidental inheritance,
 * not a deliberate choice, and aborted the RPC call for any gate command that took longer than a
 * few seconds, even a genuinely successful one (confirmed live, twice, with hard numbers: a real
 * ~13s gate failed deterministically every time; a ~28s gate flapped around a separate, unrelated
 * 30s inner per-gate-type default).
 *
 * defaultTimeoutMs is derived from GATE_TIMEOUT_MAX_MS (the longest a single gate's own explicit
 * timeoutMs may request) plus a buffer for process-spawn/RPC/serialization overhead, so the outer
 * transport deadline can never fire strictly before a single gate honoring that ceiling has had a
 * chance to. A task with SEVERAL gates each near that ceiling can still exceed this default in
 * aggregate (gates run sequentially -- see ops.ts's runGatesAsync); there is no aggregate
 * task-level gate-time budget yet. maxTimeoutMs gives a caller who knows its gates are
 * collectively slower room to explicitly request a longer deadline.
 */
const GATE_OPERATION_LIMITS: VehicleLimits = {
	defaultTimeoutMs: GATE_TIMEOUT_MAX_MS + 60_000,
	maxTimeoutMs: GATE_TIMEOUT_MAX_MS * 4,
	maxRequestBytes: 65_536,
	maxResponseBytes: 262_144,
};

const objectProp = { type: "object" } as const;
const arrayProp = { type: "array" } as const;
const _boolProp = { type: "boolean" } as const;
const mutationIdempotencyProp = {
	type: "string",
	minLength: 1,
	maxLength: TASK_MUTATION_IDEMPOTENCY_KEY_MAX_LENGTH,
	description:
		"Retry key for this exact mutation. Reuse the same key after an unknown outcome; inspect mutation_status before choosing a new action.",
} as const;

const gateProp = {
	type: "array",
	description: "Validation gates run by tasks.run_gates and tasks.complete.",
	items: {
		type: "object",
		description: "Accepted gate shape: {type, target, expect?, timeoutMs?}.",
		properties: {
			type: { type: "string", enum: GATE_TYPES, description: "Gate evaluator." },
			target: { type: "string", minLength: 1, description: "Path, command, text target, or test command." },
			expect: { type: "string", description: "Optional expected text/result." },
			timeoutMs: { type: "integer", minimum: 1_000, maximum: GATE_TIMEOUT_MAX_MS, description: "Command/test timeout override." },
		},
		required: ["type", "target"],
		additionalProperties: false,
	},
	examples: [
		[{ type: "file-exists", target: "dist/index.js" }],
		[{ type: "command", target: "bun run typecheck", timeoutMs: 60_000 }],
		[{ type: "contains", target: "README.md", expect: "Retry semantics" }],
		[{ type: "test", target: "bun test" }],
	],
} as const;

/**
 * `patternProperties: {"^.*$": entrySchema}` rather than `additionalProperties: entrySchema`,
 * despite both meaning "every key maps to entrySchema" for a free-form string-keyed map:
 * confirmed live (2026-08-09) that TypeBox's own Value.Errors -- the schema validator Pi's tool-
 * calling harness runs client-side, before a call ever reaches this daemon -- reports an
 * additionalProperties-as-schema violation only as a generic top-level "must not have additional
 * properties", with zero descent into which nested field actually broke, while the structurally
 * identical items-as-schema case (gates, proof arrays below) descends and reports the exact
 * broken field. patternProperties does not have that limitation and gives the same precision as
 * items. See handlers/shared.ts's OperationSchemaNode.patternProperties for the matching
 * server-side runtime check, and vehicle-shell.ts's formatSchemaChildren for the matching
 * tools_man rendering.
 */
const checklistProp = {
	type: "object",
	description: "Map from completion criterion text to one or more typed proof references. An empty map clears the checklist.",
	patternProperties: {
		"^.*$": {
			type: "object",
			properties: {
				proof: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						description: "Accepted proof shape: {type, target, expect?}.",
						properties: {
							type: { type: "string", enum: PROOF_TYPES },
							target: { type: "string", minLength: 1 },
							expect: { type: "string" },
						},
						required: ["type", "target"],
						additionalProperties: false,
					},
				},
			},
			required: ["proof"],
			additionalProperties: false,
		},
	},
	additionalProperties: false,
	examples: [
		{
			"tests pass": { proof: [{ type: "test", target: "bun test", expect: "0 failures" }] },
			"documentation updated": { proof: [{ type: "file", target: "README.md" }] },
		},
	],
} as const;

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
	artifacts: ArtifactStore,
	tasks: Tasks,
	filter: { projectRoot?: string; scope?: TaskViewMode; rootTaskId?: string },
	id: unknown,
	name: unknown,
): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw validationError("id or name is required");
	if (!filter.projectRoot) throw validationError("project_root is required when resolving a task by name");
	return resolveArtifactIdWidened(
		artifacts,
		name,
		() => tasks.list({ ...filter, text: name }),
		filter.scope === undefined ? () => tasks.list({ ...filter, scope: "all", text: name }) : undefined,
	);
}

/** Resolves root_task_name first and scoped to "project" only, matching the removed tool's own resolution order -- every other name lookup below must see the caller's FINAL scope/root selection, which root_task_id itself feeds into. */
function resolveRootTaskId(
	artifacts: ArtifactStore,
	tasks: Tasks,
	projectRoot: string | undefined,
	rootTaskId: unknown,
	rootTaskName: unknown,
): string | undefined {
	if (typeof rootTaskId === "string" && rootTaskId.length > 0) return rootTaskId;
	if (typeof rootTaskName !== "string" || rootTaskName.length === 0) return undefined;
	return resolveTaskId(artifacts, tasks, { projectRoot, scope: "project" }, undefined, rootTaskName);
}

function resolveArrayField(
	artifacts: ArtifactStore,
	tasks: Tasks,
	filter: { projectRoot?: string; scope?: TaskViewMode; rootTaskId?: string },
	ids: unknown,
	names: unknown,
): string[] | undefined {
	if (Array.isArray(ids)) return ids as string[];
	if (!Array.isArray(names) || names.length === 0) return undefined;
	return names.map((entry) => resolveTaskId(artifacts, tasks, filter, undefined, String(entry)));
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

/** list-only: opts into full Artifact bodies instead of the lean summarizeArtifact() default (modules/tasks.ts). */
const listSchemaProps = { ...readSchemaProps, full: booleanProp };

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
	const throwLifecycleError = (error: unknown): never => {
		if (error instanceof TaskInvalidTransitionError) {
			throw new VehicleError("invalid-transition", error.message, {
				category: "conflict",
				details: {
					operation: error.operation,
					currentStatus: error.currentStatus,
					intendedStatus: error.intendedStatus,
					allowedActions: [...error.allowedActions],
					recovery: error.recovery,
				},
			});
		}
		if (error instanceof TaskMutationIdempotencyConflictError) {
			throw new VehicleError("idempotency-key-conflict", error.message, { category: "conflict" });
		}
		if (error instanceof TaskMutationPendingError) {
			throw new VehicleError("mutation-pending", error.message, {
				category: "conflict",
				details: { receiptId: error.receiptId, operation: error.operation },
			});
		}
		if (error instanceof TaskMutationReceiptNotFoundError) {
			throw new VehicleError("mutation-receipt-not-found", error.message, { category: "not_found" });
		}
		throw error;
	};
	const classifyLifecycle = <T>(run: () => T): T => {
		try {
			const result = run();
			return result instanceof Promise ? (result.catch(throwLifecycleError) as T) : result;
		} catch (error) {
			return throwLifecycleError(error);
		}
	};
	const call = (name: string, input: Record<string, unknown>): unknown =>
		classifySessionAuthorization(() =>
			classifyTaskCreateIdempotency(() =>
				classifyTaskExecutionBounds(() =>
					classifyTaskDependencyCycles(() => classifyLifecycle(() => moduleOperations.get(name)!.execute(input))),
				),
			),
		);
	const define = createOperationDefiner(registry, OWNER, "tasks", ["tasks:read", "tasks:write"], call);
	const mutationInput = (
		input: Record<string, unknown>,
		context: VehicleOperationContext<Record<string, unknown>>,
	): Record<string, unknown> => ({
		...input,
		idempotency_key: input.idempotency_key ?? context.idempotencyKey,
		idempotency_caller: context.principal?.id ?? "anonymous",
	});

	const resolveProject = (reference: string) => {
		try {
			return tasks.resolveProject(reference);
		} catch (error) {
			if (error instanceof TaskProjectNotFoundError) {
				throw new VehicleError("task-project-not-found", error.message, { category: "not_found" });
			}
			if (error instanceof TaskProjectAmbiguousError) {
				throw new VehicleError("task-project-ambiguous", error.message, { category: "conflict" });
			}
			throw error;
		}
	};

	/** Shared by every action taking a single id/name: resolves root_task_name first, then name -> id against the final scope. */
	const resolveIdAndScope = (input: Record<string, unknown>): Record<string, unknown> => {
		const projectRoot = input.project_root as string | undefined;
		const rootTaskId = resolveRootTaskId(artifacts, tasks, projectRoot, input.root_task_id, input.root_task_name);
		const scope = input.scope as TaskViewMode | undefined;
		const filter = { projectRoot, scope, rootTaskId };
		return {
			...input,
			...(rootTaskId ? { root_task_id: rootTaskId } : {}),
			id: resolveTaskId(artifacts, tasks, filter, input.id, input.name),
		};
	};

	define(
		"create",
		'Creates a Task -- work: desired outcomes, gates, checklists, and dependencies. Gates are {type, target, expect?, timeoutMs?}; for example [{type: "command", target: "bun run typecheck", timeoutMs: 60000}]. Checklist criteria are {proof: [{type, target, expect?}]}. project_root is required (no ambient cwd server-side). Prefer parent_name/depends_on_names over parent_id/depends_on -- resolved server-side.',
		"local-write",
		{
			title: stringProp,
			body: stringProp,
			status: stringProp,
			labels: arrayProp,
			extra: objectProp,
			gates: gateProp,
			checklist: checklistProp,
			template_id: stringProp,
			parent_id: stringProp,
			parent_name: stringProp,
			depends_on: arrayProp,
			depends_on_names: arrayProp,
			project_root: stringProp,
			idempotency_key: {
				type: "string",
				minLength: 1,
				maxLength: TASK_CREATE_IDEMPOTENCY_KEY_MAX_LENGTH,
				description:
					"Optional retry key, scoped by caller and canonical project root. Reusing it with the same payload returns the original response; a different payload is rejected.",
			},
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
						? resolveTaskId(artifacts, tasks, filter, undefined, input.parent_name)
						: undefined;
			const dependsOn = resolveArrayField(artifacts, tasks, filter, input.depends_on, input.depends_on_names);
			return { ...input, ...(parentId ? { parent_id: parentId } : {}), ...(dependsOn ? { depends_on: dependsOn } : {}) };
		},
		(input, context) =>
			call("tasks.create", {
				...input,
				idempotency_key: input.idempotency_key ?? context.idempotencyKey,
				idempotency_caller: context.principal?.id ?? "anonymous",
			}),
	);

	define(
		"update",
		"Recovers an accidentally-terminal task via status=todo + reason (only a task whose status was terminal at its own creation -- not one that reached canceled/rejected through a real, later transition; use tasks.reopen for that), or changes title/body/labels, without rewriting real history. Never touches gates -- use set_gates.",
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
		"Lists Tasks matching an optional status/text/labels filter, scoped to project_root. project_root is required (no ambient cwd server-side). Returns a lean summary (no body/extra) unless full: true is passed.",
		"read",
		listSchemaProps,
		["project_root"],
		(input) => {
			const rootTaskId = resolveRootTaskId(artifacts, tasks, input.project_root as string, input.root_task_id, input.root_task_name);
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
			const rootTaskId = resolveRootTaskId(artifacts, tasks, input.project_root as string, input.root_task_id, input.root_task_name);
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
			const rootTaskId = resolveRootTaskId(artifacts, tasks, input.project_root as string, input.root_task_id, input.root_task_name);
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
		"projects",
		"Lists registered Task project scopes with stable ids, names, aliases, and canonical roots. Use resolve_project before a task operation when the user supplied a human project name.",
		"read",
		{ query: stringProp, limit: numberProp },
		[],
		(input) => input,
	);

	define(
		"resolve_project",
		"Resolves one case-insensitive exact Task project id, name, alias, or canonical root. Fails closed on unknown or ambiguous references and returns the canonical project_root for subsequent task operations.",
		"read",
		{ name: stringProp },
		["name"],
		(input) => input,
		(input) => resolveProject(input.name as string),
	);

	define(
		"register_project",
		"Registers a Task project name and aliases. Pass project to update/rename/move an existing registration while preserving its stable id and old name as an alias.",
		"local-write",
		{ project_root: stringProp, name: stringProp, aliases: arrayProp, project: stringProp },
		["project_root"],
		(input) => input,
		(input) => call("tasks.register_project", input),
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
			const rootTaskId = resolveRootTaskId(artifacts, tasks, input.project_root as string, input.root_task_id, input.root_task_name);
			return { ...input, ...(rootTaskId ? { root_task_id: rootTaskId } : {}) };
		},
	);

	define(
		"assign_project",
		"Reassigns a Task's project_root.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, session_id: stringProp },
		["project_root"],
		(input) => ({
			...input,
			id: resolveTaskId(artifacts, tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name),
		}),
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

	/** Injects the caller's own session claims (never a model-visible input field) onto every focus/pause/unpause/clear_focus call -- see this file's own doc comment. */
	const focusOperation = (
		action: "focus" | "pause" | "unpause" | "clear_focus",
		description: string,
		properties: Record<string, { type: string; enum?: readonly string[] }>,
		required: readonly string[],
		resolve: (input: Record<string, unknown>) => Record<string, unknown>,
	): void => {
		define(action, description, "local-write", properties, required, resolve, (resolvedInput, context) => {
			const claims = context.principal?.claims as { sessionId?: string; sessionSecret?: string } | undefined;
			const operationInput = action === "pause" || action === "unpause" ? mutationInput(resolvedInput, context) : resolvedInput;
			return call(`tasks.${action}`, { ...operationInput, session_id: claims?.sessionId, session_secret: claims?.sessionSecret });
		});
	};

	focusOperation(
		"focus",
		"Sets the active Task Focus (singular per scope) to this Task. Multiple sessions can focus the same task while only one holds its lease.",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({
			...input,
			id: resolveTaskId(artifacts, tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name),
		}),
	);
	focusOperation(
		"pause",
		"Pauses Task Focus. Destination-state idempotent: replaying after success returns changed=false. Reuse idempotency_key after an unknown outcome.",
		{ reason: stringProp, idempotency_key: mutationIdempotencyProp },
		[],
		(input) => input,
	);
	focusOperation(
		"unpause",
		"Resumes paused Task Focus. Destination-state idempotent: replaying after success returns changed=false. Reuse idempotency_key after an unknown outcome.",
		{ idempotency_key: mutationIdempotencyProp },
		[],
		(input) => input,
	);
	focusOperation("clear_focus", "Clears the active Task Focus.", {}, [], (input) => input);

	const transitionOperation = (action: "start" | "submit" | "reject" | "retry" | "cancel" | "reopen", description: string): void =>
		define(
			action,
			`${description} Destination-state idempotent: a replay after success returns changed=false. After an unknown outcome, call tasks.show and mutation_status, then reuse the SAME idempotency_key; never retry with a new key from stale state.`,
			"local-write",
			{
				id: stringProp,
				name: stringProp,
				reason: stringProp,
				session_id: stringProp,
				project_root: stringProp,
				idempotency_key: mutationIdempotencyProp,
			},
			[],
			resolveIdAndScope,
			(input, context) => {
				const result = call(`tasks.${action}`, mutationInput(input, context)) as {
					title: string;
					status: string;
					changed: boolean;
					receiptId?: string;
					replayed?: boolean;
				};
				const text = result.changed
					? `${result.title} transitioned to ${result.status}.`
					: result.replayed
						? `Recovered the prior ${action} receipt for ${result.title}; call tasks.show to confirm its current status before the next action.`
						: `${result.title} was already ${result.status}; replay was a safe no-op.`;
				return { ...result, content: [{ type: "text" as const, text }] };
			},
		);

	transitionOperation("start", "Lifecycle transition: todo -> in-progress.");
	transitionOperation("submit", "Lifecycle transition: in-progress -> review.");
	transitionOperation("reject", "Lifecycle transition: review -> rejected.");
	transitionOperation("retry", "Lifecycle transition: rejected -> in-progress.");
	transitionOperation(
		"cancel",
		"Lifecycle transition to canceled (terminal) from todo/in-progress/review/rejected. Reversible via tasks.reopen if premature.",
	);
	transitionOperation("reopen", "Lifecycle transition: canceled -> todo for work that should resume.");

	define(
		"complete",
		"Runs gates + checklist-proof review, then focuses one deterministic ready successor without claiming effort. Rejects on gate/checklist failure. Reuse the same idempotency_key after an unknown outcome so gates and history are not run twice; inspect mutation_status before choosing a new action. A replay after done is a changed=false no-op.",
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
			idempotency_key: mutationIdempotencyProp,
		},
		[],
		resolveIdAndScope,
		async (input, context) => {
			const result = (await call("tasks.complete", mutationInput(input, context))) as TaskCompletion;
			const dependencyIds = result.blocked.flatMap((entry) => entry.dependencyIds);
			const labels = labelsById(artifacts, dependencyIds);
			return { ...result, content: [{ type: "text" as const, text: completionContentText(labels, result) }] };
		},
		GATE_OPERATION_LIMITS,
	);

	define(
		"mutation_status",
		"Resolves an unknown lifecycle mutation outcome by the original idempotency_key. Read this receipt before selecting another transition; never invent a replacement key for the same attempt.",
		"read",
		{ idempotency_key: mutationIdempotencyProp },
		["idempotency_key"],
		(input) => input,
		(input, context) => call("tasks.mutation_status", mutationInput(input, context)),
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
		GATE_OPERATION_LIMITS,
	);

	define(
		"set_checklist",
		"Replaces a Task's evidence-bearing checklist (proof requirements) in full.",
		"local-write",
		{ id: stringProp, name: stringProp, checklist: checklistProp, project_root: stringProp },
		["checklist"],
		resolveIdAndScope,
	);
	define(
		"set_gates",
		"Replaces a Task's gate commands in full. Each gate is {type, target, expect?, timeoutMs?} -- timeoutMs overrides the default per-type command timeout (30s)/test timeout (60s) for a legitimately slower gate, up to a bounded ceiling.",
		"local-write",
		{ id: stringProp, name: stringProp, gates: gateProp, project_root: stringProp },
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

	/** Resolves a task id/name pair against the filter derived from this same input's own project_root/scope -- shared by depend/undepend and contain/uncontain below. */
	const resolveScopedTaskId = (input: Record<string, unknown>, idProp: string, nameProp: string): string => {
		const filter = { projectRoot: input.project_root as string | undefined, scope: input.scope as TaskViewMode | undefined };
		return resolveTaskId(artifacts, tasks, filter, input[idProp], input[nameProp]);
	};

	definePairedMutation(
		define,
		{ idProp: "id", nameProp: "name" },
		{ idProp: "dependency_id", nameProp: "dependency_name" },
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
		resolveScopedTaskId,
		{
			action: "depend",
			description:
				"Adds a dependency edge (this task waits for dependency_id/dependency_name). Dependency edges form an executable DAG -- self-dependencies and cycles are rejected. A name resolved outside project_root's own scope is retried once against every project before failing, unless scope is pinned explicitly.",
		},
		{ action: "undepend", description: "Removes a dependency edge. Idempotent -- a no-op if the edge is already absent." },
	);

	definePairedMutation(
		define,
		{ idProp: "parent_id", nameProp: "parent_name" },
		{ idProp: "child_id", nameProp: "child_name" },
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
		resolveScopedTaskId,
		{
			action: "contain",
			description:
				"Nests a child Task inside a parent (parent_id/parent_name contains child_id/child_name) -- explicit hierarchy, distinct from depends_on execution ordering. A name resolved outside project_root's own scope is retried once against every project before failing, unless scope is pinned explicitly.",
		},
		{ action: "uncontain", description: "Removes a parent/child nesting. Idempotent -- a no-op if the edge is already absent." },
	);

	define(
		"claim",
		"Claims this Task's lease under owner (defaults to session_id). Prefer name over id. Returns taskName (the reusable artifact alias) and taskTitle instead of exposing its backend UUID. Throws if a different owner already holds one.",
		"local-write",
		{
			name: stringProp,
			id: stringProp,
			owner: stringProp,
			ttl_ms: numberProp,
			note: stringProp,
			project_root: stringProp,
			session_id: stringProp,
		},
		[],
		(input) => ({
			...input,
			id: resolveTaskId(artifacts, tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name),
			owner: input.owner ?? input.session_id,
		}),
	);
	define(
		"heartbeat_lease",
		"Extends this Task's lease -- needs the exact owner/token claim() returned. Prefer name over id. Returns the reusable taskName plus taskTitle.",
		"local-write",
		{
			name: stringProp,
			id: stringProp,
			owner: stringProp,
			token: stringProp,
			ttl_ms: numberProp,
			project_root: stringProp,
			session_id: stringProp,
		},
		["owner", "token"],
		(input) => ({
			...input,
			id: resolveTaskId(artifacts, tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name),
		}),
	);
	define(
		"release_lease",
		"Releases this Task's lease -- needs the exact owner/token claim() returned. Prefer name over id.",
		"local-write",
		{ name: stringProp, id: stringProp, owner: stringProp, token: stringProp, project_root: stringProp, session_id: stringProp },
		["owner", "token"],
		(input) => ({
			...input,
			id: resolveTaskId(artifacts, tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name),
		}),
	);
	define(
		"lease",
		"Shows this Task's current lease, if any. Prefer name over id. The result is identified by reusable taskName plus taskTitle rather than its backend UUID.",
		"read",
		{ name: stringProp, id: stringProp, project_root: stringProp },
		[],
		(input) => ({
			...input,
			id: resolveTaskId(artifacts, tasks, { projectRoot: input.project_root as string | undefined }, input.id, input.name),
		}),
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
