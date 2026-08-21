/**
 * modules/tasks.ts — Tasks as the second Papyrus-native registered module
 * (step 5, continued, of the incremental refactor in
 * reducing-papyrus-consumer-change-amplification-with-modules--pvdo).
 *
 * Deliberately more representative than modules/notes.ts: Tasks owns real schema
 * (task_events, task_focus, task_scopes and their migrations, still in src/db.ts for
 * this slice — module-owned migrations are a separate follow-up,
 * add-a-module-migration-ledger-keyed-by-moduleid-version-with-3e7k), a much larger
 * operation surface, and cross-module edges (rules.gate links a rule to a task;
 * graph.link routes depends_on through Tasks.depend for cycle safety — those two
 * remain in src/service.ts since they are graph.* / rules.* operations, not tasks.*).
 *
 * Task-domain-internal files (task-context.ts, task-execution.ts, domain/task-event.ts,
 * domain/task-scope.ts) are imported directly — they belong to this bounded context,
 * unlike a different module's infrastructure. Generic input-parsing helpers come from
 * ./operation-input.ts, a peer utility at this same modules/ layer with no domain logic
 * of its own -- not "another module's infrastructure" or the composition root's helpers,
 * the actual thing this module avoids importing.
 */

import { summarizeArtifact } from "../artifact/artifact.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { SessionIdentity } from "../session-identity/session-identity-service.ts";
import type { Checklist } from "../task/checklist.ts";
import type { TaskEventContext, TaskEventDirection, TaskEventFeedQuery } from "../task/event/task-event.ts";
import type { TaskViewMode } from "../task/scope/task-scope.ts";
import { taskContext } from "../task/task-context.ts";
import { projectTaskExecution } from "../task/task-execution.ts";
import type { TaskMutationRequestContext, TaskStatus, Tasks } from "../task/task-service.ts";
import { type OperationInput, optionalBoolean, optionalNumber, optionalString, optionalStringArray, string } from "./operation-input.ts";

const MODULE_ID = "tasks";

const eventContext = (input: OperationInput): TaskEventContext => ({
	actor: optionalString(input, "actor"),
	source: optionalString(input, "source"),
	sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
	reason: optionalString(input, "reason"),
});

const mutationRequest = (input: OperationInput): TaskMutationRequestContext => ({
	key: optionalString(input, "idempotency_key"),
	caller: optionalString(input, "idempotency_caller"),
});

const taskFilter = (input: OperationInput) => ({
	status: optionalString(input, "status"),
	text: optionalString(input, "text"),
	limit: optionalNumber(input, "limit"),
	projectRoot: string(input, "project_root"),
	scope: optionalString(input, "scope") as TaskViewMode | undefined,
	rootTaskId: optionalString(input, "root_task_id"),
	sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
	labels: optionalStringArray(input, "labels"),
	cursor: optionalString(input, "cursor"),
});

/**
 * Registers every tasks.* operation against one Tasks instance. Behavior is unchanged from
 * the prior inline handlers in src/service.ts. tasks.context needs the raw ArtifactStore
 * port directly (taskContext is a plain-artifact query, not a Tasks method), so the
 * composition root passes the same artifacts port it already constructs Tasks with —
 * this is not "another module's infrastructure", it is the shared port every module writes
 * through.
 */
/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const TASKS_OPERATION_NAMES = [
	"tasks.create",
	"tasks.update",
	"tasks.list",
	"tasks.list_page",
	"tasks.graph",
	"tasks.plan",
	"tasks.show",
	"tasks.history",
	"tasks.projects",
	"tasks.resolve_project",
	"tasks.register_project",
	"tasks.scope",
	"tasks.set_scope",
	"tasks.assign_project",
	"tasks.active",
	"tasks.focused",
	"tasks.focus",
	"tasks.pause",
	"tasks.unpause",
	"tasks.clear_focus",
	"tasks.start",
	"tasks.submit",
	"tasks.complete",
	"tasks.mutation_status",
	"tasks.run_gates",
	"tasks.set_checklist",
	"tasks.set_gates",
	"tasks.context",
	"tasks.reject",
	"tasks.retry",
	"tasks.cancel",
	"tasks.reopen",
	"tasks.cancel_subtree",
	"tasks.depend",
	"tasks.undepend",
	"tasks.contain",
	"tasks.uncontain",
	"tasks.reap_stale_focus",
	"tasks.claim",
	"tasks.heartbeat_lease",
	"tasks.release_lease",
	"tasks.lease",
	"tasks.reap_stale_leases",
	"tasks.event_feed",
] as const;

export function tasksOperations(tasks: Tasks, artifacts: ArtifactStore, sessionIdentity: SessionIdentity): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	// Enforced only for the operations where session_id is BEHAVIOR-affecting (it selects
	// which Task Focus row is mutated), not for every session_id-carrying operation -- see
	// domain/session-identity.ts. A session_id with no registered identity passes through
	// unchanged (opt-in armor).
	const guardFocusMutation = (input: OperationInput): void => {
		sessionIdentity.assertAuthorized(eventContext(input).sessionId, optionalString(input, "session_secret"));
	};
	return [
		define("tasks.create", (input: OperationInput) =>
			tasks.create(
				{
					title: string(input, "title"),
					body: optionalString(input, "body"),
					status: optionalString(input, "status") as TaskStatus | undefined,
					labels: input.labels as string[] | undefined,
					extra: input.extra as Record<string, unknown> | undefined,
					gates: input.gates as Parameters<Tasks["create"]>[0]["gates"],
					checklist: input.checklist as Checklist | undefined,
					templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
					parentId: optionalString(input, "parent_id") ?? optionalString(input, "parentId"),
					dependsOn: (input.depends_on ?? input.dependsOn) as string[] | undefined,
					projectRoot: string(input, "project_root"),
					projectSource: "cwd",
				},
				eventContext(input),
				{
					key: optionalString(input, "idempotency_key"),
					caller: optionalString(input, "idempotency_caller"),
				},
			),
		),
		define("tasks.update", (input: OperationInput) =>
			tasks.update(
				string(input, "id"),
				{
					...(input.title !== undefined ? { title: optionalString(input, "title")! } : {}),
					...(input.body !== undefined ? { body: optionalString(input, "body")! } : {}),
					...(input.labels !== undefined ? { labels: optionalStringArray(input, "labels")! } : {}),
					...(input.status !== undefined ? { status: string(input, "status") as "todo" } : {}),
				},
				eventContext(input),
			),
		),
		define("tasks.list", (input: OperationInput) => {
			const rows = tasks.list(taskFilter(input));
			return optionalBoolean(input, "full") === true ? rows : rows.map(summarizeArtifact);
		}),
		define("tasks.list_page", (input: OperationInput) => {
			const page = tasks.listPage(taskFilter(input));
			return {
				...page,
				items: optionalBoolean(input, "full") === true ? page.items : page.items.map(summarizeArtifact),
			};
		}),
		define("tasks.graph", (input: OperationInput) => tasks.graph(taskFilter(input))),
		define("tasks.plan", (input: OperationInput) => projectTaskExecution(tasks.graph(taskFilter(input)))),
		define("tasks.show", (input: OperationInput) => tasks.show(string(input, "id"))),
		define("tasks.history", (input: OperationInput) =>
			tasks.history(string(input, "id"), {
				limit: optionalNumber(input, "limit"),
				cursor: optionalNumber(input, "cursor"),
				direction: optionalString(input, "direction") as TaskEventDirection | undefined,
			}),
		),
		define("tasks.projects", (input: OperationInput) => tasks.projects(optionalString(input, "query"), optionalNumber(input, "limit"))),
		define("tasks.resolve_project", (input: OperationInput) => tasks.resolveProject(string(input, "name"))),
		define("tasks.register_project", (input: OperationInput) =>
			tasks.registerProject(
				{
					projectRoot: string(input, "project_root"),
					name: optionalString(input, "name"),
					aliases: optionalStringArray(input, "aliases"),
				},
				optionalString(input, "project"),
			),
		),
		define("tasks.scope", (input: OperationInput) => tasks.scopeSelection(string(input, "project_root"))),
		define("tasks.set_scope", (input: OperationInput) =>
			tasks.setView(string(input, "project_root"), string(input, "scope") as TaskViewMode, optionalString(input, "root_task_id")),
		),
		define("tasks.assign_project", (input: OperationInput) =>
			tasks.assignProject(string(input, "id"), string(input, "project_root"), eventContext(input)),
		),
		define("tasks.active", (input: OperationInput) => tasks.active(taskFilter(input))),
		define("tasks.focused", (input: OperationInput) => tasks.focused(taskFilter(input))),
		define("tasks.focus", (input: OperationInput) => {
			guardFocusMutation(input);
			return tasks.focus(string(input, "id"), eventContext(input));
		}),
		define("tasks.pause", (input: OperationInput) => {
			guardFocusMutation(input);
			return tasks.pauseFocus(eventContext(input), mutationRequest(input));
		}),
		define("tasks.unpause", (input: OperationInput) => {
			guardFocusMutation(input);
			return tasks.unpauseFocus(eventContext(input), mutationRequest(input));
		}),
		define("tasks.clear_focus", (input: OperationInput) => {
			guardFocusMutation(input);
			return tasks.clearFocus(eventContext(input));
		}),
		define("tasks.reap_stale_focus", () => ({ removed: tasks.reapStaleFocus() })),
		define("tasks.start", (input: OperationInput) =>
			tasks.transition(string(input, "id"), "start", eventContext(input), mutationRequest(input)),
		),
		define("tasks.submit", (input: OperationInput) =>
			tasks.transition(string(input, "id"), "submit", eventContext(input), mutationRequest(input)),
		),
		define("tasks.complete", (input: OperationInput) =>
			tasks.completeAsync(string(input, "id"), eventContext(input), {}, mutationRequest(input)),
		),
		define("tasks.mutation_status", (input: OperationInput) =>
			tasks.mutationStatus(string(input, "idempotency_key"), optionalString(input, "idempotency_caller")),
		),
		define("tasks.run_gates", (input: OperationInput) => tasks.runGates(string(input, "id"), eventContext(input))),
		define("tasks.set_checklist", (input: OperationInput) => tasks.setChecklist(string(input, "id"), input.checklist as Checklist)),
		define("tasks.set_gates", (input: OperationInput) =>
			tasks.setGates(string(input, "id"), input.gates as Parameters<Tasks["setGates"]>[1]),
		),
		define("tasks.context", (input: OperationInput) =>
			taskContext(
				artifacts,
				tasks.active(taskFilter(input))?.id,
				new Set(tasks.list(taskFilter(input)).map((task) => task.id)),
				optionalString(input, "verbosity") === "summary" ? "summary" : "full",
			),
		),
		define("tasks.reject", (input: OperationInput) =>
			tasks.transition(string(input, "id"), "reject", eventContext(input), mutationRequest(input)),
		),
		define("tasks.retry", (input: OperationInput) =>
			tasks.transition(string(input, "id"), "retry", eventContext(input), mutationRequest(input)),
		),
		define("tasks.cancel", (input: OperationInput) =>
			tasks.transition(string(input, "id"), "cancel", eventContext(input), mutationRequest(input)),
		),
		define("tasks.reopen", (input: OperationInput) =>
			tasks.transition(string(input, "id"), "reopen", eventContext(input), mutationRequest(input)),
		),
		define("tasks.cancel_subtree", (input: OperationInput) => tasks.cancelSubtree(string(input, "id"), eventContext(input))),
		define("tasks.depend", (input: OperationInput) =>
			tasks.depend(string(input, "id"), string(input, "dependency_id"), eventContext(input)),
		),
		define("tasks.undepend", (input: OperationInput) =>
			tasks.undepend(string(input, "id"), string(input, "dependency_id"), eventContext(input)),
		),
		define("tasks.contain", (input: OperationInput) =>
			tasks.contain(string(input, "parent_id"), string(input, "child_id"), eventContext(input)),
		),
		define("tasks.uncontain", (input: OperationInput) =>
			tasks.uncontain(string(input, "parent_id"), string(input, "child_id"), eventContext(input)),
		),
		define("tasks.claim", (input: OperationInput) =>
			tasks.claimLease(string(input, "id"), string(input, "owner"), optionalNumber(input, "ttl_ms"), optionalString(input, "note")),
		),
		define("tasks.heartbeat_lease", (input: OperationInput) =>
			tasks.heartbeatLease(string(input, "id"), string(input, "owner"), string(input, "token"), optionalNumber(input, "ttl_ms")),
		),
		define("tasks.release_lease", (input: OperationInput) =>
			tasks.releaseLease(string(input, "id"), string(input, "owner"), string(input, "token")),
		),
		define("tasks.lease", (input: OperationInput) => tasks.getLease(string(input, "id")) ?? null),
		define("tasks.reap_stale_leases", () => ({ removed: tasks.reapStaleLeases() })),
		define("tasks.event_feed", (input: OperationInput) =>
			tasks.eventFeed({
				cursor: optionalNumber(input, "cursor"),
				limit: optionalNumber(input, "limit"),
				eventTypes: optionalStringArray(input, "event_types") as TaskEventFeedQuery["eventTypes"],
			}),
		),
	];
}
